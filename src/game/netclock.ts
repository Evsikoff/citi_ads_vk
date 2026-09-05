/*
 * Сетевые часы и буфер интерполяции для онлайна.
 *
 * Сервер присылает положение машин пачками, десяток раз в секунду и с разной
 * задержкой. Если рисовать «последнее, что пришло», машина стоит между
 * пакетами и прыгает на каждом — то самое дёрганое движение. Поэтому кадры
 * складываются на общую временную шкалу, а отрисовка идёт с небольшим
 * отставанием: в каждый момент есть два уже полученных кадра, между которыми
 * положение считается линейно.
 *
 * Шкалу строим по серверному тику: он монотонный, идёт с постоянным шагом и не
 * зависит ни от часов клиента, ни от того, когда пакет доехал. Сдвиг между
 * шкалой тиков и локальными часами берём как минимальную задержку за последние
 * секунды — тогда джиттер виден как «кадр пришёл позже своего времени», а не
 * как рывок.
 *
 * Отдельно от этого идут часы отрисовки. Считать их как «сейчас минус запас»
 * нельзя: запас пересчитывается на каждом пакете, и каждое его изменение
 * телепортировало бы точку отрисовки — машина дёргалась бы уже от самой
 * подстройки. Поэтому часы отрисовки идут вперёд сами и лишь чуть ускоряются
 * или замедляются, догоняя нужное отставание.
 */

/** Одно серверное состояние машины, поставленное на временную шкалу. */
export interface RemoteSample {
  /** момент локальных часов, которому соответствует кадр */
  t: number;
  x: number;
  y: number;
  angle: number;
  speed: number;
  /** угловая скорость, посчитанная по предыдущему кадру, рад/с */
  turn?: number;
}

/** Что вернула шкала на очередном снапшоте. */
export interface Stamp {
  /** время кадра на локальных часах */
  t: number;
  /** на столько уехала вся шкала — на это же надо сдвинуть уже накопленные кадры */
  shift: number;
  /** сервер начал счёт заново: накопленные кадры больше ни о чём не говорят */
  restarted: boolean;
}

const DELAY_MIN = 0.08; // на столько отрисовка отстаёт от сети как минимум, с
const DELAY_MAX = 0.6;
const DELAY_MARGIN = 1.25; // во сколько интервалов между кадрами укладываем запас
const JITTER_MARGIN = 1.4; // и с каким запасом перекрываем разброс задержек
const EXTRAPOLATE_S = 0.4; // сколько продлеваем движение, когда кадры кончились
const EXTRAPOLATE_FREE = 0.15; // из них продлеваем один в один, без сглаживания
const OFFSET_WINDOW = 5; // за сколько секунд ищем самый быстрый пакет
const JITTER_DECAY = 0.999; // как быстро забывается прошлый разброс задержек
const CATCHUP = 0.6; // насколько бодро часы отрисовки догоняют нужное отставание
// Отпустить часы назад дешевле, чем разогнать: при нехватке кадров машина иначе
// упрётся в край буфера, а лишнюю сотую долю замедления никто не заметит.
const CATCHUP_SLOW = 0.25;
const CATCHUP_FAST = 0.08;
const RESYNC = 0.5; // разрыв больше — догонять нечего, переставляем часы
const RESTART_GAP = 2; // на столько секунд назад тик уходит только при перезапуске
const TURN_MAX = 4; // потолок оценки угловой скорости, рад/с

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** кратчайший поворот от одного угла к другому, в диапазоне (-π, π] */
export function angleDelta(to: number, from: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class SnapshotTimeline {
  private tickRate = 0;
  private snapshotRate = 0;
  private synced = false;
  private offset = 0;
  private jitter = 0;
  // Скользящий минимум задержки на двух корзинах: минимум по текущему окну и по
  // прошлому. Так оценка не залипает навсегда на одном удачном пакете и при
  // этом не сползает к средней задержке, как сползало бы простое сглаживание.
  private windowStart = 0;
  private windowMin = Infinity;
  private windowMinPrev = Infinity;
  private tickInterval = 0; // измеренный шаг между кадрами, с
  private lastTick = -1;
  private staleTicks = 0;
  private renderTime = 0;
  private renderInit = false;

  /** частоты из приветствия сервера */
  configure(tickRate: number, snapshotRate: number): void {
    this.tickRate = tickRate > 0 ? tickRate : 0;
    this.snapshotRate = snapshotRate > 0 ? snapshotRate : 0;
    this.reset();
  }

  reset(): void {
    this.synced = false;
    this.offset = 0;
    this.jitter = 0;
    this.windowStart = 0;
    this.windowMin = Infinity;
    this.windowMinPrev = Infinity;
    this.tickInterval = 0;
    this.lastTick = -1;
    this.staleTicks = 0;
    this.renderInit = false;
  }

  /**
   * На сколько отрисовка отстаёт от сети. Запас должен перекрыть интервал между
   * кадрами (иначе интерполировать будет не между чем) и разброс их прихода
   * (иначе буфер будет пустеть на каждом опоздавшем пакете).
   */
  get delay(): number {
    const interval =
      this.snapshotRate > 0
        ? 1 / this.snapshotRate
        : this.tickInterval > 0
          ? this.tickInterval
          : 0.1;
    return clamp(
      interval * DELAY_MARGIN + this.jitter * JITTER_MARGIN,
      DELAY_MIN,
      DELAY_MAX
    );
  }

  /**
   * Двигает часы отрисовки на кадр вперёд и возвращает момент, который сейчас
   * надо показать. Часы всегда идут только вперёд и почти со скоростью реального
   * времени: нужное отставание набирается за доли секунды и незаметно.
   */
  advance(dt: number, now: number): number {
    const target = now - this.delay;
    if (!this.renderInit) {
      this.renderTime = target;
      this.renderInit = true;
      return this.renderTime;
    }
    const drift = target - this.renderTime;
    if (Math.abs(drift) > RESYNC) {
      // вкладку сворачивали, связь пропадала — догонять нечего
      this.renderTime = target;
      return this.renderTime;
    }
    const rate = clamp(1 + drift * CATCHUP, 1 - CATCHUP_SLOW, 1 + CATCHUP_FAST);
    this.renderTime += dt * rate;
    return this.renderTime;
  }

  /** Ставит очередной снапшот на шкалу. `arrival` — локальные часы, секунды. */
  stamp(tick: number, arrival: number): Stamp {
    if (!this.tickRate || typeof tick !== "number" || !Number.isFinite(tick)) {
      // сервер не сообщил частоту тиков — играем по времени получения пакетов
      this.synced = true;
      this.offset = 0;
      return { t: arrival, shift: 0, restarted: false };
    }

    let restarted = false;
    if (tick > this.lastTick) {
      if (this.lastTick >= 0) {
        // Затухающий минимум: потерянный пакет удваивает разрыв между тиками,
        // поэтому по среднему шаг не оценить — нужен именно минимум.
        const step = (tick - this.lastTick) / this.tickRate;
        this.tickInterval =
          this.tickInterval > 0 ? Math.min(step, this.tickInterval * 1.02) : step;
      }
      this.staleTicks = 0;
      this.lastTick = tick;
    } else if ((this.lastTick - tick) / this.tickRate > RESTART_GAP) {
      // сервер перезапустил счёт тиков — старая шкала больше ни о чём не говорит
      this.reset();
      restarted = true;
      this.lastTick = tick;
    } else if (tick === this.lastTick && ++this.staleTicks >= 3) {
      // тик стоит на месте — шкалы из него не выйдет
      this.tickRate = 0;
      this.reset();
      this.synced = true;
      return { t: arrival, shift: 0, restarted: false };
    }
    // Пакет пришёл с опозданием и оказался старее уже полученных — это обычное
    // дело в сети, и это не повод сбрасывать шкалу. Место на ней он всё равно
    // занимает своё, а буфер сам отбросит кадр, который уже не нужен.

    const serverSeconds = tick / this.tickRate;
    const raw = arrival - serverSeconds;
    const wasSynced = this.synced;
    const previous = this.offset;

    if (!this.synced) {
      this.windowStart = arrival;
      this.windowMin = raw;
      this.windowMinPrev = raw;
      this.synced = true;
    } else {
      if (arrival - this.windowStart >= OFFSET_WINDOW) {
        this.windowMinPrev = this.windowMin;
        this.windowMin = Infinity;
        this.windowStart = arrival;
      }
      this.windowMin = Math.min(this.windowMin, raw);
    }
    this.offset = Math.min(this.windowMin, this.windowMinPrev);
    // затухающий максимум опоздания — запас, который должен покрыть буфер
    this.jitter = Math.max(raw - this.offset, this.jitter * JITTER_DECAY);

    return {
      t: serverSeconds + this.offset,
      shift: wasSynced ? this.offset - previous : 0,
      restarted,
    };
  }
}

/**
 * Кладёт кадр в буфер. Кадры не новее последнего отбрасываются, слишком далёкий
 * прыжок (респавн, новая карта) очищает историю: интерполировать между «было» и
 * «стало» там нечего. Возвращает true, если история была сброшена.
 */
export function pushSample(
  buffer: RemoteSample[],
  sample: RemoteSample,
  snapDistance: number,
  limit: number
): boolean {
  const last = buffer[buffer.length - 1];
  let snapped = false;
  if (last && Math.hypot(sample.x - last.x, sample.y - last.y) > snapDistance) {
    buffer.length = 0;
    snapped = true;
  }
  const tail = buffer[buffer.length - 1];
  if (!tail || sample.t > tail.t) {
    // Запоминаем, с какой скоростью машина поворачивала: если кадры кончатся,
    // продлевать придётся не только положение, но и разворот кузова — иначе
    // машина едет боком, а потом доворачивает рывком.
    const span = tail ? sample.t - tail.t : 0;
    sample.turn =
      span > 0 ? clamp(angleDelta(sample.angle, tail.angle) / span, -TURN_MAX, TURN_MAX) : 0;
    buffer.push(sample);
    if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
  }
  return snapped;
}

/**
 * Положение на момент `render`: между двумя серверными кадрами оно считается
 * линейно, угол — по кратчайшей дуге. Если кадры кончились, движение ненадолго
 * продлевается по последней скорости и плавно упирается в потолок, поэтому
 * машина замирает без рывка. Отработанные кадры из буфера выбрасываются.
 */
export function sampleTimeline(buffer: RemoteSample[], render: number): RemoteSample | null {
  if (buffer.length === 0) return null;

  // всё, что уже целиком в прошлом, кроме одного опорного кадра, не нужно
  while (buffer.length > 1 && buffer[1].t <= render) buffer.shift();

  const from = buffer[0];
  const to = buffer[1];
  if (render <= from.t || !to) {
    // Короткий разрыв продлеваем один в один — иначе машина теряет часть пути и
    // потом наверстает её рывком. Дальше движение плавно упирается в потолок и
    // замирает без скачка: без данных дорисовывать всё равно нечего.
    const raw = Math.max(0, render - from.t);
    const tail = EXTRAPOLATE_S - EXTRAPOLATE_FREE;
    const ahead =
      raw <= EXTRAPOLATE_FREE
        ? raw
        : EXTRAPOLATE_FREE + tail * (1 - Math.exp(-(raw - EXTRAPOLATE_FREE) / tail));
    // Едем по дуге, а не по касательной: на повороте прямая быстро уводит
    // машину с дороги, и возврат на неё виден как рывок.
    const turn = from.turn ?? 0;
    const angle = from.angle + turn * ahead;
    const mid = from.angle + (turn * ahead) / 2;
    return {
      t: render,
      x: from.x + Math.cos(mid) * from.speed * ahead,
      y: from.y + Math.sin(mid) * from.speed * ahead,
      angle,
      speed: from.speed,
    };
  }

  const span = to.t - from.t;
  const u = span > 0 ? clamp((render - from.t) / span, 0, 1) : 1;
  return {
    t: render,
    x: from.x + (to.x - from.x) * u,
    y: from.y + (to.y - from.y) * u,
    angle: from.angle + angleDelta(to.angle, from.angle) * u,
    speed: from.speed + (to.speed - from.speed) * u,
  };
}
