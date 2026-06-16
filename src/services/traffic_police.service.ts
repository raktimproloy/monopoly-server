import { GameState, BoardTile } from '../../../shared/types';
import { generateLog } from '../utils/logGenerator';

export class TrafficPoliceService {
  /**
   * Initializes the traffic police state when the game starts.
   */
  static initPoliceState(): GameState['trafficPolice'] {
    return {
      active: false,
      position: null,
      nextAppearanceTime: Date.now() + this.randomBetween(5, 7) * 60 * 1000,
      disappearanceTime: null
    };
  }

  /**
   * Spawns the traffic police on a random purchasable property.
   */
  static spawnPolice(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) {
      newState.trafficPolice = this.initPoliceState();
    }

    const purchasableTiles = boardTiles.filter(t => ['STREET', 'RAILROAD', 'UTILITY'].includes(t.type));
    if (purchasableTiles.length === 0) return { newState, log: '' };

    const randomTile = purchasableTiles[this.randomBetween(0, purchasableTiles.length - 1)];

    newState.trafficPolice.active = true;
    newState.trafficPolice.position = randomTile.index;
    newState.trafficPolice.nextAppearanceTime = null;
    newState.trafficPolice.disappearanceTime = Date.now() + this.randomBetween(3, 4) * 60 * 1000;

    return {
      newState,
      log: `🚔 ট্রাফিক পুলিশ ${randomTile.name} এ অবস্থান নিয়েছে! সেখানে সাবধানে গাড়ি চালাবেন।`
    };
  }

  /**
   * Removes the traffic police from the board.
   */
  static removePolice(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) return { newState, log: '' };

    newState.trafficPolice.active = false;
    newState.trafficPolice.position = null;
    newState.trafficPolice.disappearanceTime = null;
    newState.trafficPolice.nextAppearanceTime = Date.now() + this.randomBetween(5, 7) * 60 * 1000;

    return {
      newState,
      log: `🚓 ট্রাফিক পুলিশ ডিউটি শেষ করে চলে গেছে।`
    };
  }

  /**
   * Process timers to spawn or remove the police.
   */
  static processTimers(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string; changed: boolean } {
    if (!state.settings?.enableTrafficPolice) {
      if (state.trafficPolice?.active) {
        const res = this.removePolice(state);
        // Clear timers so it doesn't spawn again until enabled
        res.newState.trafficPolice!.nextAppearanceTime = null;
        return { newState: res.newState, log: res.log, changed: true };
      }
      return { newState: state, log: '', changed: false };
    }

    if (!state.trafficPolice) {
      // Initialize if not present
      const newState = JSON.parse(JSON.stringify(state)) as GameState;
      newState.trafficPolice = this.initPoliceState();
      return { newState, log: '', changed: true };
    }

    // Handle enabling after being disabled
    if (!state.trafficPolice.active && !state.trafficPolice.nextAppearanceTime) {
      const newState = JSON.parse(JSON.stringify(state)) as GameState;
      newState.trafficPolice!.nextAppearanceTime = Date.now() + this.randomBetween(5, 7) * 60 * 1000;
      return { newState, log: '', changed: true };
    }

    const now = Date.now();

    if (state.trafficPolice.active && state.trafficPolice.disappearanceTime && now >= state.trafficPolice.disappearanceTime) {
      const res = this.removePolice(state);
      return { newState: res.newState, log: res.log, changed: true };
    }

    if (!state.trafficPolice.active && state.trafficPolice.nextAppearanceTime && now >= state.trafficPolice.nextAppearanceTime) {
      const res = this.spawnPolice(state, boardTiles);
      return { newState: res.newState, log: res.log, changed: true };
    }

    return { newState: state, log: '', changed: false };
  }

  static randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  static devForcePolice(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    return this.spawnPolice(state, boardTiles);
  }

  static devSetNextPolice(state: GameState, delayMinutes: number): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.trafficPolice) {
      newState.trafficPolice = this.initPoliceState();
    }
    
    // Remove currently active police if any
    if (newState.trafficPolice.active) {
      newState.trafficPolice.active = false;
      newState.trafficPolice.position = null;
      newState.trafficPolice.disappearanceTime = null;
    }

    newState.trafficPolice.nextAppearanceTime = Date.now() + delayMinutes * 60 * 1000;

    return {
      newState,
      log: `[DEV] পরবর্তী ট্রাফিক পুলিশ ${delayMinutes} মিনিট পর আসবে।`
    };
  }
}
