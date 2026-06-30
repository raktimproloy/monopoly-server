import { EventEmitter } from 'events';
import { GameState } from '../types';
import { gameStateStore, StoredRoom } from '../state/GameStateStore';
import { cloneState, createStateDelta } from '../state/delta';
import { logger } from '../utils/logger';

export interface StateUpdateEvent {
  roomId: string;
  previousState: GameState;
  state: GameState;
  version: number;
  log: string;
  playerId: string;
  actionType: string;
  actionPayload: unknown;
}

/**
 * High-level room lifecycle + authoritative state mutations.
 * All active gameplay reads/writes go through here (backed by Redis).
 */
export class RoomManager extends EventEmitter {
  /** Commit a new authoritative snapshot with optimistic locking. */
  async commitUpdate(
    roomId: string,
    newState: GameState,
    meta: {
      playerId: string;
      actionType: string;
      actionPayload: unknown;
      log: string;
    }
  ): Promise<StateUpdateEvent> {
    const record = await gameStateStore.get(roomId);
    if (!record) {
      throw new Error(`Room ${roomId} does not exist in active store.`);
    }

    const previousState = cloneState(record.state);
    const normalized = this.normalizeTurnStatus(cloneState(newState));

    const version = await gameStateStore.save(
      roomId,
      normalized,
      record.version,
      record.templateId
    );

    logger.game(roomId, meta.actionType, meta.playerId, meta.log);

    const event: StateUpdateEvent = {
      roomId,
      previousState,
      state: normalized,
      version,
      log: meta.log,
      playerId: meta.playerId,
      actionType: meta.actionType,
      actionPayload: meta.actionPayload,
    };

    this.emit('stateUpdated', event);
    return event;
  }

  async getState(roomId: string): Promise<GameState | null> {
    return gameStateStore.getState(roomId);
  }

  async getRecord(roomId: string): Promise<StoredRoom | null> {
    return gameStateStore.get(roomId);
  }

  async createRoom(roomId: string, state: GameState, templateId: number): Promise<StoredRoom> {
    return gameStateStore.create(roomId, state, templateId);
  }

  async deleteRoom(roomId: string): Promise<StoredRoom | null> {
    return gameStateStore.delete(roomId);
  }

  /** Preview delta size without persisting (used by broadcaster tests). */
  previewDelta(previous: GameState, next: GameState) {
    return createStateDelta(previous, next);
  }

  private normalizeTurnStatus(newState: GameState): GameState {
    const currentTurnPlayer = newState.players[newState.currentTurnPlayerId];
    if (!currentTurnPlayer) return newState;

    const owesRent =
      newState.pendingRentOwed?.debtorId === newState.currentTurnPlayerId &&
      (newState.pendingRentOwed?.remainingAmount ?? 0) > 0;

    if (newState.turnStatus === 'BANKRUPTCY_PENDING' && currentTurnPlayer.balance >= 0 && !owesRent) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    } else if (newState.turnStatus === 'MUST_ACT_OR_END' && (currentTurnPlayer.balance < 0 || owesRent)) {
      newState.turnStatus = 'BANKRUPTCY_PENDING';
    }

    return newState;
  }
}

/** Process-wide singleton — shared by RoomService and broadcast layer. */
export const roomManager = new RoomManager();
