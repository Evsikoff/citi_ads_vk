import { sfx } from "./audio";
import { CityRideGame } from "./engine";

type MenuGame = {
  online?: { playerLost(reason?: string): string | null };
  keys: Set<string>;
  reset(): void;
  phase: "menu" | "play";
};

declare module "./engine" {
  interface CityRideGame {
    returnToMenu(): void;
  }
}

CityRideGame.prototype.returnToMenu = function returnToMenu(this: CityRideGame): void {
  const game = this as unknown as MenuGame;
  game.online?.playerLost("returned-to-menu");
  game.keys.clear();
  sfx.stopAllRefueling();
  sfx.engineIdle();
  game.reset();
  game.phase = "menu";
};
