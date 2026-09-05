import { ACC, BRAKE, MAX_SPEED, grip } from "./car";
import { CONFIG } from "./config";
import { CANISTER_R, ROAD, WORLD } from "./world";
import type { Canister, City, Station } from "./world";

/* Боты-конкуренты: катаются по решётке улиц, забирают канистры и заправляются.
   Алгоритм каждого выбирается случайно и равновероятно из двух:
   1) "station" — еду к ближайшей активной АЗС, по пути подбираю канистру;
   2) "canister" — еду к ближайшей канистре, потом к ближайшей активной АЗС,
      но если по пути к канистре попалась активная АЗС — заправляюсь на ней.
   Поверх плана бот иногда бросает дела и идёт на таран машины игрока. */

export const BOT_COLORS = [
  "#3f8cff",
  "#f2a93b",
  "#8b5cf6",
  "#22c3a6",
  "#ff7ab8",
  "#c9d64b",
  "#ff8b3d",
  "#4dd2ff",
  "#b07d4f",
  "#9aa7bd",
];

export const BOT_NAMES = [
  "__Вихрь",
  "__Полночь",
  "__Форсаж",
  "__Клаксон",
  "__Дизель",
  "__Гроза",
  "__Фара",
  "__Турбина",
  "__Шумахер",
  "__Ночник",
];

export type BotPlan = "station" | "canister";

type Goal =
  | { kind: "station"; x: number; y: number; st: Station }
  | { kind: "canister"; x: number; y: number; k: Canister }
  | { kind: "base"; x: number; y: number }
  | { kind: "player"; x: number; y: number }
  | { kind: "wander"; x: number; y: number };

export interface Bot {
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  name: string;
  fuel: number;
  tankVolume: number;
  money: number;
  status: "active" | "lost";
  /** сколько литров конкурент залил за текущий заезд */
  filledLiters: number;
  plan: BotPlan;
  goal: Goal | null;
  gotCanister: boolean;
  refuelled: boolean;
  wait: number;
  refuelTotal: number;
  refuelTargetLiters: number;
  refuelLiters: number;
  refuelSpent: number;
  at: Station | null;
  respawnRemaining: number;
  think: number;
  taken: number;
  kx: number;
  ky: number;
  stun: number;
  style: number;
  lane: number;
  wob: number;
  lazy: number;
  lazyCd: number;
  aggro: number;
  aggroCd: number;
}

/** Что бот сделал на этом кадре — движку нужно для эффектов и экономики АЗС. */
export interface BotStep {
  took: { x: number; y: number } | null;
  refuelAt: Station | null;
  soldAt: { x: number; y: number } | null;
  filledLiters: number;
  lost: boolean;
  respawn: boolean;
}

const BOT_R = 15;
const LANE_EPS = 60;
const FINAL_DIST = 190;
const DETOUR = 260;
const SELL_S = 2;
const SELL_FROM = 2;
const THINK_S = 0.25;
const AGGRO_RANGE = 1300;
const AGGRO_CHANCE = 0.14;
const AGGRO_PAUSE = 14;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function nearestLane(city: City, v: number): number {
  let best = city.roadCenters[0];
  for (const c of city.roadCenters) if (Math.abs(c - v) < Math.abs(best - v)) best = c;
  return best;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

const stationGoal = (st: Station): Goal => ({
  kind: "station",
  x: st.x + st.w / 2,
  y: st.y + st.h / 2,
  st,
});
const canisterGoal = (k: Canister): Goal => ({ kind: "canister", x: k.x, y: k.y, k });

function activeStations(city: City): Station[] {
  return city.stations.filter((s) => s.state === "active");
}
function freeCanisters(city: City): Canister[] {
  return city.canisters.filter((k) => !k.taken);
}
function nearestOf<T extends { x: number; y: number }>(b: Bot, list: readonly T[]): T | null {
  let best: T | null = null;
  let bd = Infinity;
  for (const it of list) {
    const d = Math.hypot(it.x - b.x, it.y - b.y);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
}

function rollPlan(b: Bot): void {
  b.plan = Math.random() < 0.5 ? "station" : "canister";
  b.gotCanister = false;
  b.refuelled = false;
  b.goal = null;
  b.think = 0;
}

function wanderGoal(city: City): Goal {
  const rc = city.roadCenters;
  return {
    kind: "wander",
    x: rc[Math.floor(Math.random() * rc.length)],
    y: rc[Math.floor(Math.random() * rc.length)],
  };
}

function chooseGoal(b: Bot, city: City): Goal {
  const stations = activeStations(city);
  const cans = freeCanisters(city);

  if (b.taken >= SELL_FROM) {
    return { kind: "base", x: city.base.x + city.base.w / 2, y: city.base.y + city.base.h / 2 };
  }

  if (b.plan === "station" || b.gotCanister) {
    const st = nearestOf(b, stations.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s })));
    if (!st) {
      const k = nearestOf(b, cans);
      return k ? canisterGoal(k) : wanderGoal(city);
    }
    if (b.plan === "station") {
      const onWay = cans
        .filter((k) => distToSegment(k.x, k.y, b.x, b.y, st.x, st.y) < DETOUR)
        .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y))[0];
      if (onWay) return canisterGoal(onWay);
    }
    return stationGoal(st.st);
  }

  const k = nearestOf(b, cans);
  if (!k) {
    const st = nearestOf(b, stations.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s })));
    return st ? stationGoal(st.st) : wanderGoal(city);
  }
  if (!b.refuelled) {
    const onWay = stations
      .map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, st: s }))
      .filter((s) => distToSegment(s.x, s.y, b.x, b.y, k.x, k.y) < DETOUR)
      .sort((p, q) => Math.hypot(p.x - b.x, p.y - b.y) - Math.hypot(q.x - b.x, q.y - b.y))[0];
    if (onWay) return stationGoal(onWay.st);
  }
  return canisterGoal(k);
}

function goalStale(g: Goal): boolean {
  if (g.kind === "canister") return g.k.taken;
  if (g.kind === "station") return g.st.state !== "active";
  return false;
}

function waypoint(b: Bot, city: City, gx: number, gy: number): { x: number; y: number } {
  if (Math.hypot(gx - b.x, gy - b.y) < FINAL_DIST) return { x: gx, y: gy };
  const colX = nearestLane(city, gx);
  const rowY = nearestLane(city, gy);
  if (Math.abs(b.x - colX) < LANE_EPS) return { x: colX, y: gy };
  if (Math.abs(b.y - rowY) < LANE_EPS) return { x: gx, y: rowY };

  const myCol = nearestLane(city, b.x);
  const myRow = nearestLane(city, b.y);
  const onCol = Math.abs(b.x - myCol) < LANE_EPS;
  const onRow = Math.abs(b.y - myRow) < LANE_EPS;
  if (onCol && onRow) {
    return Math.abs(gx - b.x) > Math.abs(gy - b.y) ? { x: colX, y: myRow } : { x: myCol, y: rowY };
  }
  if (onRow) return { x: colX, y: myRow };
  if (onCol) return { x: myCol, y: rowY };
  return Math.abs(b.x - myCol) < Math.abs(b.y - myRow) ? { x: myCol, y: b.y } : { x: b.x, y: myRow };
}

function applyKnock(b: Bot, dt: number): void {
  if (b.kx === 0 && b.ky === 0) return;
  b.x = clamp(b.x + b.kx * dt, 30, WORLD - 30);
  b.y = clamp(b.y + b.ky * dt, 30, WORLD - 30);
  const decay = Math.exp(-3.4 * dt);
  b.kx *= decay;
  b.ky *= decay;
  if (Math.hypot(b.kx, b.ky) < 4) {
    b.kx = 0;
    b.ky = 0;
  }
}

function drive(b: Bot, wx: number, wy: number, dt: number): void {
  const dx = wx - b.x;
  const dy = wy - b.y;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const off = b.lane + Math.sin(b.wob) * 7;
  const want = Math.atan2(wy + py * off - b.y, wx + px * off - b.x);

  let d = want - b.angle;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const maxTurn = 3.1 * Math.max(grip(b.speed), 0.32);
  b.angle += Math.sign(d) * Math.min(Math.abs(d), maxTurn * dt);

  const ad = Math.abs(d);
  let target = MAX_SPEED * b.style;
  target = Math.min(target, len * 2.4 + 120);
  if (ad > 0.8) target = Math.min(target, MAX_SPEED * 0.26);
  else if (ad > 0.35) target = Math.min(target, MAX_SPEED * 0.55);
  if (b.lazy > 0) target *= 0.55;
  b.speed = b.speed < target ? Math.min(target, b.speed + ACC * dt) : Math.max(target, b.speed - BRAKE * dt);

  b.x = clamp(b.x + Math.cos(b.angle) * b.speed * dt, 30, WORLD - 30);
  b.y = clamp(b.y + Math.sin(b.angle) * b.speed * dt, 30, WORLD - 30);
}

function updateMood(b: Bot, dt: number, player: { x: number; y: number }): void {
  b.wob += dt * (0.7 + b.style);
  if (b.lazy > 0) b.lazy -= dt;
  else {
    b.lazyCd -= dt;
    if (b.lazyCd <= 0) {
      b.lazy = Math.random() < 0.45 ? 0.35 + Math.random() * 1.1 : 0;
      b.lazyCd = 2.5 + Math.random() * 4.5;
    }
  }

  if (b.aggro > 0) {
    b.aggro -= dt;
    if (b.aggro <= 0) b.aggroCd = AGGRO_PAUSE + Math.random() * 12;
    return;
  }
  b.aggroCd -= dt;
  if (b.aggroCd > 0) return;
  const d = Math.hypot(player.x - b.x, player.y - b.y);
  if (d < AGGRO_RANGE && Math.random() < AGGRO_CHANCE * dt) {
    b.aggro = 3.5 + Math.random() * 3.5;
    b.goal = null;
    b.think = 0;
  }
}

function spawnPoint(city: City, start: { x: number; y: number }, occupied: readonly { x: number; y: number }[]) {
  let x = start.x;
  let y = start.y;
  let vertical = true;
  for (let tries = 0; tries < 120; tries++) {
    vertical = Math.random() < 0.5;
    const lane = city.roadCenters[Math.floor(Math.random() * city.roadCenters.length)];
    const along = ROAD + Math.random() * (WORLD - ROAD * 2);
    x = vertical ? lane : along;
    y = vertical ? along : lane;
    const farFromPlayer = Math.hypot(x - start.x, y - start.y) > 700;
    const farFromCars = occupied.every((other) => Math.hypot(other.x - x, other.y - y) > 320);
    if (farFromPlayer && farFromCars) break;
  }
  const angle = vertical ? (Math.random() < 0.5 ? -Math.PI / 2 : Math.PI / 2) : Math.random() < 0.5 ? 0 : Math.PI;
  return { x, y, angle };
}

export function createBot(
  city: City,
  index: number,
  start: { x: number; y: number },
  occupied: readonly { x: number; y: number }[]
): Bot {
  const spawn = spawnPoint(city, start, occupied);
  const bot: Bot = {
    ...spawn,
    speed: 0,
    color: BOT_COLORS[index % BOT_COLORS.length],
    name: BOT_NAMES[index % BOT_NAMES.length],
    fuel: Math.min(CONFIG.startFuel, CONFIG.startTankVolume),
    tankVolume: CONFIG.startTankVolume,
    money: CONFIG.startMoney,
    status: "active",
    filledLiters: 0,
    plan: "station",
    goal: null,
    gotCanister: false,
    refuelled: false,
    wait: 0,
    refuelTotal: 0,
    refuelTargetLiters: 0,
    refuelLiters: 0,
    refuelSpent: 0,
    at: null,
    respawnRemaining: 0,
    think: 0,
    taken: 0,
    kx: 0,
    ky: 0,
    stun: 0,
    style: 0.82 + Math.random() * 0.18,
    lane: (Math.random() < 0.5 ? -1 : 1) * (18 + Math.random() * 26),
    wob: Math.random() * Math.PI * 2,
    lazy: 0,
    lazyCd: Math.random() * 4,
    aggro: 0,
    aggroCd: 4 + Math.random() * 14,
  };
  rollPlan(bot);
  return bot;
}

export function createBots(city: City, count: number, start: { x: number; y: number }): Bot[] {
  const bots: Bot[] = [];
  for (let index = 0; index < count; index++) bots.push(createBot(city, index, start, bots));
  return bots;
}

function burnFuel(b: Bot, dt: number, accelerating: boolean): boolean {
  const speedRatio = Math.abs(b.speed) / MAX_SPEED;
  const burn = CONFIG.fuelBurnPerSecond * (0.09 + (accelerating ? 0.42 + speedRatio * 0.49 : 0));
  b.fuel = Math.max(0, b.fuel - burn * dt);
  if (b.fuel > 0) return false;
  b.status = "lost";
  b.speed = 0;
  b.wait = 0;
  b.at = null;
  b.refuelTotal = 0;
  b.refuelTargetLiters = 0;
  b.refuelLiters = 0;
  b.refuelSpent = 0;
  b.respawnRemaining = CONFIG.botRespawnDelay;
  b.goal = null;
  return true;
}

function updateWait(b: Bot, dt: number): number {
  let filled = 0;
  if (b.at) {
    const elapsed = Math.min(dt, b.wait);
    const nextWait = Math.max(0, b.wait - elapsed);
    const nextElapsed = b.refuelTotal - nextWait;
    const desired =
      b.refuelTotal <= 0 ? b.refuelTargetLiters : b.refuelTargetLiters * (nextElapsed / b.refuelTotal);
    const amount = Math.max(0, Math.min(b.refuelTargetLiters - b.refuelLiters, desired - b.refuelLiters));
    const before = b.fuel;
    b.fuel = Math.min(b.tankVolume, b.fuel + amount);
    filled = b.fuel - before;
    const paid = filled * b.at.price;
    b.money = Math.max(0, b.money - paid);
    b.filledLiters += filled;
    b.refuelLiters += filled;
    b.refuelSpent += paid;
  }

  b.wait = Math.max(0, b.wait - dt);
  b.speed *= Math.max(0, 1 - 6 * dt);
  if (b.wait <= 0) {
    b.at = null;
    b.refuelTotal = 0;
    b.refuelTargetLiters = 0;
    b.refuelLiters = 0;
    b.refuelSpent = 0;
  } else if (!b.at) {
    burnFuel(b, dt, false);
  }
  return filled;
}

function startRefuelling(b: Bot, station: Station, refuelSeconds: number): number {
  const room = Math.max(0, b.tankVolume - b.fuel);
  const allowance = station.limit === null ? Infinity : Math.max(0, station.limit);
  const affordable = station.price > 0 ? b.money / station.price : Infinity;
  const targetLiters = Math.max(0, Math.min(room, allowance, affordable));
  b.refuelled = true;
  b.goal = null;
  b.think = 0;
  if (targetLiters <= 0.0005) return 0;

  b.wait = Math.max(0, refuelSeconds);
  b.refuelTotal = b.wait;
  b.refuelTargetLiters = targetLiters;
  b.refuelLiters = 0;
  b.refuelSpent = 0;
  b.at = station;
  if (b.wait > 0) return 0;

  const before = b.fuel;
  b.fuel = Math.min(b.tankVolume, b.fuel + targetLiters);
  const filled = b.fuel - before;
  const paid = filled * station.price;
  b.money = Math.max(0, b.money - paid);
  b.filledLiters += filled;
  b.refuelLiters = filled;
  b.refuelSpent = paid;
  b.at = null;
  b.refuelTargetLiters = 0;
  return filled;
}

export function stepBot(
  b: Bot,
  city: City,
  dt: number,
  player: { x: number; y: number },
  refuelSeconds: number
): BotStep {
  const step: BotStep = {
    took: null,
    refuelAt: null,
    soldAt: null,
    filledLiters: 0,
    lost: false,
    respawn: false,
  };

  if (b.status !== "active") {
    b.respawnRemaining = Math.max(0, b.respawnRemaining - dt);
    step.respawn = b.respawnRemaining <= 0;
    return step;
  }

  applyKnock(b, dt);
  if (b.stun > 0) {
    b.stun -= dt;
    b.speed *= Math.max(0, 1 - 4 * dt);
    b.think = 0;
    step.lost = burnFuel(b, dt, false);
    return step;
  }
  if (b.wait > 0) {
    step.filledLiters = updateWait(b, dt);
    step.lost = b.fuel <= 0;
    return step;
  }

  updateMood(b, dt, player);

  if (b.aggro > 0) {
    b.goal = { kind: "player", x: player.x, y: player.y };
  } else {
    b.think -= dt;
    if (!b.goal || b.goal.kind === "player" || b.think <= 0 || goalStale(b.goal)) {
      b.goal = chooseGoal(b, city);
      b.think = THINK_S * (0.7 + Math.random() * 0.6);
    }
  }
  const g = b.goal;
  const wp = waypoint(b, city, g.x, g.y);
  drive(b, wp.x, wp.y, dt);
  if (burnFuel(b, dt, b.lazy <= 0)) {
    step.lost = true;
    return step;
  }

  const rr = (BOT_R + CANISTER_R) * (BOT_R + CANISTER_R);
  for (const k of city.canisters) {
    if (k.taken || k.cool > 0) continue;
    const dx = b.x - k.x;
    const dy = b.y - k.y;
    if (dx * dx + dy * dy > rr) continue;
    k.taken = true;
    b.gotCanister = true;
    b.taken += 1;
    b.tankVolume += CONFIG.canisterTankBonus;
    b.think = 0;
    step.took = { x: k.x, y: k.y };
  }

  if (g.kind === "base") {
    const base = city.base;
    if (b.x > base.x - 6 && b.x < base.x + base.w + 6 && b.y > base.y - 6 && b.y < base.y + base.h + 6) {
      const sold = b.fuel / 2;
      b.fuel -= sold;
      b.money += Math.round(sold * CONFIG.fuelSellPrice);
      b.wait = SELL_S;
      b.taken = 0;
      b.tankVolume = CONFIG.startTankVolume;
      b.fuel = Math.min(b.fuel, b.tankVolume);
      b.gotCanister = false;
      b.goal = null;
      b.think = 0;
      step.soldAt = { x: b.x, y: b.y };
    }
  } else if (g.kind === "station") {
    const s = g.st;
    if (s.state === "active" && b.x > s.x - 6 && b.x < s.x + s.w + 6 && b.y > s.y - 6 && b.y < s.y + s.h + 6) {
      step.filledLiters += startRefuelling(b, s, refuelSeconds);
      if (b.refuelTargetLiters > 0 || step.filledLiters > 0) step.refuelAt = s;
    }
  } else if (g.kind === "wander" && Math.hypot(g.x - b.x, g.y - b.y) < 60) {
    b.goal = null;
    b.think = 0;
  }

  if (b.refuelled && (b.plan === "station" || b.gotCanister)) rollPlan(b);
  return step;
}
