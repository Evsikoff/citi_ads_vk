/*
 * Проверка сетевой шкалы на смоделированном трафике: `npm run netcheck`.
 *
 * Дёрганое движение чужих машин в онлайне ломалось уже дважды, а вручную это
 * ловится плохо — нужен живой сервер и плохая связь. Здесь и то и другое
 * подделано: машина едет по известной траектории, снапшоты уходят с задержкой,
 * джиттером и потерями, а мы смотрим на результат глазами игрока — насколько
 * ровно идёт картинка от кадра к кадру.
 *
 * Зависимостей нет: Node запускает TypeScript сам.
 */
import { SnapshotTimeline, angleDelta, pushSample, sampleTimeline } from "./netclock.ts";
import type { RemoteSample } from "./netclock.ts";

const TICK_RATE = 60;
const SNAPSHOT_RATE = 10;
const SPEED = 200; // пикс/с
const FRAME = 1 / 60;
const DURATION = 25; // секунд
const WARMUP = 1.5; // первые секунды буфер только набирается

/** воспроизводимый генератор: прогон должен давать один и тот же результат */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

interface Net {
  label: string;
  latency: number;
  jitter: number;
  loss: number;
}

interface Truth {
  x: number;
  y: number;
  angle: number;
  speed: number;
}

interface Report {
  label: string;
  meanSpeed: number;
  worstJump: number;
  worstTurn: number;
  stalls: number;
  backwards: number;
  delay: number;
}

/**
 * Гоняет один режим сети и меряет картинку. `path` — где машина на самом деле
 * в этот момент времени, `teleportAt` — момент респавна, после которого прыжок
 * через полкарты ожидаем и рывком не считается.
 */
function run(net: Net, path: (t: number) => Truth, teleportAt = -1): Report {
  const rnd = random(20260830);
  const timeline = new SnapshotTimeline();
  timeline.configure(TICK_RATE, SNAPSHOT_RATE);
  const buffer: RemoteSample[] = [];

  // Сервер шлёт кадры равномерно, но долетает каждый со своей задержкой —
  // порядок прихода при этом нарушается, как и в настоящей сети.
  const step = 1 / SNAPSHOT_RATE;
  const packets: Array<{ tick: number; truth: Truth; arrivesAt: number }> = [];
  for (let n = 0; n * step < DURATION; n++) {
    if (rnd() < net.loss) continue;
    const sent = n * step;
    packets.push({
      tick: Math.round(sent * TICK_RATE),
      truth: path(sent),
      arrivesAt: sent + net.latency + rnd() * net.jitter,
    });
  }
  packets.sort((a, b) => a.arrivesAt - b.arrivesAt);

  let next = 0;
  let previous: RemoteSample | null = null;
  let meanSpeed = 0;
  let samples = 0;
  let worstJump = 0;
  let worstTurn = 0;
  let stalls = 0;
  let backwards = 0;

  for (let t = 0; t < DURATION; t += FRAME) {
    while (next < packets.length && packets[next].arrivesAt <= t) {
      const packet = packets[next++];
      const stamp = timeline.stamp(packet.tick, t);
      if (stamp.restarted) buffer.length = 0;
      else if (stamp.shift !== 0) for (const sample of buffer) sample.t += stamp.shift;
      pushSample(buffer, { t: stamp.t, ...packet.truth }, 260, 24);
    }

    const at = sampleTimeline(buffer, timeline.advance(FRAME, t));
    if (!at) continue;
    const measuring = t > WARMUP && Math.abs(t - teleportAt) > 1;
    if (previous && measuring) {
      const moved = Math.hypot(at.x - previous.x, at.y - previous.y) / FRAME;
      const forward = Math.cos(previous.angle) * (at.x - previous.x) +
        Math.sin(previous.angle) * (at.y - previous.y);
      meanSpeed += moved;
      samples++;
      worstJump = Math.max(worstJump, Math.abs(moved - SPEED));
      worstTurn = Math.max(worstTurn, Math.abs(angleDelta(at.angle, previous.angle)) / FRAME);
      if (moved < SPEED * 0.02) stalls++;
      if (forward < -0.5) backwards++;
    }
    previous = at;
  }

  return {
    label: net.label,
    meanSpeed: samples ? meanSpeed / samples : 0,
    worstJump,
    worstTurn,
    stalls,
    backwards,
    delay: timeline.delay,
  };
}

const NETWORKS: Net[] = [
  { label: "идеальная сеть", latency: 0.03, jitter: 0, loss: 0 },
  { label: "джиттер 40 мс", latency: 0.05, jitter: 0.04, loss: 0 },
  { label: "джиттер 120 мс", latency: 0.08, jitter: 0.12, loss: 0 },
  { label: "джиттер 120 мс, 5% потерь", latency: 0.08, jitter: 0.12, loss: 0.05 },
  { label: "мобильная: 200/150 мс, 10%", latency: 0.2, jitter: 0.15, loss: 0.1 },
];

const straight = (t: number): Truth => ({ x: 400 + t * SPEED, y: 500, angle: 0, speed: SPEED });

// круг радиусом 320 пикселей: проверяет и склейку углов через ±π
const RADIUS = 320;
const circle = (t: number): Truth => {
  const a = (t * SPEED) / RADIUS;
  return {
    x: 1200 + Math.cos(a) * RADIUS,
    y: 1200 + Math.sin(a) * RADIUS,
    angle: a + Math.PI / 2,
    speed: SPEED,
  };
};

// на 12-й секунде машина гибнет и появляется в другом конце карты
const TELEPORT = 12;
const respawn = (t: number): Truth =>
  t < TELEPORT ? straight(t) : { ...straight(t), x: 4200 + (t - TELEPORT) * SPEED, y: 3100 };

let failures = 0;
const check = (ok: boolean, message: string) => {
  if (!ok) {
    failures++;
    console.log(`  ПРОВАЛ: ${message}`);
  }
};

const show = (r: Report) =>
  `${r.label.padEnd(28)} скорость ${r.meanSpeed.toFixed(1).padStart(6)} пикс/с  ` +
  `худший скачок ${r.worstJump.toFixed(0).padStart(4)}  замираний ${String(r.stalls).padStart(3)}  ` +
  `назад ${String(r.backwards).padStart(3)}  задержка ${(r.delay * 1000).toFixed(0)} мс`;

console.log("Прямая: машина едет ровно, ожидаем 200 пикс/с без замираний и движения назад");
for (const net of NETWORKS) {
  const r = run(net, straight);
  console.log(" ", show(r));
  check(Math.abs(r.meanSpeed - SPEED) < 12, `${net.label}: средняя скорость ${r.meanSpeed.toFixed(1)}`);
  check(r.worstJump < SPEED * 3, `${net.label}: скачок на ${r.worstJump.toFixed(0)} пикс/с`);
  check(r.backwards === 0, `${net.label}: ${r.backwards} кадров машина ехала назад`);
  check(r.stalls <= 2, `${net.label}: ${r.stalls} кадров машина стояла`);
}

console.log("\nПоворот: угол должен идти плавно и не прыгать через ±π");
for (const net of NETWORKS) {
  const r = run(net, circle);
  console.log(" ", show(r) + `  худший поворот ${r.worstTurn.toFixed(2)} рад/с`);
  check(r.backwards === 0, `${net.label} (круг): ${r.backwards} кадров машина ехала назад`);
  // на круге радиусом 320 честная угловая скорость — 0.63 рад/с
  check(r.worstTurn < 4, `${net.label} (круг): рывок поворота ${r.worstTurn.toFixed(2)} рад/с`);
}

console.log("\nРеспавн: телепорт через карту не должен растягиваться в проезд насквозь");
for (const net of NETWORKS) {
  const r = run(net, respawn, TELEPORT);
  console.log(" ", show(r));
  check(
    Math.abs(r.meanSpeed - SPEED) < 12,
    `${net.label} (респавн): средняя скорость ${r.meanSpeed.toFixed(1)}`
  );
  check(r.backwards === 0, `${net.label} (респавн): ${r.backwards} кадров машина ехала назад`);
}

if (failures > 0) throw new Error(`Провалено проверок: ${failures}`);
console.log("\nOK: движение ровное во всех режимах");
