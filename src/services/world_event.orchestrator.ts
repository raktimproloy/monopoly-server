import { BoardTile, GameState, WorldEventSchedule, WorldEventType } from '../types';
import { MarketCrashService } from './market_crash.service';
import { TrafficPoliceService } from './traffic_police.service';
import { toBanglaNum } from '../utils/format';

export class WorldEventOrchestrator {
  /**
   * Initializes unified world-event scheduling when a game starts or restarts.
   */
  static initOnGameStart(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    if (newState.settings.enableTrafficPolice === undefined) {
      newState.settings.enableTrafficPolice = true;
    }

    newState.marketCrash = {
      active: false,
      nextCrashTime: null,
      crashEndTime: null,
      crashCount: 0,
    };

    newState.trafficPolice = {
      active: false,
      position: null,
      nextAppearanceTime: null,
      disappearanceTime: null,
    };

    newState.worldEvents = {
      activeEvent: 'NONE',
      nextEventType: null,
      nextEventTime: null,
      cooldownUntil: null,
    };

    return this.scheduleFirstEvent(newState);
  }

  static scheduleFirstEvent(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    this.ensureWorldEventsShell(newState);

    const eventType = this.pickNextEventType(newState);
    if (!eventType) {
      return { newState, log: '' };
    }

    const delayMs = this.randomMs(4 * 60, 9 * 60) + this.randomMs(0, 90);
    newState.worldEvents!.nextEventType = eventType;
    newState.worldEvents!.nextEventTime = Date.now() + delayMs;
    newState.worldEvents!.cooldownUntil = null;
    newState.worldEvents!.activeEvent = 'NONE';

    this.syncLegacyTimers(newState);
    return { newState, log: '' };
  }

  static pickNextEventType(state: GameState): WorldEventType | null {
    const policeEnabled = state.settings.enableTrafficPolice !== false;
    if (!policeEnabled) return 'MARKET_CRASH';

    const crashCount = state.marketCrash?.crashCount ?? 0;
    const crashWeight = 40 + (crashCount % 5) * 10;
    const policeWeight = 100 - crashWeight;
    const roll = Math.random() * (crashWeight + policeWeight);
    return roll < crashWeight ? 'MARKET_CRASH' : 'TRAFFIC_POLICE';
  }

  static processTick(
    state: GameState,
    boardTiles: BoardTile[]
  ): { newState: GameState; log: string; changed: boolean } {
    let newState = this.ensureWorldEvents(state);
    const now = Date.now();
    const logs: string[] = [];
    let changed = false;

    if (!state.settings?.enableTrafficPolice && newState.worldEvents!.activeEvent === 'TRAFFIC_POLICE') {
      const despawned = TrafficPoliceService.despawn(newState);
      newState = despawned.newState;
      logs.push(despawned.log);
      const cooled = this.startCooldown(newState);
      newState = cooled.newState;
      changed = true;
    }

    if (
      newState.worldEvents!.activeEvent === 'MARKET_CRASH' &&
      newState.marketCrash.active &&
      newState.marketCrash.crashEndTime &&
      now >= newState.marketCrash.crashEndTime
    ) {
      const ended = MarketCrashService.deactivate(newState);
      newState = ended.newState;
      logs.push(ended.log);
      const cooled = this.startCooldown(newState);
      newState = cooled.newState;
      changed = true;
    }

    if (
      newState.worldEvents!.activeEvent === 'TRAFFIC_POLICE' &&
      newState.trafficPolice?.active &&
      newState.trafficPolice.disappearanceTime &&
      now >= newState.trafficPolice.disappearanceTime
    ) {
      const ended = TrafficPoliceService.despawn(newState);
      newState = ended.newState;
      logs.push(ended.log);
      const cooled = this.startCooldown(newState);
      newState = cooled.newState;
      changed = true;
    }

    if (
      newState.worldEvents!.activeEvent === 'NONE' &&
      newState.worldEvents!.cooldownUntil &&
      now >= newState.worldEvents!.cooldownUntil
    ) {
      const scheduled = this.endCooldownAndScheduleNext(newState);
      newState = scheduled.newState;
      changed = true;
    }

    if (
      newState.worldEvents!.activeEvent === 'NONE' &&
      !newState.worldEvents!.cooldownUntil &&
      newState.worldEvents!.nextEventTime &&
      now >= newState.worldEvents!.nextEventTime
    ) {
      const type = newState.worldEvents!.nextEventType;
      if (type === 'MARKET_CRASH') {
        const started = MarketCrashService.activate(newState);
        newState = started.newState;
        newState.worldEvents!.activeEvent = 'MARKET_CRASH';
        logs.push(started.log);
        changed = true;
      } else if (type === 'TRAFFIC_POLICE' && newState.settings.enableTrafficPolice !== false) {
        const started = TrafficPoliceService.spawn(newState, boardTiles);
        newState = started.newState;
        newState.worldEvents!.activeEvent = 'TRAFFIC_POLICE';
        logs.push(started.log);
        changed = true;
      }

      newState.worldEvents!.nextEventType = null;
      newState.worldEvents!.nextEventTime = null;
      this.syncLegacyTimers(newState);
    }

    return { newState, log: logs.filter(Boolean).join(' ').trim(), changed };
  }

  static devForceCrash(state: GameState): { newState: GameState; log: string } {
    let newState = this.ensureWorldEvents(state);
    newState = this.clearActiveEvent(newState).newState;

    const started = MarketCrashService.activate(newState, 3 * 60 * 1000);
    started.newState.worldEvents!.activeEvent = 'MARKET_CRASH';
    started.newState.worldEvents!.cooldownUntil = null;
    started.newState.worldEvents!.nextEventType = null;
    started.newState.worldEvents!.nextEventTime = null;
    this.syncLegacyTimers(started.newState);

    return started;
  }

  static devSetNextCrash(state: GameState, delayMinutes: number): { newState: GameState; log: string } {
    let newState = this.ensureWorldEvents(state);
    newState = this.clearActiveEvent(newState).newState;

    newState.worldEvents!.activeEvent = 'NONE';
    newState.worldEvents!.cooldownUntil = null;
    newState.worldEvents!.nextEventType = 'MARKET_CRASH';
    newState.worldEvents!.nextEventTime = Date.now() + delayMinutes * 60 * 1000;
    this.syncLegacyTimers(newState);

    return {
      newState,
      log: `মার্কেট ক্র্যাশ শিডিউল করা হয়েছে ${toBanglaNum(delayMinutes)} মিনিট পর।`,
    };
  }

  static devForcePolice(state: GameState, boardTiles: BoardTile[]): { newState: GameState; log: string } {
    let newState = this.ensureWorldEvents(state);
    newState = this.clearActiveEvent(newState).newState;

    const started = TrafficPoliceService.spawn(newState, boardTiles);
    started.newState.worldEvents!.activeEvent = 'TRAFFIC_POLICE';
    started.newState.worldEvents!.cooldownUntil = null;
    started.newState.worldEvents!.nextEventType = null;
    started.newState.worldEvents!.nextEventTime = null;
    this.syncLegacyTimers(started.newState);

    return started;
  }

  static devSetNextPolice(state: GameState, delayMinutes: number): { newState: GameState; log: string } {
    let newState = this.ensureWorldEvents(state);
    newState = this.clearActiveEvent(newState).newState;

    newState.worldEvents!.activeEvent = 'NONE';
    newState.worldEvents!.cooldownUntil = null;
    newState.worldEvents!.nextEventType = 'TRAFFIC_POLICE';
    newState.worldEvents!.nextEventTime = Date.now() + delayMinutes * 60 * 1000;
    this.syncLegacyTimers(newState);

    return {
      newState,
      log: `[DEV] পরবর্তী ট্রাফিক পুলিশ ${delayMinutes} মিনিট পর আসবে।`,
    };
  }

  private static clearActiveEvent(state: GameState): { newState: GameState } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.worldEvents) return { newState };

    if (newState.worldEvents.activeEvent === 'MARKET_CRASH' && newState.marketCrash.active) {
      newState.marketCrash.active = false;
      newState.marketCrash.crashEndTime = null;
    }

    if (newState.worldEvents.activeEvent === 'TRAFFIC_POLICE' && newState.trafficPolice?.active) {
      newState.trafficPolice.active = false;
      newState.trafficPolice.position = null;
      newState.trafficPolice.disappearanceTime = null;
    }

    newState.worldEvents.activeEvent = 'NONE';
    return { newState };
  }

  private static startCooldown(state: GameState): { newState: GameState } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.worldEvents!.activeEvent = 'NONE';
    newState.worldEvents!.cooldownUntil = Date.now() + this.randomMs(2.5 * 60, 5.5 * 60);
    newState.worldEvents!.nextEventType = null;
    newState.worldEvents!.nextEventTime = null;
    this.syncLegacyTimers(newState);
    return { newState };
  }

  private static endCooldownAndScheduleNext(state: GameState): { newState: GameState; log: string } {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const eventType = this.pickNextEventType(newState);

    newState.worldEvents!.cooldownUntil = null;

    if (!eventType) {
      return { newState, log: '' };
    }

    newState.worldEvents!.nextEventType = eventType;
    newState.worldEvents!.nextEventTime = Date.now() + this.randomMs(0, 90);
    this.syncLegacyTimers(newState);
    return { newState, log: '' };
  }

  private static ensureWorldEventsShell(state: GameState): void {
    if (!state.worldEvents) {
      state.worldEvents = {
        activeEvent: 'NONE',
        nextEventType: null,
        nextEventTime: null,
        cooldownUntil: null,
      };
    }
    if (!state.trafficPolice) {
      state.trafficPolice = {
        active: false,
        position: null,
        nextAppearanceTime: null,
        disappearanceTime: null,
      };
    }
  }

  private static ensureWorldEvents(state: GameState): GameState {
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (newState.worldEvents) {
      this.ensureWorldEventsShell(newState);
      return newState;
    }

    if (newState.settings.enableTrafficPolice === undefined) {
      newState.settings.enableTrafficPolice = true;
    }

    let activeEvent: WorldEventSchedule['activeEvent'] = 'NONE';
    if (newState.marketCrash?.active) activeEvent = 'MARKET_CRASH';
    else if (newState.trafficPolice?.active) activeEvent = 'TRAFFIC_POLICE';

    newState.worldEvents = {
      activeEvent,
      nextEventType: null,
      nextEventTime: null,
      cooldownUntil: null,
    };

    if (activeEvent === 'NONE') {
      const crashNext = newState.marketCrash?.nextCrashTime;
      const policeNext = newState.trafficPolice?.nextAppearanceTime;

      if (crashNext && policeNext) {
        if (crashNext <= policeNext) {
          newState.worldEvents.nextEventType = 'MARKET_CRASH';
          newState.worldEvents.nextEventTime = crashNext;
        } else {
          newState.worldEvents.nextEventType = 'TRAFFIC_POLICE';
          newState.worldEvents.nextEventTime = policeNext;
        }
      } else if (crashNext) {
        newState.worldEvents.nextEventType = 'MARKET_CRASH';
        newState.worldEvents.nextEventTime = crashNext;
      } else if (policeNext) {
        newState.worldEvents.nextEventType = 'TRAFFIC_POLICE';
        newState.worldEvents.nextEventTime = policeNext;
      }
    }

    this.syncLegacyTimers(newState);
    return newState;
  }

  static syncLegacyTimers(state: GameState): void {
    this.ensureWorldEventsShell(state);
    state.marketCrash.nextCrashTime = null;
    state.trafficPolice!.nextAppearanceTime = null;

    if (state.worldEvents!.nextEventType === 'MARKET_CRASH' && state.worldEvents!.nextEventTime) {
      state.marketCrash.nextCrashTime = state.worldEvents!.nextEventTime;
    } else if (state.worldEvents!.nextEventType === 'TRAFFIC_POLICE' && state.worldEvents!.nextEventTime) {
      state.trafficPolice!.nextAppearanceTime = state.worldEvents!.nextEventTime;
    }
  }

  private static randomMs(minSec: number, maxSec: number): number {
    const min = Math.floor(minSec * 1000);
    const max = Math.floor(maxSec * 1000);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
}
