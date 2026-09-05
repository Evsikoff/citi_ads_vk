import type { Client } from "./clients";
import { CONFIG } from "./config";

/* ------- константы мира (в пикселях мировых координат) ------- */
export const BLOCK = 860; // размер квартала
export const ROAD = 170; // ширина дороги
export const GRID = 10; // 10×10 кварталов — вчетверо больше площади, чем 5×5
export const WORLD = GRID * BLOCK + (GRID + 1) * ROAD; // 5320
export const SIDEWALK = 26; // тротуар по краю квартала
const BUILD_INSET = 96; // здания не ближе этой границы (место под билборды)
const STATION_PAD = 160; // размер площадки АЗС
const STATIONS = 20; // АЗС на карту — вчетверо больше, чем было на 5×5
const BASE_W = 300; // площадка базы нелегальной скупки
const BASE_H = 200;
const BASE_FROM_STATION = 1800; // база стоит на отшибе: не ближе этого к АЗС
const BASE_FROM_BILLBOARD = 700; // и к рекламным щитам
const BILLBOARDS_PER_CLIENT = 4; // столько щитов у каждого клиента по городу
const STATION_MARGIN = 30; // отступ площадки от края квартала
export const CANISTER_R = 20; // радиус канистры (он же радиус подбора)
const CANISTER_SPREAD = 1400; // желаемый разброс канистр; ужимается, если их много
const CANISTER_FROM_START = 900; // и не под колёсами на старте

export interface Rect {
  /** Стабильный серверный id. В локальном режиме объектам он не нужен. */
  id?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Building extends Rect {
  c: string; // цвет крыши/стены
  hgt: number; // «высота» для псевдо-3D
  winMask: number; // биты — какие окна горят
  vents: Array<[number, number, number]>; // вентблоки на крыше (dx,dy,размер)
}

export interface Billboard extends Rect {
  client: Client;
  discovered: boolean; // был ли щит активирован хотя бы раз за заезд (для статистики)
  state: "ready" | "done";
  cooldown: number; // секунд до возврата из done в ready
  vertical: boolean;
  /** Игроки, уже активировавшие щит; присутствует в сетевом снимке. */
  discoveredBy?: string[];
}

export interface Tree {
  id?: string;
  x: number;
  y: number;
  r: number;
}

export interface Lamp {
  id?: string;
  x: number;
  y: number;
}

export interface Park extends Rect {
  pond: { x: number; y: number; r: number } | null;
}

/** АЗС: площадка в углу квартала, въезды с двух прилегающих дорог */
export type StationState = "locked" | "active";
/** как станция была активирована: стартовая, по таймеру после заправки или за просмотр рекламы */
export type StationOrigin = "start" | "timer" | "ad";

export interface Station extends Rect {
  corner: 0 | 1 | 2 | 3; // 0 — верхний левый, 1 — верхний правый, 2 — нижний левый, 3 — нижний правый
  bx: number; // начало квартала по x
  by: number; // начало квартала по y
  state: StationState; // «нет топлива» или работает
  origin: StationOrigin; // источник активации (важно: «рекламные» не открывают следующие)
  price: number; // рублей за литр — у каждой колонки своя цена
  limit: number | null; // сколько литров отпускает за одну заправку; null — без ограничения
}

/** база нелегальной скупки: сюда возят бензин на продажу */
export interface Base extends Rect {
  bx: number;
  by: number;
}

/** канистра: лежит на проезжей части, наезд = подбор */
export interface Canister {
  id?: string;
  x: number;
  y: number;
  taken: boolean;
  cool: number; // пауза перед подбором — чтобы выбитая канистра не влетала обратно
}

export interface City {
  blocks: Rect[];
  parks: Park[];
  buildings: Building[];
  billboards: Billboard[];
  trees: Tree[];
  lamps: Lamp[];
  stations: Station[];
  base: Base;
  canisters: Canister[];
  roadCenters: number[];
}

/* детерминированный ГПСЧ, чтобы город всегда был один и тот же */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hit(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
const grow = (r: Rect, e: number): Rect => ({ x: r.x - e, y: r.y - e, w: r.w + e * 2, h: r.h + e * 2 });

const WALL_COLORS = [
  "#67584f",
  "#5a6673",
  "#6d6a54",
  "#5d6f60",
  "#705a63",
  "#605d70",
  "#6b6157",
  "#54616b",
  "#77624f",
  "#4f6b6b",
];

interface Candidate {
  x: number;
  y: number;
  vertical: boolean;
}

export function buildCity(clients: Client[], canisterCount = 0, start?: { x: number; y: number }): City {
  const rng = mulberry32(20260214);

  const roadCenters: number[] = [];
  for (let i = 0; i <= GRID; i++) roadCenters.push(ROAD / 2 + i * (BLOCK + ROAD));

  const blocks: Rect[] = [];
  const parks: Park[] = [];
  const buildings: Building[] = [];
  const trees: Tree[] = [];

  for (let bx = 0; bx < GRID; bx++) {
    for (let by = 0; by < GRID; by++) {
      const x = ROAD + bx * (BLOCK + ROAD);
      const y = ROAD + by * (BLOCK + ROAD);
      blocks.push({ x, y, w: BLOCK, h: BLOCK });

      const isPark = rng() < 0.24;
      if (isPark) {
        const pond =
          rng() < 0.55
            ? {
                x: x + BLOCK * (0.32 + rng() * 0.36),
                y: y + BLOCK * (0.32 + rng() * 0.36),
                r: 70 + rng() * 55,
              }
            : null;
        parks.push({ x, y, w: BLOCK, h: BLOCK, pond });
        const n = 10 + Math.floor(rng() * 6);
        for (let i = 0; i < n; i++) {
          const tx = x + 60 + rng() * (BLOCK - 120);
          const ty = y + 60 + rng() * (BLOCK - 120);
          if (pond && Math.hypot(tx - pond.x, ty - pond.y) < pond.r + 34) continue;
          trees.push({ x: tx, y: ty, r: 16 + rng() * 15 });
        }
      } else {
        // 2×2 ячейки застройки внутри квартала
        const inner = BLOCK - BUILD_INSET * 2; // 668
        const gap = 24;
        const cell = (inner - gap) / 2; // 322
        for (let cx0 = 0; cx0 < 2; cx0++) {
          for (let cy0 = 0; cy0 < 2; cy0++) {
            if (rng() < 0.14) continue; // пустырь / парковка
            const pad = 10 + rng() * 26;
            const bw = cell - pad * 2;
            const bh = cell - pad * 2;
            const bxPos = x + BUILD_INSET + cx0 * (cell + gap) + pad;
            const byPos = y + BUILD_INSET + cy0 * (cell + gap) + pad;
            const hgt = 20 + rng() * 28;
            const winCount = 10;
            let mask = 0;
            for (let k = 0; k < winCount; k++) if (rng() < 0.62) mask |= 1 << k;
            const vents: Array<[number, number, number]> = [];
            const vn = 1 + Math.floor(rng() * 3);
            for (let v = 0; v < vn; v++) {
              vents.push([14 + rng() * (bw - 60), 14 + rng() * (bh - 60), 16 + rng() * 16]);
            }
            buildings.push({
              x: bxPos,
              y: byPos,
              w: bw,
              h: bh,
              c: WALL_COLORS[Math.floor(rng() * WALL_COLORS.length)],
              hgt,
              winMask: mask,
              vents,
            });
            // пара деревьев во дворе
            if (rng() < 0.5) {
              trees.push({
                x: bxPos - 26 + rng() * 20,
                y: byPos + rng() * bh,
                r: 13 + rng() * 8,
              });
            }
          }
        }
      }
    }
  }

  /* ------- АЗС: углы кварталов, распределённые по городу ------- */
  const stations: Station[] = [];
  const isParkBlock = (b: Rect) => parks.some((p) => p.x === b.x && p.y === b.y);
  const stationSpots: Array<{ gx: number; gy: number; c: 0 | 1 | 2 | 3 }> = [];
  for (let gx = 0; gx < GRID; gx++) {
    for (let gy = 0; gy < GRID; gy++) {
      stationSpots.push({ gx, gy, c: (Math.floor(rng() * 4) as 0 | 1 | 2 | 3) });
    }
  }
  for (let i = stationSpots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [stationSpots[i], stationSpots[j]] = [stationSpots[j], stationSpots[i]];
  }
  // сначала пытаемся развести заправки пошире, потом ужимаем требование
  for (let apart = BLOCK * 1.7; stations.length < STATIONS && apart > 300; apart *= 0.75) {
    stations.length = 0;
    for (const s of stationSpots) {
      if (stations.length >= STATIONS) break;
      const b = blocks[s.gx * GRID + s.gy];
      if (isParkBlock(b)) continue;
      const x = s.c === 1 || s.c === 3 ? b.x + BLOCK - STATION_PAD - STATION_MARGIN : b.x + STATION_MARGIN;
      const y = s.c === 2 || s.c === 3 ? b.y + BLOCK - STATION_PAD - STATION_MARGIN : b.y + STATION_MARGIN;
      const pad: Rect = { x, y, w: STATION_PAD, h: STATION_PAD };
      if (stations.some((st) => hit(grow(st, apart), pad))) continue;
      const price = Math.round(
        CONFIG.stationPriceMin + rng() * Math.max(0, CONFIG.stationPriceMax - CONFIG.stationPriceMin)
      );
      const limit = rng() < CONFIG.stationLimitChance ? CONFIG.stationFuelLimit : null;
      stations.push({
        ...pad,
        corner: s.c,
        bx: b.x,
        by: b.y,
        state: "locked",
        origin: "start",
        price,
        limit,
      });
    }
  }

  /* здания и деревья не должны стоять на площадке АЗС */
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (stations.some((s) => hit(grow(s, 26), buildings[i]))) buildings.splice(i, 1);
  }
  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    if (stations.some((s) => tr.x > s.x - 24 && tr.x < s.x + s.w + 24 && tr.y > s.y - 24 && tr.y < s.y + s.h + 24)) {
      trees.splice(i, 1);
    }
  }

  /* фонари вдоль дорог, мимо перекрёстков */
  const lamps: Lamp[] = [];
  const nearCenter = (v: number) => roadCenters.some((c) => Math.abs(v - c) < ROAD);
  for (let i = 0; i <= GRID; i++) {
    const c = roadCenters[i];
    for (let s = ROAD; s < WORLD - ROAD; s += 520) {
      const side = (Math.floor(s / 520) + i) % 2 === 0 ? 1 : -1;
      if (!nearCenter(s)) lamps.push({ x: c + side * (ROAD / 2 - 15), y: s });
      if (!nearCenter(s + 260)) lamps.push({ x: s + 260 > 0 && s + 260 < WORLD ? s + 260 : s, y: c + side * (ROAD / 2 - 15) });
    }
  }

  /* кандидаты под билборды — середина каждой стороны квартала, на тротуаре */
  const BW = 132;
  const BH = 72;
  const raw: Candidate[] = [];
  for (const b of blocks) {
    const jx = () => b.x + BLOCK * (0.3 + rng() * 0.4);
    const jy = () => b.y + BLOCK * (0.3 + rng() * 0.4);
    raw.push({ x: jx() - BW / 2, y: b.y + 4, vertical: false }); // верхняя сторона
    raw.push({ x: jx() - BW / 2, y: b.y + BLOCK - BH - 4, vertical: false }); // нижняя
    raw.push({ x: b.x + 4, y: jy() - BH / 2, vertical: true }); // левая
    raw.push({ x: b.x + BLOCK - BW - 4, y: jy() - BH / 2, vertical: true }); // правая (вертикальный щит)
  }
  // не ставим щиты вплотную к заправкам
  const candidates = raw.filter((cd) => {
    const r: Rect = cd.vertical ? { x: cd.x, y: cd.y, w: BH, h: BW } : { x: cd.x, y: cd.y, w: BW, h: BH };
    return !stations.some((s) => hit(grow(s, 60), r));
  });
  // перемешать и отобрать с минимальной дистанцией
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const billboards: Billboard[] = [];
  // каждый клиент выкупает несколько щитов: город вырос, кампания тоже
  const shuffledClients: Client[] = [];
  for (let pass = 0; pass < BILLBOARDS_PER_CLIENT; pass++) shuffledClients.push(...clients);
  for (let i = shuffledClients.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffledClients[i], shuffledClients[j]] = [shuffledClients[j], shuffledClients[i]];
  }
  const cxOf = (cd: Candidate) => (cd.vertical ? cd.x + BH / 2 : cd.x + BW / 2);
  const cyOf = (cd: Candidate) => (cd.vertical ? cd.y + BW / 2 : cd.y + BH / 2);
  for (const cd of candidates) {
    if (billboards.length >= shuffledClients.length) break;
    const ok = billboards.every(
      (b) =>
        Math.hypot(cxOf(cd) - (b.x + b.w / 2), cyOf(cd) - (b.y + b.h / 2)) > 780
    );
    if (!ok) continue;
    const client = shuffledClients[billboards.length];
    billboards.push(
      cd.vertical
        ? { x: cd.x, y: cd.y, w: BH, h: BW, client, discovered: false, state: "ready", cooldown: 0, vertical: true }
        : { x: cd.x, y: cd.y, w: BW, h: BH, client, discovered: false, state: "ready", cooldown: 0, vertical: false }
    );
  }

  /* ------- база нелегальной скупки: на отшибе, подальше от АЗС и щитов ------- */
  let base: Base | null = null;
  const baseSpots: Array<{ gx: number; gy: number; c: 0 | 1 | 2 | 3 }> = [];
  for (let gx = 0; gx < GRID; gx++) {
    for (let gy = 0; gy < GRID; gy++) {
      baseSpots.push({ gx, gy, c: (Math.floor(rng() * 4) as 0 | 1 | 2 | 3) });
    }
  }
  for (let i = baseSpots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [baseSpots[i], baseSpots[j]] = [baseSpots[j], baseSpots[i]];
  }
  // требование «на отшибе» ослабляем, только если совсем не нашлось места
  for (let far = 1; !base && far > 0.3; far *= 0.75) {
    for (const sp of baseSpots) {
      const b = blocks[sp.gx * GRID + sp.gy];
      if (isParkBlock(b)) continue;
      const x = sp.c === 1 || sp.c === 3 ? b.x + BLOCK - BASE_W - STATION_MARGIN : b.x + STATION_MARGIN;
      const y = sp.c === 2 || sp.c === 3 ? b.y + BLOCK - BASE_H - STATION_MARGIN : b.y + STATION_MARGIN;
      const pad: Rect = { x, y, w: BASE_W, h: BASE_H };
      const cx = x + BASE_W / 2;
      const cy = y + BASE_H / 2;
      const farFromStations = stations.every(
        (st) => Math.hypot(st.x + st.w / 2 - cx, st.y + st.h / 2 - cy) > BASE_FROM_STATION * far
      );
      if (!farFromStations) continue;
      const farFromBillboards = billboards.every(
        (bb) => Math.hypot(bb.x + bb.w / 2 - cx, bb.y + bb.h / 2 - cy) > BASE_FROM_BILLBOARD * far
      );
      if (!farFromBillboards) continue;
      if (start && Math.hypot(cx - start.x, cy - start.y) < 900) continue;
      base = { ...pad, bx: b.x, by: b.y };
      break;
    }
  }
  if (!base) base = { x: ROAD, y: ROAD, w: BASE_W, h: BASE_H, bx: ROAD, by: ROAD };
  const baseRect = base;
  // на площадке базы не должно быть ни зданий, ни деревьев
  for (let i = buildings.length - 1; i >= 0; i--) {
    if (hit(grow(baseRect, 26), buildings[i])) buildings.splice(i, 1);
  }
  for (let i = trees.length - 1; i >= 0; i--) {
    const tr = trees[i];
    if (
      tr.x > baseRect.x - 24 &&
      tr.x < baseRect.x + baseRect.w + 24 &&
      tr.y > baseRect.y - 24 &&
      tr.y < baseRect.y + baseRect.h + 24
    ) {
      trees.splice(i, 1);
    }
  }

  /* ------- канистры: только на проезжей части, значит игрок точно доедет ------- */
  const canisters: Canister[] = [];
  const onCrossing = (v: number) => roadCenters.some((c) => Math.abs(v - c) < ROAD * 0.9);
  const spots: Array<{ x: number; y: number }> = [];
  for (const c of roadCenters) {
    for (let s2 = ROAD; s2 < WORLD - ROAD; s2 += 190) {
      if (onCrossing(s2)) continue; // не на перекрёстке — там их не заметить
      spots.push({ x: c + (rng() - 0.5) * (ROAD - 90), y: s2 }); // вертикальная улица
      spots.push({ x: s2, y: c + (rng() - 0.5) * (ROAD - 90) }); // горизонтальная
    }
  }
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  // чем больше канистр просят, тем плотнее их приходится класть: начинаем с
  // желаемого разброса и ужимаем его, пока не разложим требуемое количество
  for (let spread = CANISTER_SPREAD; canisters.length < canisterCount && spread > 90; spread *= 0.7) {
    canisters.length = 0;
    for (const sp of spots) {
      if (canisters.length >= canisterCount) break;
      if (start && Math.hypot(sp.x - start.x, sp.y - start.y) < CANISTER_FROM_START) continue;
      if (canisters.some((k) => Math.hypot(k.x - sp.x, k.y - sp.y) < spread)) continue;
      canisters.push({ x: sp.x, y: sp.y, taken: false, cool: 0 });
    }
  }

  return { blocks, parks, buildings, billboards, trees, lamps, stations, base: baseRect, canisters, roadCenters };
}
