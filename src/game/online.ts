import type { City } from "./world";

export const GAME_SERVER_URL =
  "wss://ws--gdebenz-server--nz47zn545dwm.code.run/ws";

export type ConnectionStatus = "connecting" | "online" | "offline";

const SERVER_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  accepted: "Действие выполнено.",
  "room-full": "Комната заполнена.",
  "player-not-found": "Игрок не найден.",
  "player-inactive": "Игрок сейчас не участвует в заезде.",
  "player-already-active": "Игрок уже участвует в заезде.",
  "already-lost": "Заезд этого игрока уже завершён.",
  "object-not-found": "Игровой объект не найден.",
  "unsupported-object": "Это действие не поддерживается.",
  "canister-taken": "Эту канистру уже подобрали.",
  "too-far": "Нужно подъехать ближе.",
  "station-locked": "Эта заправка сейчас закрыта.",
  "tank-full": "Бак уже полон.",
  "not-enough-money": "Недостаточно денег.",
  "nothing-to-sell": "Нет топлива для продажи.",
  "invalid-liters": "Указан некорректный объём топлива.",
  "tank-capacity-exceeded": "Указанный объём не помещается в бак.",
  "station-limit-exceeded": "Превышен лимит отпуска этой колонки.",
  "billboard-cooldown": "Этот рекламный щит ещё недоступен.",
  "all-stations-active": "Все заправки уже работают.",
  "unknown-booster": "Игровой эффект этого улучшения не настроен.",
  "stale-world": "Карта обновилась — повторите действие.",
  "stale-sequence": "Получена устаревшая команда управления.",
  "movement-too-fast": "Сервер отклонил слишком резкое перемещение.",
  "binary-not-supported": "Поддерживаются только текстовые JSON-сообщения.",
  "invalid-message": "Сервер получил некорректное сообщение.",
  "already-joined": "Это подключение уже участвует в заезде.",
  "join-failed": "Не удалось присоединиться к заезду.",
  "join-required": "Сначала нужно присоединиться к заезду.",
  "interaction-failed": "Не удалось выполнить игровое действие.",
});

export function serverMessage(code: string, supplied?: string): string {
  if (supplied && /[А-Яа-яЁё]/.test(supplied)) return supplied;
  return SERVER_MESSAGES[code] ?? `Сервер отклонил запрос (${code}).`;
}

export interface ServerHello {
  protocolVersion: number;
  tickRate: number;
  snapshotRate: number;
}

export interface PublicPlayerState {
  id: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  fuel: number;
  tankVolume: number;
  money: number;
  canisters: number;
  filledLiters: number;
  status: "active" | "lost" | string;
  lastInputSeq: number;
  /** Накопленный сервером отскок после тарана, пикс/с. */
  kx?: number;
  ky?: number;
  /** Идёт заправка: машина стоит под колонкой. */
  refueling?: boolean;
  refuelStationId?: string | null;
  /** Литры и рубли текущей сессии заправки. */
  refuelLiters?: number;
  refuelSpent?: number;
  /** Полный таймаут и оставшееся время текущей заправки, в секундах. */
  refuelDuration?: number;
  refuelRemaining?: number;
  /** Множители от бустеров — их считает сервер. */
  speedMultiplier?: number;
  fuelConsumptionMultiplier?: number;
}

export interface RemoteEntityState {
  id: string;
  name: string;
  x: number;
  y: number;
  angle: number;
  speed: number;
  color: string;
  filledLiters: number;
  status?: string;
  fuel?: number;
  tankVolume?: number;
  money?: number;
  canisters?: number;
  taken?: number;
  wait?: number;
  refueling?: boolean;
  refuelStationId?: string | null;
  refuelDuration?: number;
  refuelRemaining?: number;
  refuelTargetLiters?: number;
  refuelLiters?: number;
  refuelSpent?: number;
  respawnRemaining?: number;
  style?: number;
  lane?: number;
  wobble?: number;
  kx?: number;
  ky?: number;
  stun?: number;
}

export interface EntitySnapshot {
  tick: number;
  serverTime: number;
  worldRevision: number;
  players: PublicPlayerState[];
  bots: RemoteEntityState[];
}

/** Заправка началась или закончилась — сервер ведёт её сам. */
export interface RefuelEvent {
  playerId: string;
  stationId: string;
  state: "started" | "stopped";
  reason: "full" | "limit" | "money" | "left" | null;
  liters: number;
  spent: number;
}

/**
 * Столкновение двух машин, посчитанное сервером. Клиент по нему рисует искры,
 * трясёт камеру, даёт звук удара и сообщает о выбитых канистрах.
 */
export interface CollisionEvent {
  /** Точка касания кузовов в мировых координатах. */
  x: number;
  y: number;
  /** Сила удара — та же величина, что ушла в отскок. */
  force: number;
  /** Кто протаранил и кого: id игрока или бота. */
  rammerId: string;
  victimId: string;
  rammerIsPlayer: boolean;
  victimIsPlayer: boolean;
  /** Сколько канистр выбило из протаранённой машины. */
  spilled: number;
}

export interface ServerLeaderboardEntry {
  entityId: string;
  position: number;
  name: string;
  liters: number;
  isPlayer: boolean;
  color: string;
  active: boolean;
}

export interface ServerCity extends City {
  meta: {
    revision: number;
    seed: number;
    scale: number;
    grid: number;
    worldSize: number;
    blockSize: number;
    roadWidth: number;
  };
}

export interface WorldObjects {
  worldRevision: number;
  stations: ServerCity["stations"];
  billboards: ServerCity["billboards"];
  canisters: ServerCity["canisters"];
}

export interface InteractionResult {
  requestId: string;
  ok: boolean;
  code: string;
  message?: string;
  player: PublicPlayerState;
  details?: Record<string, unknown>;
}

export interface GameEventResult extends InteractionResult {
  event:
    | "fuel-filled"
    | "station-blocked"
    | "billboard-interacted"
    | "player-lost"
    | "player-respawn"
    | "booster-applied"
    | string;
}

export interface ServerError {
  code: string;
  message: string;
  requestId?: string;
}

export interface PlayerControls {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  handbrake: boolean;
}

export type ObjectType = "billboard" | "station" | "canister" | "base";

export interface OnlineGameTransport {
  readonly connected: boolean;
  /** Замеренное время оборота пакета, секунды. 0 — пока не измерено. */
  readonly latency: number;
  sendInput(input: PlayerControls): void;
  sendMove(position: Pick<PublicPlayerState, "x" | "y" | "angle" | "speed">): void;
  interact(objectType: ObjectType, objectId: string, amount?: number): string | null;
  fuelFilled(stationId: string, liters: number): string | null;
  stationBlocked(stationId: string): string | null;
  billboardInteracted(billboardId: string): string | null;
  playerLost(reason?: string): string | null;
  respawn(): string | null;
  booster(systemName: string, cost?: number): string | null;
}

export interface MultiplayerListeners {
  onStatus(status: ConnectionStatus): void;
  onHello?(hello: ServerHello): void;
  onWelcome?(playerId: string, player: PublicPlayerState): void;
  onSnapshot?(
    map: ServerCity,
    entities: EntitySnapshot,
    leaderboard: ServerLeaderboardEntry[]
  ): void;
  onEntities?(entities: EntitySnapshot): void;
  onCollisions?(collisions: CollisionEvent[]): void;
  onRefuel?(event: RefuelEvent): void;
  onObjects?(objects: WorldObjects): void;
  onMapUpdate?(map: ServerCity, reason: string, fuelBonus: number): void;
  onLeaderboard?(rows: ServerLeaderboardEntry[]): void;
  onInteractionResult?(result: InteractionResult): void;
  onGameEventResult?(result: GameEventResult): void;
  onPlayerRespawned?(player: PublicPlayerState): void;
  onPlayerDespawned?(playerId: string, reason?: string): void;
  onPlayerJoined?(player: PublicPlayerState): void;
  onPlayerLeft?(playerId: string): void;
  onError?(error: ServerError): void;
}

interface ServerEnvelope<T = unknown> {
  type: string;
  payload: T;
}

const requestId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

/**
 * Маленький транспортный слой протокола v1. Он ничего не знает о React и
 * canvas-движке: только держит WebSocket, нумерует команды и маршрутизирует
 * серверные события.
 */
export class MultiplayerClient implements OnlineGameTransport {
  private socket: WebSocket | null = null;
  private listeners: MultiplayerListeners;
  private hello: ServerHello | null = null;
  // Сервер проверяет player:input и player:move как одну упорядоченную ленту
  // команд. Раздельные счётчики давали одинаковые seq двум соседним пакетам:
  // второй считался устаревшим, и после серии таких отказов клиент переключал
  // машину с мгновенной локальной физики на управление через сервер.
  private controlSeq = 0;
  private worldRevision = 0;
  private gameReady = false;
  private pingTimer = 0;
  private pingSentAt = 0;
  private rtt = 0;
  private disposed = false;
  private status: ConnectionStatus = "connecting";

  constructor(
    private readonly url: string,
    listeners: MultiplayerListeners
  ) {
    this.listeners = listeners;
  }

  get connected(): boolean {
    return this.status === "online" && this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Время оборота пакета в секундах. Движку оно нужно, чтобы понимать, на
   * сколько состояние в снапшоте отстало от того, что игрок уже видит у себя.
   */
  get latency(): number {
    return this.rtt;
  }

  connect(timeoutMs = 5000): Promise<boolean> {
    this.disposed = false;
    this.setStatus("connecting");

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(ok);
      };
      const fail = () => {
        if (this.status !== "online") {
          this.setStatus("offline");
          finish(false);
        }
      };
      const timeout = window.setTimeout(() => {
        fail();
        this.socket?.close(4000, "hello timeout");
      }, timeoutMs);

      try {
        const socket = new WebSocket(this.url);
        this.socket = socket;
        socket.addEventListener("message", (event) => {
          const message = this.parse(event.data);
          if (!message) return;
          if (message.type === "server:hello") {
            const hello = message.payload as ServerHello;
            if (hello.protocolVersion !== 1) {
              this.listeners.onError?.({
                code: "UNSUPPORTED_PROTOCOL",
                message: `Сервер использует протокол v${hello.protocolVersion}`,
              });
              socket.close(4001, "unsupported protocol");
              fail();
              return;
            }
            this.hello = hello;
            this.setStatus("online");
            this.listeners.onHello?.(hello);
            this.startPing();
            finish(true);
          }
          this.route(message);
        });
        socket.addEventListener("error", fail);
        socket.addEventListener("close", () => {
          this.stopPing();
          if (!this.disposed) this.setStatus("offline");
          finish(false);
        });
      } catch {
        fail();
      }
    });
  }

  join(name: string): void {
    this.controlSeq = 0;
    this.worldRevision = 0;
    this.gameReady = false;
    this.rtt = 0;
    this.send("player:join", { name });
  }

  sendInput(input: PlayerControls): void {
    if (!this.gameReady) return;
    this.send("player:input", {
      seq: this.controlSeq++,
      worldRevision: this.worldRevision,
      ...input,
    });
  }

  sendMove(position: Pick<PublicPlayerState, "x" | "y" | "angle" | "speed">): void {
    if (!this.gameReady) return;
    this.send("player:move", {
      seq: this.controlSeq++,
      worldRevision: this.worldRevision,
      ...position,
    });
  }

  interact(objectType: ObjectType, objectId: string, amount?: number): string | null {
    if (!this.gameReady) return null;
    const id = requestId();
    return this.send("world:interact", {
      requestId: id,
      objectType,
      objectId,
      ...(amount === undefined ? {} : { amount }),
    })
      ? id
      : null;
  }

  fuelFilled(stationId: string, liters: number): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:fuel-filled", { stationId, liters });
  }

  stationBlocked(stationId: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("station:blocked", { stationId });
  }

  billboardInteracted(billboardId: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("billboard:interacted", { billboardId });
  }

  playerLost(reason?: string): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:lost", reason ? { reason } : {});
  }

  booster(systemName: string, cost = 0): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:booster", { systemName, cost });
  }

  respawn(): string | null {
    if (!this.gameReady) return null;
    return this.sendRequest("player:respawn", {});
  }

  destroy(): void {
    this.disposed = true;
    this.stopPing();
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close(1000, "client closed");
    }
    this.socket = null;
    this.gameReady = false;
  }

  private sendRequest(type: string, payload: Record<string, unknown>): string | null {
    const id = requestId();
    return this.send(type, { requestId: id, ...payload }) ? id : null;
  }

  private send(type: string, payload: Record<string, unknown>): boolean {
    if (!this.connected || !this.socket) return false;
    try {
      this.socket.send(JSON.stringify({ type, payload }));
      return true;
    } catch {
      return false;
    }
  }

  private parse(data: unknown): ServerEnvelope | null {
    if (typeof data !== "string") return null;
    try {
      const message = JSON.parse(data) as Partial<ServerEnvelope>;
      return typeof message.type === "string" && "payload" in message
        ? (message as ServerEnvelope)
        : null;
    } catch {
      this.listeners.onError?.({ code: "BAD_SERVER_MESSAGE", message: "Сервер прислал некорректный JSON" });
      return null;
    }
  }

  private route(message: ServerEnvelope): void {
    switch (message.type) {
      case "server:hello":
        return;
      case "pong": {
        // Половина этого времени — то, на сколько серверный снапшот отстал от
        // клиента. Сглаживаем, чтобы один медленный пакет не сдвинул оценку.
        const payload = message.payload as { clientTime?: number } | null;
        const sent =
          typeof payload?.clientTime === "number" ? payload.clientTime : this.pingSentAt;
        if (sent > 0) {
          const sample = Math.max(0, Date.now() - sent) / 1000;
          if (sample < 2) this.rtt = this.rtt > 0 ? this.rtt + (sample - this.rtt) * 0.25 : sample;
        }
        return;
      }
      case "player:welcome": {
        const payload = message.payload as { playerId: string; player: PublicPlayerState };
        this.listeners.onWelcome?.(payload.playerId, payload.player);
        return;
      }
      case "world:snapshot": {
        const payload = message.payload as {
          map: ServerCity;
          entities: EntitySnapshot;
          leaderboard: ServerLeaderboardEntry[];
        };
        this.worldRevision = payload.map.meta.revision;
        this.gameReady = true;
        this.listeners.onSnapshot?.(payload.map, payload.entities, payload.leaderboard);
        return;
      }
      case "world:entities": {
        const payload = message.payload as EntitySnapshot;
        this.worldRevision = payload.worldRevision;
        this.listeners.onEntities?.(payload);
        return;
      }
      case "player:refuel": {
        this.listeners.onRefuel?.(message.payload as RefuelEvent);
        return;
      }
      case "world:collisions": {
        const payload = message.payload as { tick: number; collisions: CollisionEvent[] };
        if (Array.isArray(payload.collisions) && payload.collisions.length > 0) {
          this.listeners.onCollisions?.(payload.collisions);
        }
        return;
      }
      case "world:objects": {
        const payload = message.payload as WorldObjects;
        this.worldRevision = payload.worldRevision;
        this.listeners.onObjects?.(payload);
        return;
      }
      case "world:map-update": {
        const payload = message.payload as {
          map: ServerCity;
          reason: string;
          fuelBonus: number;
          affectedPlayers: string[];
        };
        this.worldRevision = payload.map.meta.revision;
        this.listeners.onMapUpdate?.(payload.map, payload.reason, payload.fuelBonus);
        return;
      }
      case "leaderboard:update":
        this.listeners.onLeaderboard?.(
          (message.payload as { rows: ServerLeaderboardEntry[] }).rows
        );
        return;
      case "interaction:result":
        this.listeners.onInteractionResult?.(message.payload as InteractionResult);
        return;
      case "game:event-result":
        this.listeners.onGameEventResult?.(message.payload as GameEventResult);
        return;
      case "player:respawned":
        this.listeners.onPlayerRespawned?.(
          (message.payload as { player: PublicPlayerState }).player
        );
        return;
      case "player:despawned": {
        const payload = message.payload as { playerId: string; reason?: string };
        this.listeners.onPlayerDespawned?.(payload.playerId, payload.reason);
        return;
      }
      case "player:joined":
        this.listeners.onPlayerJoined?.(
          (message.payload as { player: PublicPlayerState }).player
        );
        return;
      case "player:left":
        this.listeners.onPlayerLeft?.((message.payload as { playerId: string }).playerId);
        return;
      case "server:error":
        this.listeners.onError?.(message.payload as ServerError);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status && status !== "connecting") return;
    this.status = status;
    this.listeners.onStatus(status);
  }

  private startPing(): void {
    this.stopPing();
    // Раз в две секунды: пинг заодно держит соединение живым, но главное — по
    // нему движок узнаёт текущую задержку, а она за 15 секунд успевает уплыть.
    const beat = () => {
      this.pingSentAt = Date.now();
      this.send("ping", { clientTime: this.pingSentAt });
    };
    beat();
    this.pingTimer = window.setInterval(beat, 2000);
  }

  private stopPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }
}
