import { GameState } from '../types';
import { toBanglaNum } from '../utils/format';

export class MarketCrashService {
  /**
   * Random duration for an active market crash window.
   */
  static getCrashDurationMs(crashCount: number): number {
    if (crashCount === 0) {
      return this.randomMs(90, 210);
    }
    return this.randomMs(150, 330);
  }

  static activate(state: GameState, durationMs?: number): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const actualDurationMs = durationMs ?? this.getCrashDurationMs(newState.marketCrash.crashCount);

    newState.marketCrash.active = true;
    newState.marketCrash.nextCrashTime = null;
    newState.marketCrash.crashEndTime = Date.now() + actualDurationMs;
    newState.marketCrash.crashCount += 1;

    return {
      newState,
      log: `🚨 মার্কেট ক্র্যাশ শুরু হয়েছে! জমির দাম ৩০% কমে গেছে এবং ভাড়া ৪০% বেড়ে গেছে।`,
    };
  }

  static deactivate(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.marketCrash.active = false;
    newState.marketCrash.crashEndTime = null;
    newState.marketCrash.nextCrashTime = null;

    return {
      newState,
      log: `✅ মার্কেট ক্র্যাশ শেষ হয়েছে। বাজার স্বাভাবিক অবস্থায় ফিরেছে।`,
    };
  }

  /** @deprecated Use WorldEventOrchestrator — kept for any legacy callers */
  static scheduleNextCrash(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.marketCrash.nextCrashTime = null;
    newState.marketCrash.crashEndTime = null;
    return { newState, log: '' };
  }

  /** @deprecated Use WorldEventOrchestrator.devForceCrash */
  static forceCrash(state: GameState): { newState: GameState; log: string } {
    return this.activate(state, 3 * 60 * 1000);
  }

  /** @deprecated Use WorldEventOrchestrator */
  static triggerCrash(state: GameState, durationMs?: number): { newState: GameState; log: string } {
    return this.activate(state, durationMs);
  }

  /** @deprecated Use WorldEventOrchestrator */
  static endCrash(state: GameState): { newState: GameState; log: string } {
    return this.deactivate(state);
  }

  private static randomMs(minSec: number, maxSec: number): number {
    const min = Math.floor(minSec * 1000);
    const max = Math.floor(maxSec * 1000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
