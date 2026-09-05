/* Физика кузова — общая для машины игрока и для ботов, чтобы ездили одинаково. */

export const MAX_SPEED = 640; // потолок скорости, px/с
export const ACC = 540; // разгон, px/с²
export const BRAKE = 780; // торможение, px/с²
export const CAR_R = 15; // радиус кузова для столкновений со стенами
export const KMH = 0.28; // px/с → км/ч на спидометре

export const TURN_RATE = 3.1; // максимальная угловая скорость при полном руле, рад/с
/** как быстро руль доходит до упора и возвращается обратно, доля хода в секунду */
export const STEER_ATTACK = 8;
export const STEER_RELEASE = 12;

/* ---- доводка курса под улицу ---- */
/** Город — сетка из прямых улиц, поэтому «прямо» всегда кратно 90°. */
const QUARTER = Math.PI / 2;
/** до этого отклонения доводим в полную силу (≈26°) */
const ALIGN_FULL_ERROR = 0.45;
/** а дальше слабеем и к этому углу (≈43°) отпускаем машину совсем: там уже не
 * «остаток поворота», а честная воля игрока, и её перебивать нельзя */
const ALIGN_MAX_ERROR = 0.75;
/** жёсткость доводки: остаток гаснет с этой скоростью, 1/с */
const ALIGN_RATE = 5;
/** и не быстрее этого, рад/с — заметно медленнее, чем крутит сам игрок */
const ALIGN_MAX_RATE = 1.4;
/** ниже этой скорости курс не трогаем: стоящую машину нельзя разворачивать */
const ALIGN_MIN_SPEED = 20;
/** на этой скорости доводка работает в полную силу, px/с */
const ALIGN_FULL_SPEED = 90;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/**
 * Поворотливость. На малом ходу руль работает вполсилы, но не пропадает совсем —
 * иначе из угла не выехать; на разгоне машину заметно «несёт».
 */
export function grip(speed: number, maxSpeed: number = MAX_SPEED): number {
  const sp = Math.abs(speed);
  // до 130 px/с угловая скорость растёт вместе с ходом: радиус разворота один и
  // тот же, как у настоящего руля до упора. На самом малом ходу руль подпёрт
  // снизу — чтобы упёршуюся в стену машину можно было довернуть и выехать, — но
  // у стоящей машины он по-прежнему не работает.
  const low = Math.max(0.22 * Math.min(sp / 25, 1), Math.min(sp / 130, 1));
  const fast = 1 - 0.3 * Math.min(sp / maxSpeed, 1);
  return low * fast;
}

/**
 * Положение руля за кадр. Возврат к нулю быстрее набора: отпустил клавишу —
 * машина сразу едет прямо, а не доворачивает ещё полкорпуса.
 */
export function stepSteering(steer: number, dir: number, dt: number): number {
  const backwards = steer !== 0 && dir !== 0 && Math.sign(dir) !== Math.sign(steer);
  const rate = (dir === 0 || backwards ? STEER_RELEASE : STEER_ATTACK) * dt;
  return clamp(dir, steer - rate, steer + rate);
}

/** Насколько курс отклонён от ближайшего направления улицы, рад (−45°…45°). */
export function streetHeadingError(angle: number): number {
  return angle - Math.round(angle / QUARTER) * QUARTER;
}

/**
 * Доворот курса к ближайшей улице за кадр — то самое выравнивание после
 * поворота. Руль отпущен, значит игрок хочет ехать прямо: остаток от поворота
 * машина добирает сама и дальше идёт вдоль улицы, а не наискось в бордюр.
 *
 * Работает только на мелких отклонениях: если машина повёрнута сильно, значит
 * поворот ещё не закончен (или игрок разворачивается) — там своя воля важнее.
 */
export function alignStep(angle: number, speed: number, dt: number): number {
  const sp = Math.abs(speed);
  if (sp < ALIGN_MIN_SPEED) return 0;
  const err = streetHeadingError(angle);
  const off = Math.abs(err);
  if (off > ALIGN_MAX_ERROR) return 0;
  // и сила, и порог гаснут плавно: включись доводка резко, это читалось бы как
  // рывок руля из ниоткуда
  const fade = 1 - clamp((off - ALIGN_FULL_ERROR) / (ALIGN_MAX_ERROR - ALIGN_FULL_ERROR), 0, 1);
  const ramp = Math.min(1, (sp - ALIGN_MIN_SPEED) / (ALIGN_FULL_SPEED - ALIGN_MIN_SPEED));
  const rate = clamp(-err * ALIGN_RATE, -ALIGN_MAX_RATE, ALIGN_MAX_RATE) * ramp * fade;
  const step = rate * dt;
  // хвост доводки добираем сразу: иначе курс бесконечно ползёт к прямому
  return Math.abs(step) >= Math.abs(err) ? -err : step;
}
