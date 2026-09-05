/*
 * Сведение предсказанной машины игрока с тем, что говорит сервер.
 *
 * Машина игрока считается локально каждый кадр, иначе между пакетами она стояла
 * бы. Сервер время от времени присылает своё мнение, и оно почти никогда не
 * совпадает с предсказанием: пакеты идут десять раз в секунду, ввод уходит
 * тридцать, шаги интегрирования у сервера и клиента разные. Расхождение само по
 * себе небольшое и болтается около нуля — но важно, как его применять.
 *
 * Гасить расхождение экспонентой («каждый кадр убираем 11% остатка») нельзя:
 * самая большая доля приходится на первый кадр после пакета, и машина получает
 * толчок на каждом снапшоте — те самые рывки десять раз в секунду. Глаз
 * замечает не саму поправку, а резкую смену скорости.
 *
 * Поэтому у поправки есть собственная скорость, и меняется она плавно. Машина
 * не прыгает к серверной точке, а подъезжает к ней: скорость поправки
 * ограничена долей от скорости самой машины, так что коррекция всегда выглядит
 * как лёгкий снос, а не как телепорт.
 */

/** Поправка к состоянию машины за один кадр. */
export interface Correction {
  dx: number;
  dy: number;
  dAngle: number;
  dSpeed: number;
}

const SMOOTH_TIME = 0.25; // за сколько секунд хотим убрать расхождение
const AGILITY = 10; // как быстро сама скорость поправки выходит на нужную, 1/с
const BUDGET_RATIO = 0.3; // потолок скорости поправки — доля от скорости машины
const BUDGET_MIN = 80; // но не меньше этого, иначе стоящая машина не догонит, px/с
const TURN_BUDGET = 1.6; // потолок скорости доворота, рад/с
// Главный предохранитель от рывка: сама скорость поправки не может измениться
// быстрее этого. Именно резкую смену скорости глаз и видит как толчок, поэтому
// потолок стоит здесь, а не на величине поправки.
const CORR_ACC = 220; // px/с²
const TURN_ACC = 6; // рад/с²
const SPEED_ACC = 260; // с каким ускорением подтягиваем скорость, px/с²
const SPEED_JERK = 900; // и насколько быстро само это ускорение меняется, px/с³
const DONE_POS = 0.05; // остаток меньше — считаем, что сошлись
const DONE_VEL = 1;
const DONE_ANGLE = 0.0005;
const DONE_SPEED = 0.4;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Подводит `value` к `target`: сперва мягко, экспонентой, но так, чтобы за кадр
 * значение не изменилось больше, чем на `limit`. Второе и даёт жёсткую границу
 * рывка, первое — чтобы подход к цели не выглядел механическим.
 */
function approach(value: number, target: number, ease: number, limit: number): number {
  const eased = value + (target - value) * ease;
  return clamp(eased, value - limit, value + limit);
}

export class PredictionSmoother {
  // оставшееся расхождение с сервером
  private ex = 0;
  private ey = 0;
  private eAngle = 0;
  private eSpeed = 0;
  // текущая скорость, с которой это расхождение выбирается
  private vx = 0;
  private vy = 0;
  private vAngle = 0;
  private aSpeed = 0;

  reset(): void {
    this.ex = 0;
    this.ey = 0;
    this.eAngle = 0;
    this.eSpeed = 0;
    this.vx = 0;
    this.vy = 0;
    this.vAngle = 0;
    this.aSpeed = 0;
  }

  /** Новое мнение сервера: столько ещё надо добрать до его состояния. */
  set(dx: number, dy: number, dAngle: number, dSpeed: number): void {
    this.ex = dx;
    this.ey = dy;
    this.eAngle = dAngle;
    this.eSpeed = dSpeed;
  }

  /** сколько ещё не сведено — по расстоянию, px */
  get pending(): number {
    return Math.hypot(this.ex, this.ey);
  }

  get idle(): boolean {
    return (
      !this.ex &&
      !this.ey &&
      !this.eAngle &&
      !this.eSpeed &&
      !this.vx &&
      !this.vy &&
      !this.vAngle &&
      !this.aSpeed
    );
  }

  /**
   * Выбирает часть расхождения за кадр. `carSpeed` — модуль скорости машины: от
   * него зависит, насколько бодро разрешено подтягивать положение. `urgent`
   * снимает потолок вдвое — нужно сразу после тарана, когда сервер меняет
   * состояние машины резче, чем это можно предсказать.
   */
  advance(dt: number, carSpeed: number, urgent = false): Correction {
    if (this.idle) return { dx: 0, dy: 0, dAngle: 0, dSpeed: 0 };

    const budget = Math.max(BUDGET_MIN, carSpeed * BUDGET_RATIO) * (urgent ? 2 : 1);
    // куда хотим разогнать поправку, чтобы убрать остаток за SMOOTH_TIME
    let tx = this.ex / SMOOTH_TIME;
    let ty = this.ey / SMOOTH_TIME;
    const want = Math.hypot(tx, ty);
    if (want > budget) {
      tx = (tx / want) * budget;
      ty = (ty / want) * budget;
    }

    // Сглаживаем именно скорость поправки, и меняем её не быстрее CORR_ACC:
    // за счёт этого положение остаётся гладким, а приход пакета не даёт толчка.
    // Через цель немного перелетаем — это дешевле, чем обрубать скорость в ноль
    // на последнем кадре, что как раз читается как рывок.
    const ease = 1 - Math.exp(-AGILITY * dt);
    const limit = CORR_ACC * dt;
    this.vx = approach(this.vx, tx, ease, limit);
    this.vy = approach(this.vy, ty, ease, limit);
    const dx = this.vx * dt;
    const dy = this.vy * dt;
    this.ex -= dx;
    this.ey -= dy;

    const turnWant = clamp(this.eAngle / SMOOTH_TIME, -TURN_BUDGET, TURN_BUDGET);
    this.vAngle = approach(this.vAngle, turnWant, ease, TURN_ACC * dt);
    const dAngle = this.vAngle * dt;
    this.eAngle -= dAngle;

    // Скорость идёт и в доводку камеры, и в звук мотора, поэтому подтягиваем её
    // тоже через ускорение с ограниченной скоростью изменения — иначе поправка
    // хлопает от плюса к минусу на каждом пакете.
    const speedWant = clamp(this.eSpeed / SMOOTH_TIME, -SPEED_ACC, SPEED_ACC);
    this.aSpeed = approach(this.aSpeed, speedWant, ease, SPEED_JERK * dt);
    const dSpeed = this.aSpeed * dt;
    this.eSpeed -= dSpeed;

    if (Math.abs(this.ex) < DONE_POS && Math.abs(this.vx) < DONE_VEL) {
      this.ex = 0;
      this.vx = 0;
    }
    if (Math.abs(this.ey) < DONE_POS && Math.abs(this.vy) < DONE_VEL) {
      this.ey = 0;
      this.vy = 0;
    }
    if (Math.abs(this.eAngle) < DONE_ANGLE) {
      this.eAngle = 0;
      this.vAngle = 0;
    }
    if (Math.abs(this.eSpeed) < DONE_SPEED && Math.abs(this.aSpeed) < 2) {
      this.eSpeed = 0;
      this.aSpeed = 0;
    }

    return { dx, dy, dAngle, dSpeed };
  }
}
