import boosterData from "./boosters.json" with { type: "json" };
import {
  VK_STORAGE_VALUE_LIMIT_BYTES,
  createVKOrderPayload,
  isOdnoklassnikiClient,
  isSuccessfulVKOrderResponse,
  isVKIapAvailable,
  serializeVKStorageValue,
} from "./vkGames.ts";

interface BoosterConfig {
  id: string;
  system_name: string;
  sales_method: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const boosters = boosterData as BoosterConfig[];
const inAppBoosters = boosters.filter(
  (booster) => booster.sales_method === "In-app purchase"
);
const systemNames = inAppBoosters.map((booster) => booster.system_name);

assert(
  JSON.stringify(systemNames) === JSON.stringify(["fuel10l", "money025", "money05"]),
  `Неожиданные system_name IAP-бустеров: ${systemNames.join(", ")}`
);
assert(new Set(systemNames).size === systemNames.length, "system_name IAP должны быть уникальны");

for (const booster of inAppBoosters) {
  const payload = createVKOrderPayload(booster.system_name);
  assert(payload.type === "item", "VK OrderBox должен получать type=item");
  assert(payload.item === booster.system_name, "VK item должен совпадать с system_name");
  assert(payload.item !== booster.id, "Числовой id бустера нельзя использовать как VK item");
  assert(
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["item", "type"]),
    "В payload заказа не должно быть посторонних полей"
  );
}

assert(isOdnoklassnikiClient("?vk_client=ok"), "vk_client=ok должен определять OK");
assert(!isVKIapAvailable("?vk_client=ok"), "IAP должен быть заблокирован в OK");
assert(isVKIapAvailable("?vk_client=vk"), "IAP должен быть доступен в VK");

assert(
  isSuccessfulVKOrderResponse({ status: "success", order_id: "order-1" }),
  "status=success должен подтверждать заказ"
);
assert(
  isSuccessfulVKOrderResponse({ success: true, order_id: "legacy-order" }),
  "Поддерживаем совместимый success=true ответ"
);
assert(!isSuccessfulVKOrderResponse({ status: "cancel" }), "Отмена не должна выдавать товар");
assert(!isSuccessfulVKOrderResponse({ status: "fail" }), "Ошибка не должна выдавать товар");

const exactLimitValue = "a".repeat(VK_STORAGE_VALUE_LIMIT_BYTES - 2);
const exactLimitJson = serializeVKStorageValue(exactLimitValue);
assert(
  new TextEncoder().encode(exactLimitJson).byteLength === VK_STORAGE_VALUE_LIMIT_BYTES,
  "Должно разрешаться значение ровно в 4096 UTF-8 байт"
);

let overflowRejected = false;
try {
  serializeVKStorageValue(`${exactLimitValue}a`);
} catch {
  overflowRejected = true;
}
assert(overflowRejected, "Значение больше 4096 байт должно отклоняться");

let cyrillicOverflowRejected = false;
try {
  serializeVKStorageValue("я".repeat(2050));
} catch {
  cyrillicOverflowRejected = true;
}
assert(cyrillicOverflowRejected, "Лимит нужно считать в UTF-8 байтах, а не символах");

const maximumInventory = {
  version: 1,
  counts: { "6": 10, "7": 10, "8": 10 },
  processedPurchaseTokens: Array.from(
    { length: 64 },
    (_, index) => `vk-order:${index.toString().padStart(4, "0")}-${"x".repeat(28)}`
  ),
};
serializeVKStorageValue(maximumInventory);

console.log("VK Bridge/IAP/Storage checks passed");
