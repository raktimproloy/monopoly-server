import { GameState } from '../types';
import { generateLog } from '../utils/logGenerator';
import { toBanglaNum } from '../utils/format';

export class MarketCrashService {
  /**
   * Defines the random timings for the market crash based on crash count.
   * Crash 1: Starts in 3-7 mins. Lasts 1-3 mins.
   * Crash 2: Starts in 15-20 mins. Lasts 3-5 mins.
   * Crash 3+: Starts in 30-40 mins. Lasts 3-5 mins.
   */
  static getNextCrashTimings(crashCount: number): { delayMs: number; durationMs: number } {
    let delayMins: number;
    let durationMins: number;

    if (crashCount === 0) {
      delayMins = this.randomBetween(3, 7);
      durationMins = this.randomBetween(1, 3);
    } else if (crashCount === 1) {
      delayMins = this.randomBetween(15, 20);
      durationMins = this.randomBetween(3, 5);
    } else {
      delayMins = this.randomBetween(30, 40);
      durationMins = this.randomBetween(3, 5);
    }

    return {
      delayMs: delayMins * 60 * 1000,
      durationMs: durationMins * 60 * 1000
    };
  }

  static scheduleNextCrash(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (newState.marketCrash.crashCount >= 3) {
      newState.marketCrash.nextCrashTime = null;
      newState.marketCrash.crashEndTime = null;
      return { newState, log: '' };
    }

    const timings = this.getNextCrashTimings(newState.marketCrash.crashCount);
    newState.marketCrash.nextCrashTime = Date.now() + timings.delayMs;
    // We store the calculated duration in crashEndTime temporarily (as an offset) until it becomes active,
    // actually it's better to store duration somewhere or just compute it when crash starts.
    // Let's store the duration in crashEndTime as negative or just let it be null, 
    // but we need to know the duration when it triggers.
    // Instead of adding a new field, let's just recalculate duration when it triggers, it's fine.
    
    // We will just let the trigger function decide the duration based on crashCount.
    newState.marketCrash.crashEndTime = null; 

    return { newState, log: `মার্কেট ক্র্যাশের পূর্বাভাস পাওয়া গেছে।` };
  }

  static triggerCrash(state: GameState, durationMs?: number): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    
    if (newState.marketCrash.crashCount >= 3 && !durationMs) {
       return { newState, log: '' };
    }

    let actualDurationMs = durationMs;
    if (!actualDurationMs) {
      const timings = this.getNextCrashTimings(newState.marketCrash.crashCount);
      actualDurationMs = timings.durationMs;
    }

    newState.marketCrash.active = true;
    newState.marketCrash.nextCrashTime = null;
    newState.marketCrash.crashEndTime = Date.now() + actualDurationMs;
    newState.marketCrash.crashCount += 1;

    return { 
      newState, 
      log: `🚨 মার্কেট ক্র্যাশ শুরু হয়েছে! জমির দাম ৩০% কমে গেছে এবং ভাড়া ৪০% বেড়ে গেছে।` 
    };
  }

  static endCrash(state: GameState): { newState: GameState; log: string } {
    let { newState } = this.scheduleNextCrash(state);
    newState.marketCrash.active = false;
    newState.marketCrash.crashEndTime = null;

    return { 
      newState, 
      log: `✅ মার্কেট ক্র্যাশ শেষ হয়েছে। বাজার স্বাভাবিক অবস্থায় ফিরেছে।` 
    };
  }

  static forceCrash(state: GameState): { newState: GameState; log: string } {
    return this.triggerCrash(state, 3 * 60 * 1000); // Default 3 min for dev force
  }

  static devSetNextCrash(state: GameState, delayMinutes: number): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.marketCrash.nextCrashTime = Date.now() + delayMinutes * 60 * 1000;
    newState.marketCrash.active = false;
    newState.marketCrash.crashEndTime = null;
    return { newState, log: `মার্কেট ক্র্যাশ শিডিউল করা হয়েছে ${toBanglaNum(delayMinutes)} মিনিট পর।` };
  }

  /**
   * Check if state needs to transition based on current time.
   */
  static processTimers(state: GameState): { newState: GameState; log: string; changed: boolean } {
    const now = Date.now();
    let changed = false;
    let currentLog = '';

    if (state.marketCrash.active && state.marketCrash.crashEndTime && now >= state.marketCrash.crashEndTime) {
      const res = this.endCrash(state);
      return { newState: res.newState, log: res.log, changed: true };
    }

    if (!state.marketCrash.active && state.marketCrash.nextCrashTime && now >= state.marketCrash.nextCrashTime) {
      const res = this.triggerCrash(state);
      return { newState: res.newState, log: res.log, changed: true };
    }

    return { newState: state, log: '', changed: false };
  }

  private static randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }
}
