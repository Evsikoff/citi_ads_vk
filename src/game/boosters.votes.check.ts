import { formatVkVotesPrice, getVkVotesPrice } from "./boosters.ts";
import type { Booster } from "./boosters.ts";

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const iap = {
  id: "6",
  system_name: "fuel10l",
  name: "+ 10 л. бенза",
  display_method: "Booster menu",
  sales_method: "In-app purchase",
  maximum_number_of_purchases_per_session: "2",
  actual_price: "1",
  icon_filename: "fuel.png",
} satisfies Booster;

const expensive = { ...iap, actual_price: "4" };
const ingame = { ...iap, sales_method: "In-game currency" as const, actual_price: "4" };

assert(getVkVotesPrice(iap) === 1, "actual_price должен читаться как число голосов");
assert(formatVkVotesPrice(iap) === "1 голос", "1 голос должен склоняться в единственном числе");
assert(formatVkVotesPrice(expensive) === "4 голоса", "4 голоса должны склоняться");
assert(formatVkVotesPrice(ingame) === null, "Цена в голосах только у In-app purchase");

console.info("Цена IAP в голосах VK: OK");
