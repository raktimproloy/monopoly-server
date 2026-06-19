import { Socket } from 'socket.io';
import { z } from 'zod';
import { GameState } from '../types';
import { logger } from '../utils/logger';

// 1. Define Zod schemas for client event payloads (type-safety layer)
export const RollDiceSchema = z.object({
  playerId: z.string().min(1),
});

export const BuyPropertySchema = z.object({
  playerId: z.string().min(1),
  tileIndex: z.number().int().min(0).max(39),
});

export const DevTeleportSchema = z.object({
  playerId: z.string().min(1),
  targetIndex: z.number().int().min(0).max(39),
});

export const DevRollDiceSchema = z.object({
  playerId: z.string().min(1),
  d1: z.number().int().min(1).max(6),
  d2: z.number().int().min(1).max(6),
});

export const EndTurnSchema = z.object({
  playerId: z.string().min(1),
});

export const DeclareBankruptcySchema = z.object({
  playerId: z.string().min(1),
});

export const PayJailFineSchema = z.object({
  playerId: z.string().min(1),
});

export const CastKickVoteSchema = z.object({
  playerId: z.string().min(1),
  targetPlayerId: z.string().min(1).nullable(),
});

export const RestartGameSchema = z.object({
  playerId: z.string().min(1),
});

export const TradeOfferSchema = z.object({
  senderId: z.string().min(1),
  receiverId: z.string().min(1),
  offerCash: z.number().nonnegative(),
  requestCash: z.number().nonnegative(),
  offerPropertyIndexes: z.array(z.number().int().min(0).max(39)),
  requestPropertyIndexes: z.array(z.number().int().min(0).max(39)),
  durationSeconds: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative().optional(),
});

export const TradeResponseSchema = z.object({
  playerId: z.string().min(1),
  tradeId: z.string().min(1),
  accept: z.boolean(),
});

/**
 * Socket.io Connection Middleware
 * Validates connection handshake parameters (e.g., authentication, basic validation)
 */
export function socketConnectionGuard(socket: Socket, next: (err?: Error) => void) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  const userId = socket.handshake.auth?.userId || socket.handshake.query?.userId;

  if (!userId) {
    logger.warn(`Rejected socket connection: Missing userId`);
    return next(new Error('Authentication failed: Missing userId'));
  }

  // Bind userId to socket context for downstream security checks
  socket.data = socket.data || {};
  socket.data.userId = userId;
  next();
}

/**
 * Domain Anti-Cheat Middleware / Helper
 * Checks state requirements before permitting mutations (e.g., turn checks)
 */
export const antiCheatGuard = {
  /**
   * Asserts that the incoming event is from the player whose turn it currently is.
   */
  verifyTurn(state: GameState, socketPlayerId: string): { valid: boolean; error?: string } {
    if (state.gameStatus !== 'ACTIVE') {
      return { valid: false, error: 'Game is not active.' };
    }

    if (state.currentTurnPlayerId !== socketPlayerId) {
      return {
        valid: false,
        error: `Action rejected. It is currently ${state.players[state.currentTurnPlayerId]?.name || 'another player'}'s turn.`
      };
    }

    const player = state.players[socketPlayerId];
    if (!player || player.isBankrupt) {
      return { valid: false, error: 'Player is either invalid or bankrupt.' };
    }

    return { valid: true };
  },

  /**
   * Asserts the player belongs to the game room context.
   */
  verifyMembership(state: GameState, socketPlayerId: string): { valid: boolean; error?: string } {
    if (!state.players[socketPlayerId]) {
      return { valid: false, error: 'You are not a player in this game room.' };
    }
    return { valid: true };
  },

  /**
   * Enforces matching socket connection metadata with request payload.
   * Prevents players from spoofing other players' actions.
   */
  verifySocketIdentity(socket: Socket, payloadPlayerId: string): { valid: boolean; error?: string } {
    const connectedUserId = socket.data?.userId;
    if (connectedUserId !== payloadPlayerId) {
      logger.warn(`Spoofing attempt detected! Socket user ${connectedUserId} tried to act as player ${payloadPlayerId}`);
      return { valid: false, error: 'Security violation: Action sender identity mismatch.' };
    }
    return { valid: true };
  }
};
