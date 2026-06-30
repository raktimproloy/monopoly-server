import { GameState, BoardTile } from '../types';

export class TrafficPoliceService {
  static getSpawnDurationMs(): number {
    return this.randomMs(150, 270);
  }

  static spawn(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) {
      newState.trafficPolice = {
        active: false,
        position: null,
        nextAppearanceTime: null,
        disappearanceTime: null,
      };
    }

    const purchasableTiles = boardTiles.filter((t) => ['STREET', 'RAILROAD', 'UTILITY'].includes(t.type));
    if (purchasableTiles.length === 0) return { newState, log: '' };

    const randomTile = purchasableTiles[this.randomBetween(0, purchasableTiles.length - 1)];

    newState.trafficPolice.active = true;
    newState.trafficPolice.position = randomTile.index;
    newState.trafficPolice.nextAppearanceTime = null;
    newState.trafficPolice.disappearanceTime = Date.now() + this.getSpawnDurationMs();

    return {
      newState,
      log: `🚔 ট্রাফিক পুলিশ ${randomTile.name} এ অবস্থান নিয়েছে! সেখানে সাবধানে গাড়ি চালাবেন।`,
    };
  }

  static despawn(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) return { newState, log: '' };

    newState.trafficPolice.active = false;
    newState.trafficPolice.position = null;
    newState.trafficPolice.disappearanceTime = null;
    newState.trafficPolice.nextAppearanceTime = null;

    return {
      newState,
      log: `🚓 ট্রাফিক পুলিশ ডিউটি শেষ করে চলে গেছে।`,
    };
  }

  /** @deprecated Use spawn() */
  static spawnPolice(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    return this.spawn(state, boardTiles);
  }

  /** @deprecated Use despawn() */
  static removePolice(state: GameState): { newState: GameState; log: string } {
    return this.despawn(state);
  }

  /** @deprecated Use WorldEventOrchestrator */
  static initPoliceState(): GameState['trafficPolice'] {
    return {
      active: false,
      position: null,
      nextAppearanceTime: null,
      disappearanceTime: null,
    };
  }

  /** @deprecated Use WorldEventOrchestrator.processTick */
  static processTimers(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string; changed: boolean } {
    return { newState: state, log: '', changed: false };
  }

  static devForcePolice(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    return this.spawn(state, boardTiles);
  }

  static devSetNextPolice(state: GameState, delayMinutes: number): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) {
      newState.trafficPolice = this.initPoliceState();
    }
    newState.trafficPolice!.nextAppearanceTime = Date.now() + delayMinutes * 60 * 1000;
    return {
      newState,
      log: `[DEV] পরবর্তী ট্রাফিক পুলিশ ${delayMinutes} মিনিট পর আসবে।`,
    };
  }

  static randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  private static randomMs(minSec: number, maxSec: number): number {
    const min = Math.floor(minSec * 1000);
    const max = Math.floor(maxSec * 1000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
