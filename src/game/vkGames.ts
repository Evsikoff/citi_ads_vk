import vkBridge from "@vkontakte/vk-bridge";
import type {
  ParentConfigData,
  VKBridgeSubscribeHandler,
} from "@vkontakte/vk-bridge";

export interface FullscreenAdCallbacks {
  onOpen?(): void;
  onClose?(wasShown: boolean): void;
  onError?(error: unknown): void;
}

export interface RewardedVideoAdCallbacks extends FullscreenAdCallbacks {
  onRewarded?(): void;
}

export interface VKPurchase {
  productID: string;
  orderId: string;
  purchaseToken: string;
}

export interface VKOrderPayload {
  type: "item";
  item: string;
}

export const VK_STORAGE_VALUE_LIMIT_BYTES = 4096;
const VK_INITIALIZATION_TIMEOUT_MS = 5000;
const VK_LAUNCH_PARAMS = [
  "vk_app_id",
  "vk_user_id",
  "vk_platform",
  "vk_client",
] as const;

let bridgeInitialization: Promise<boolean> | null = null;

const currentSearch = (): string =>
  typeof window === "undefined" ? "" : window.location.search;

export function getVKClient(search = currentSearch()): string | null {
  return new URLSearchParams(search).get("vk_client");
}

export function isOdnoklassnikiClient(search = currentSearch()): boolean {
  return getVKClient(search) === "ok";
}

export function isVKIapAvailable(search = currentSearch()): boolean {
  return !isOdnoklassnikiClient(search);
}

function hasVKLaunchContext(search = currentSearch()): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(search);
  return vkBridge.isEmbedded() || VK_LAUNCH_PARAMS.some((key) => params.has(key));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new Error("VK Bridge не ответил на инициализацию")),
      milliseconds
    );
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Инициализирует VK Bridge ровно один раз при старте приложения. */
export function initVKBridge(): Promise<boolean> {
  if (bridgeInitialization) return bridgeInitialization;

  const request = vkBridge.send("VKWebAppInit");

  // В обычной вкладке разработчика контейнера VK нет и ответить на postMessage
  // некому. Вызов инициализации всё равно сделан, но локальную игру не блокируем.
  if (!hasVKLaunchContext()) {
    void request.catch(() => {});
    bridgeInitialization = Promise.resolve(false);
    return bridgeInitialization;
  }

  bridgeInitialization = withTimeout(request, VK_INITIALIZATION_TIMEOUT_MS)
    .then((data) => {
      const initialized = data.result === true;
      if (initialized) console.info("VK Bridge готов к работе");
      return initialized;
    })
    .catch((error: unknown) => {
      console.error("Ошибка инициализации VK Bridge:", error);
      return false;
    });

  return bridgeInitialization;
}

async function requireVKBridge(): Promise<void> {
  if (!(await initVKBridge())) throw new Error("VK Bridge недоступен");
}

/** Возвращает имя игрока из профиля VK/OK. */
export async function getVKPlayerName(): Promise<string> {
  await requireVKBridge();
  const player = await vkBridge.send("VKWebAppGetUserInfo");
  const name = `${player.first_name} ${player.last_name}`.trim();
  if (!name) throw new Error("Имя игрока VK недоступно");
  return name;
}

export function serializeVKStorageValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Значение невозможно сериализовать для VK Storage");
  }

  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > VK_STORAGE_VALUE_LIMIT_BYTES) {
    throw new Error(
      `Значение VK Storage занимает ${bytes} байт при лимите ${VK_STORAGE_VALUE_LIMIT_BYTES}`
    );
  }
  return serialized;
}

function parseVKStorageValue(value: string): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    console.error("Некорректный JSON в VK Storage:", error);
    return undefined;
  }
}

/** Читает JSON-значения из строкового VK Storage. */
export async function getVKPlayerData(keys: string[]): Promise<Record<string, unknown>> {
  await requireVKBridge();
  const data = await vkBridge.send("VKWebAppStorageGet", { keys });
  return Object.fromEntries(
    data.keys.map(({ key, value }) => [key, parseVKStorageValue(value)])
  );
}

/** Сериализует значения в JSON и записывает их в VK Storage. */
export async function setVKPlayerData(data: Record<string, unknown>): Promise<void> {
  await requireVKBridge();
  await Promise.all(
    Object.entries(data).map(async ([key, source]) => {
      const value = serializeVKStorageValue(source);
      const result = await vkBridge.send("VKWebAppStorageSet", { key, value });
      if (result.result !== true) throw new Error(`VK Storage не сохранил ключ ${key}`);
    })
  );
}

/** Формирует payload заказа без подмен: item всегда равен system_name из JSON. */
export function createVKOrderPayload(systemName: string): VKOrderPayload {
  if (!systemName.trim()) throw new Error("У бустера отсутствует system_name");
  return { type: "item", item: systemName };
}

export function isSuccessfulVKOrderResponse(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const response = value as { status?: unknown; success?: unknown };
  return response.status === "success" || response.success === true;
}

function getVKOrderId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const orderId = (value as { order_id?: unknown }).order_id;
  if (typeof orderId !== "string" && typeof orderId !== "number") return null;
  const normalized = String(orderId).trim();
  return normalized || null;
}

/** Открывает окно оплаты VK. В OK покупки блокируются ещё и на уровне API. */
export async function purchaseVKProduct(systemName: string): Promise<VKPurchase> {
  if (!isVKIapAvailable()) {
    throw new Error("In-App покупки недоступны в Одноклассниках");
  }

  await requireVKBridge();
  const payload = createVKOrderPayload(systemName);
  const response = await vkBridge.send("VKWebAppShowOrderBox", payload);
  if (!isSuccessfulVKOrderResponse(response)) {
    const status = response.status === "cancel" ? "отменена" : "не выполнена";
    throw new Error(`Покупка ${status}`);
  }

  const orderId = getVKOrderId(response);
  if (!orderId) throw new Error("VK не вернул идентификатор успешного заказа");

  return {
    productID: systemName,
    orderId,
    purchaseToken: `vk-order:${orderId}`,
  };
}

/** Показывает межэкранную рекламу; при ошибке управление вернёт вызывающий код. */
export async function showFullscreenAd(callbacks: FullscreenAdCallbacks): Promise<void> {
  try {
    await requireVKBridge();
    callbacks.onOpen?.();
    const data = await vkBridge.send("VKWebAppShowNativeAds", {
      ad_format: "interstitial",
    });
    callbacks.onClose?.(data.result === true);
  } catch (error: unknown) {
    callbacks.onError?.(error);
  }
}

/** Выдаёт rewarded-событие только после result=true от VK. */
export async function showRewardedVideoAd(
  callbacks: RewardedVideoAdCallbacks
): Promise<void> {
  try {
    await requireVKBridge();
    callbacks.onOpen?.();
    const data = await vkBridge.send("VKWebAppShowNativeAds", {
      ad_format: "reward",
    });
    const wasShown = data.result === true;
    if (wasShown) callbacks.onRewarded?.();
    callbacks.onClose?.(wasShown);
  } catch (error: unknown) {
    callbacks.onError?.(error);
  }
}

function applyVKInsets(insets: { top: number; right: number; bottom: number; left: number }): void {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  style.setProperty("--vk-safe-area-top", `${Math.max(0, insets.top)}px`);
  style.setProperty("--vk-safe-area-right", `${Math.max(0, insets.right)}px`);
  style.setProperty("--vk-safe-area-bottom", `${Math.max(0, insets.bottom)}px`);
  style.setProperty("--vk-safe-area-left", `${Math.max(0, insets.left)}px`);
}

function applyVKViewportConfig(config: ParentConfigData): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const style = document.documentElement.style;
  if ("viewport_width" in config && config.viewport_width > 0) {
    style.setProperty("--vk-viewport-width", `${config.viewport_width}px`);
  }
  if ("viewport_height" in config && config.viewport_height > 0) {
    style.setProperty("--vk-viewport-height", `${config.viewport_height}px`);
  }
  if ("insets" in config && config.insets) applyVKInsets(config.insets);
  window.dispatchEvent(new CustomEvent("vkviewportchange", { detail: config }));
  window.dispatchEvent(new Event("resize"));
}

/** Подписывает игру на изменения viewport и safe area от контейнера VK. */
export function installVKViewportSync(): () => void {
  const handler: VKBridgeSubscribeHandler = (event) => {
    if (event.detail.type === "VKWebAppUpdateConfig") {
      applyVKViewportConfig(event.detail.data);
    } else if (event.detail.type === "VKWebAppUpdateInsets") {
      applyVKInsets(event.detail.data.insets);
      window.dispatchEvent(new Event("resize"));
    }
  };

  vkBridge.subscribe(handler);
  void initVKBridge().then(async (initialized) => {
    if (!initialized) return;
    try {
      applyVKViewportConfig(await vkBridge.send("VKWebAppGetConfig"));
    } catch (error: unknown) {
      console.info("Начальная конфигурация viewport VK недоступна:", error);
    }
  });

  return () => vkBridge.unsubscribe(handler);
}

interface VKFullscreenBridge {
  send(
    method: "VKWebAppSetViewSettings",
    params: { status_bar_style: "light" | "dark"; fullscreen: boolean }
  ): Promise<{ result?: boolean }>;
}

/**
 * В нативном клиенте запрашивает fullscreen через VK Bridge, в браузере —
 * через стандартный Fullscreen API (функция должна вызываться из user gesture).
 */
export async function setVKFullscreen(fullscreen: boolean): Promise<boolean> {
  if (typeof document === "undefined") return false;

  if (!vkBridge.isWebView()) {
    if (fullscreen) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
    return document.fullscreenElement !== null;
  }

  await requireVKBridge();
  // Поле fullscreen требуется контейнером по спецификации проекта, но пока
  // отсутствует в публичном типе ViewSettings в vk-bridge 3.x.
  const fullscreenBridge = vkBridge as unknown as VKFullscreenBridge;
  const result = await fullscreenBridge.send("VKWebAppSetViewSettings", {
    status_bar_style: "light",
    fullscreen,
  });
  return result.result === true ? fullscreen : !fullscreen;
}
