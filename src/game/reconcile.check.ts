/*
 * Проверка сведения машины игрока с сервером: `npm run reconcheck`.
 *
 * Машина игрока едет по локальному предсказанию, а сервер десять раз в секунду
 * присылает своё мнение. Предсказание с ним никогда не совпадает точно — шаги
 * интегрирования разные, ввод уходит реже кадров, пакеты идут с задержкой.
 * Здесь это всё подделано, включая заведомо неидеальный сервер, и меряется то,
 * что видит игрок: насколько ровно машина идёт от кадра к кадру.
 *
 * Главная величина — рывок: изменение скорости за кадр. Рывки на частоте
 * снапшотов и есть «дёрганое движение».
 */
import { PredictionSmoother } from "./reconcile.ts";
import { ACC, BRAKE, MAX_SPEED } from "./car.ts";

const FRAME = 1 / 60;
const SNAPSHOT_RATE = 10;
const INPUT_RATE = 30;
const DURATION = 20;
const WARMUP = 1;

interface Car {
  x: number;
  y: number;
  angle: number;
  speed: number;
}

interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
}

/** Упрощённая физика кузова — та же формула, что в движке. */
function step(car: Car, input: Input, dt: number, accScale: number): void {
  if (input.up) car.speed += ACC * accScale * dt;
  if (input.down) car.speed -= BRAKE * dt;
  if (!input.up && !input.down) {
    const s = car.speed;
    car.speed = s - Math.sign(s) * Math.min(Math.abs(s), (55 + Math.abs(s) * 0.85) * dt);
  }
  car.speed = Math.max(-215, Math.min(car.speed, MAX_SPEED));
  const dir = (input.left ? -1 : 0) + (input.right ? 1 : 0);
  const sp = Math.abs(car.speed);
  const grip = Math.min(sp / 150, 1) * (1 - 0.42 * (sp / MAX_SPEED));
  car.angle += dir * 3.1 * grip * dt;
  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
}

/** Что жмёт игрок: разгон, повороты, торможение — по кругу. */
function inputAt(t: number): Input {
  const phase = t % 8;
  return {
    up: phase < 5.5,
    down: phase >= 6.5 && phase < 7.2,
    left: phase >= 2 && phase < 3.4,
    right: phase >= 4.2 && phase < 5.4,
  };
}

interface Mode {
  label: string;
  /** во сколько раз разгон на сервере отличается от клиентского */
  accScale: number;
  /** шаг интегрирования на сервере */
  serverStep: number;
  latency: number;
  jitter: number;
}

/** Способ сведения. Возвращает поправку, которую внёс в этом кадре. */
type Fix = (
  dt: number,
  car: Car,
  error: { x: number; y: number; angle: number; speed: number }
) => { dx: number; dy: number; dSpeed: number };

interface Result {
  worstJerk: number;
  meanJerk: number;
  drift: number;
}

/**
 * Гоняет заезд и меряет картинку. `applyFix` — способ сведения: старая
 * экспонента или новый сглаженный корректор.
 */
function race(mode: Mode, applyFix: Fix, resetFix: () => void): Result {
  resetFix();
  const client: Car = { x: 1000, y: 1000, angle: 0, speed: 0 };
  const server: Car = { ...client };
  const error = { x: 0, y: 0, angle: 0, speed: 0 };

  let seed = 7;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const inbox: Array<{ at: number; car: Car }> = [];
  const commands: Array<{ at: number; input: Input }> = [];
  let serverInput: Input = { up: false, down: false, left: false, right: false };
  let sendInputAt = 0;
  let sendSnapAt = 0;
  let serverAcc = 0;

  // Меряем ровно то, что netcode подмешивает в движение: скорость поправки и
  // поправку к скорости машины. Собственный разгон, торможение и повороты сюда
  // не попадают вовсе — а значит, любое ненулевое число здесь глаз видит как
  // рывок. Скорость поправки берём вектором: так замер не зависит от того,
  // куда в этот момент повёрнута машина.
  let prevVx = 0;
  let prevVy = 0;
  let prevDSpeed = 0;
  let worstJerk = 0;
  let meanJerk = 0;
  let jerks = 0;
  let drift = 0;
  let driftSamples = 0;

  for (let t = 0; t < DURATION; t += FRAME) {
    const input = inputAt(t);

    // клиент отправляет ввод 30 раз в секунду, он летит до сервера
    if (t >= sendInputAt) {
      commands.push({ at: t + mode.latency / 2 + rnd() * mode.jitter, input });
      sendInputAt = t + 1 / INPUT_RATE;
    }

    // сервер крутит свою физику своим шагом и своим разгоном
    serverAcc += FRAME;
    while (serverAcc >= mode.serverStep) {
      for (let i = commands.length - 1; i >= 0; i--) {
        if (commands[i].at <= t) {
          serverInput = commands[i].input;
          commands.splice(0, i + 1);
          break;
        }
      }
      step(server, serverInput, mode.serverStep, mode.accScale);
      serverAcc -= mode.serverStep;
    }

    // раз в 1/10 секунды сервер шлёт снимок, он тоже летит
    if (t >= sendSnapAt) {
      inbox.push({ at: t + mode.latency / 2 + rnd() * mode.jitter, car: { ...server } });
      sendSnapAt = t + 1 / SNAPSHOT_RATE;
    }
    while (inbox.length && inbox[0].at <= t) {
      const packet = inbox.shift()!;
      // как в движке: серверное состояние продлеваем на задержку вперёд
      const lead = mode.latency;
      const ax = packet.car.x + Math.cos(packet.car.angle) * packet.car.speed * lead;
      const ay = packet.car.y + Math.sin(packet.car.angle) * packet.car.speed * lead;
      error.x = ax - client.x;
      error.y = ay - client.y;
      error.angle = packet.car.angle - client.angle;
      error.speed = packet.car.speed - client.speed;
    }

    step(client, input, FRAME, 1);
    const fix = applyFix(FRAME, client, error);

    const vx = fix.dx / FRAME;
    const vy = fix.dy / FRAME;
    if (t > WARMUP) {
      const jerk =
        Math.hypot(vx - prevVx, vy - prevVy) + Math.abs(fix.dSpeed - prevDSpeed);
      worstJerk = Math.max(worstJerk, jerk);
      meanJerk += jerk;
      jerks++;
      drift += Math.hypot(client.x - server.x, client.y - server.y);
      driftSamples++;
    }
    prevVx = vx;
    prevVy = vy;
    prevDSpeed = fix.dSpeed;
  }

  return {
    worstJerk,
    meanJerk: jerks ? meanJerk / jerks : 0,
    drift: driftSamples ? drift / driftSamples : 0,
  };
}

/** как было: экспонента, 11% остатка в первый же кадр после пакета */
const RECONCILE_RATE = 7;
const oldFix: Fix = (dt, car, e) => {
  const k = 1 - Math.exp(-RECONCILE_RATE * dt);
  const dx = e.x * k;
  const dy = e.y * k;
  const dSpeed = e.speed * k;
  car.x += dx;
  car.y += dy;
  car.angle += e.angle * k;
  car.speed += dSpeed;
  e.x -= dx;
  e.y -= dy;
  e.angle -= e.angle * k;
  e.speed -= dSpeed;
  return { dx, dy, dSpeed };
};

const smoother = new PredictionSmoother();
let armed = false;
const newFix: Fix = (dt, car, e) => {
  if (e.x || e.y || e.angle || e.speed) {
    smoother.set(e.x, e.y, e.angle, e.speed);
    e.x = e.y = e.angle = e.speed = 0;
    armed = true;
  }
  if (!armed) return { dx: 0, dy: 0, dSpeed: 0 };
  const fix = smoother.advance(dt, Math.abs(car.speed));
  car.x += fix.dx;
  car.y += fix.dy;
  car.angle += fix.dAngle;
  car.speed += fix.dSpeed;
  return fix;
};

const MODES: Mode[] = [
  { label: "сервер как клиент, 60 мс", accScale: 1, serverStep: FRAME, latency: 0.06, jitter: 0 },
  { label: "шаг сервера 1/20 с", accScale: 1, serverStep: 1 / 20, latency: 0.08, jitter: 0.02 },
  { label: "разгон сервера 0.92", accScale: 0.92, serverStep: FRAME, latency: 0.08, jitter: 0.02 },
  { label: "шаг 1/20 + разгон 0.92", accScale: 0.92, serverStep: 1 / 20, latency: 0.12, jitter: 0.04 },
  { label: "мобильная: 200 мс, джиттер", accScale: 0.95, serverStep: 1 / 20, latency: 0.2, jitter: 0.08 },
];

// Порог: вклад сети в изменение скорости за кадр. Собственный разгон машины
// уже вычтен, так что всё, что здесь остаётся, глаз видит как рывок.
const JERK_LIMIT = 15;

let failures = 0;
console.log(
  "Рывок — насколько сведение с сервером меняет скорость машины от кадра к кадру, px/с.\n" +
    "Собственная езда сюда не входит: 0 — движение идеально ровное, всё остальное видно глазом.\n"
);
console.log(`${"режим".padEnd(30)}${"было".padStart(28)}${"стало".padStart(28)}${"расхождение".padStart(16)}`);
for (const mode of MODES) {
  const before = race(mode, oldFix, () => {});
  const after = race(mode, newFix, () => {
    smoother.reset();
    armed = false;
  });
  const cell = (r: Result) =>
    `худший ${r.worstJerk.toFixed(0).padStart(4)}  средний ${r.meanJerk.toFixed(1).padStart(5)}`;
  console.log(
    mode.label.padEnd(30) +
      cell(before).padStart(28) +
      cell(after).padStart(28) +
      `${after.drift.toFixed(0)} px`.padStart(16)
  );
  if (after.worstJerk > JERK_LIMIT) {
    failures++;
    console.log(`  ПРОВАЛ: ${mode.label}: рывок ${after.worstJerk.toFixed(0)} px/с за кадр`);
  }
  if (after.worstJerk > before.worstJerk) {
    failures++;
    console.log(`  ПРОВАЛ: ${mode.label}: стало хуже, чем было`);
  }
  // Клиент и должен идти впереди сервера — примерно на путь, который машина
  // проезжает, пока ввод летит до сервера. Ловим только явно сломанное.
  const expected = 640 * mode.latency + 60;
  if (after.drift > expected) {
    failures++;
    console.log(
      `  ПРОВАЛ: ${mode.label}: разошлись с сервером на ${after.drift.toFixed(0)} px ` +
        `при допустимых ${expected.toFixed(0)}`
    );
  }
}


// Отдельно — то, что игрок называет телепортом: сервер разом переставляет
// машину (отскок после тарана, парковка под колонкой, отклонённое
// перемещение). Такую поправку корректор обязан провезти, а не прыгнуть.
console.log("\nРазовая поправка от сервера: машина должна подъехать, а не прыгнуть");
for (const jump of [80, 200, 400]) {
  const sm = new PredictionSmoother();
  sm.set(jump, 0, 0, 0);
  let worstStep = 0;
  let seconds = 0;
  for (let i = 0; i < 60 * 6; i++) {
    const fix = sm.advance(FRAME, 500);
    worstStep = Math.max(worstStep, Math.hypot(fix.dx, fix.dy));
    seconds += FRAME;
    if (sm.pending < 1) break;
  }
  console.log(
    `  поправка ${String(jump).padStart(3)} px:  ` +
      `худший кадр ${worstStep.toFixed(1)} px,  свелась за ${seconds.toFixed(2)} с`
  );
  // 4 px за кадр — это 240 px/с, вровень с обычной ездой: заметно, но это
  // именно движение, а не подмена картинки.
  if (worstStep > 4) {
    failures++;
    console.log(`  ПРОВАЛ: поправка ${jump} px прыгнула на ${worstStep.toFixed(1)} px за кадр`);
  }
  if (seconds > 4) {
    failures++;
    console.log(`  ПРОВАЛ: поправка ${jump} px сводилась ${seconds.toFixed(1)} с — слишком долго`);
  }
}

if (failures > 0) throw new Error(`Провалено проверок: ${failures}`);
console.log("\nOK: машина игрока идёт ровно, поправки без прыжков, от сервера не отстаёт");
