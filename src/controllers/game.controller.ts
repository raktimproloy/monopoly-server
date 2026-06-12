import { Server, Socket } from 'socket.io';
import { GameService } from '../services/game.service';
import { logger } from '../utils/logger';
import {
  antiCheatGuard,
  RollDiceSchema,
  BuyPropertySchema,
  EndTurnSchema,
  DeclareBankruptcySchema,
  PayJailFineSchema,
  TradeOfferSchema,
  TradeResponseSchema
} from '../middleware/socketValidation';
import { TradeOfferPayload } from '../../../shared/types';

// Simple active trade tracker for negotiation mapping
const activeTrades: Record<string, TradeOfferPayload> = {};

export class GameController {
  private io: Server;
  private gameService: GameService;

  constructor(io: Server) {
    this.io = io;
    this.gameService = new GameService();
  }

  /**
   * Registers room event listeners for a newly connected socket.
   */
  public registerConnection(socket: Socket) {
    const userId = socket.data?.userId as string;
    logger.info(`User socket connected: ${socket.id} (userId: ${userId})`);

    // --- 1. Join Room Event ---
    socket.on('join_room', async ({ roomId, name, avatar }: { roomId: string; name: string; avatar: string }) => {
      try {
        if (!roomId || !name) {
          return socket.emit('error_message', 'Invalid Room ID or Player Name');
        }

        // Join socket.io room channel for room-isolated broadcasts
        await socket.join(roomId);
        logger.info(`Socket ${socket.id} joined room channel: ${roomId}`);

        const state = await this.gameService.joinRoom(roomId, {
          id: userId,
          name,
          avatar: avatar || '#00F5FF'
        });

        // Broadcast player join to other room members
        socket.to(roomId).emit('player_joined', { userId, name, avatar });
        
        // Broadcast full state update to update existing player screens in lobby
        this.io.to(roomId).emit('state_updated', { state, log: `${name} entered the lobby.` });

        // Send current game state and dynamic board configuration to newly connected client
        const boardTemplate = await this.gameService.loadBoardTemplate();
        socket.emit('room_initialized', {
          state,
          board: boardTemplate.tiles
        });

      } catch (err: any) {
        logger.error(`Error in join_room for socket ${socket.id}`, err);
        socket.emit('error_message', err.message || 'Failed to join room');
      }
    });

    // --- 1.1 Update Settings Event ---
    socket.on('update_settings', async (payload: { settings: any; playerId: string }) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { settings, playerId } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const updatedState = await this.gameService.updateSettings(roomId, settings, playerId);
        this.io.to(roomId).emit('state_updated', {
          state: updatedState,
          log: `Lobby rules updated.`
        });
      } catch (err: any) {
        logger.error(`Error in update_settings for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to update settings');
      }
    });

    // --- 1.2 Start Game Event ---
    socket.on('start_game', async (payload: { playerId: string }) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const updatedState = await this.gameService.startGame(roomId, playerId);
        this.io.to(roomId).emit('state_updated', {
          state: updatedState,
          log: `Tactical matrix compiled! Match started.`
        });
      } catch (err: any) {
        logger.error(`Error in start_game for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to start game');
      }
    });

    // --- 2. Roll Dice Event ---
    socket.on('roll_dice', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        // Validation Layer 1: Schema validation
        const parsed = RollDiceSchema.parse(payload);
        const { playerId } = parsed;

        // Validation Layer 2: Socket Identity verification
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        // Validation Layer 3: Room membership and Turn validation
        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        // State update orchestration
        const { state: updatedState, log } = await this.gameService.rollDice(roomId, playerId);

        // Broadcast update to all clients in the room
        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in roll_dice for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 3. Buy Property Event ---
    socket.on('buy_property', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const membershipCheck = antiCheatGuard.verifyMembership(state, playerId);
        if (!membershipCheck.valid) return socket.emit('error_message', membershipCheck.error);

        // Execute action
        const { state: updatedState, log } = await this.gameService.buyProperty(roomId, playerId, tileIndex);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in buy_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 4. Mortgage Property Event ---
    socket.on('mortgage_property', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload); // re-uses same structure (playerId, tileIndex)
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const { state: updatedState, log } = await this.gameService.mortgageProperty(roomId, playerId, tileIndex);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in mortgage_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5. Unmortgage Property Event ---
    socket.on('unmortgage_property', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.unmortgageProperty(roomId, playerId, tileIndex);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in unmortgage_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 6. Propose Trade Event ---
    socket.on('propose_trade', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const offer = TradeOfferSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, offer.senderId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        // Verify receiver belongs to same game
        const receiverCheck = antiCheatGuard.verifyMembership(state, offer.receiverId);
        if (!receiverCheck.valid) return socket.emit('error_message', receiverCheck.error);

        // If duration is provided, calculate expiration
        if (offer.durationSeconds && offer.durationSeconds > 0) {
          offer.expiresAt = Date.now() + offer.durationSeconds * 1000;
        }

        // Create random trade ID
        const tradeId = `trade_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        activeTrades[tradeId] = offer;

        logger.info(`Trade proposed in room ${roomId}: ${tradeId} from ${offer.senderId} to ${offer.receiverId} with duration ${offer.durationSeconds || 'infinite'}s`);

        // Forward proposal to room (broadcast so everyone receives it and can track countdown/expiry)
        this.io.to(roomId).emit('trade_proposed', {
          tradeId,
          offer
        });

        // Set server-side auto-expiry timeout
        if (offer.durationSeconds && offer.durationSeconds > 0) {
          setTimeout(async () => {
            if (activeTrades[tradeId]) {
              delete activeTrades[tradeId];
              const latestState = await this.gameService.getRoomState(roomId);
              const senderName = latestState?.players[offer.senderId]?.name || 'Player';
              const receiverName = latestState?.players[offer.receiverId]?.name || 'Player';
              const log = `Trade proposal between ${senderName} and ${receiverName} has expired.`;
              
              logger.info(`Trade ${tradeId} expired in room ${roomId}`);
              this.io.to(roomId).emit('trade_declined', { tradeId, log });
              this.io.to(roomId).emit('trade_resolved', { tradeId });
            }
          }, offer.durationSeconds * 1000);
        }

      } catch (err: any) {
        logger.error(`Error in propose_trade for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Trade validation error');
      }
    });

    // --- 7. Respond To Trade Event ---
    socket.on('respond_to_trade', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, tradeId, accept } = TradeResponseSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const offer = activeTrades[tradeId];
        if (!offer) return socket.emit('error_message', 'Trade offer expired or does not exist.');

        if (offer.receiverId !== playerId) {
          return socket.emit('error_message', 'Unauthorized. You are not the receiver of this trade.');
        }

        // Clean trade record
        delete activeTrades[tradeId];

        if (accept) {
          // Execute state mutation transaction
          const { state: updatedState, log } = await this.gameService.executeTrade(roomId, offer);
          this.io.to(roomId).emit('state_updated', { state: updatedState, log });
          this.io.to(roomId).emit('trade_resolved', { tradeId });
        } else {
          // Emit trade refusal event
          const state = await this.gameService.getRoomState(roomId);
          const senderName = state?.players[offer.senderId]?.name || 'Player';
          const receiverName = state?.players[offer.receiverId]?.name || 'Player';
          const log = `${receiverName} declined the trade offer from ${senderName}.`;
          
          logger.info(`Trade ${tradeId} declined: ${log}`);
          this.io.to(roomId).emit('trade_declined', { tradeId, log });
          this.io.to(roomId).emit('trade_resolved', { tradeId });
        }

      } catch (err: any) {
        logger.error(`Error in respond_to_trade for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Trade processing error');
      }
    });

    // --- 8. End Turn Event ---
    socket.on('end_turn', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = EndTurnSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        // Turn status assertion (cannot end turn without moving, unless in jail)
        if (state.turnStatus === 'MUST_ROLL') {
          return socket.emit('error_message', 'You must roll the dice before ending your turn.');
        }

        const { state: updatedState, log } = await this.gameService.endTurn(roomId, playerId);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in end_turn for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 8.5 Declare Bankruptcy Event ---
    socket.on('declare_bankruptcy', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = DeclareBankruptcySchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        const { state: updatedState, log } = await this.gameService.declareBankruptcy(roomId, playerId);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in declare_bankruptcy for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Bankruptcy declaration failed');
      }
    });

    // --- 8.6 Pay Jail Fine Event ---
    socket.on('pay_jail_fine', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = PayJailFineSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        const { state: updatedState, log } = await this.gameService.payJailFine(roomId, playerId);

        this.io.to(roomId).emit('state_updated', { state: updatedState, log });

      } catch (err: any) {
        logger.error(`Error in pay_jail_fine for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Jail fine payment failed');
      }
    });

    // --- 9. Disconnect Event ---
    socket.on('disconnect', () => {
      logger.info(`User socket disconnected: ${socket.id} (userId: ${userId})`);
    });
  }

  /**
   * Helper to retrieve room membership of the socket connection.
   */
  private getSocketRoom(socket: Socket): string | null {
    // Standard approach: socket rooms contains socket ID itself and any room channels joined
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
    return rooms.length > 0 ? rooms[0] : null;
  }
}
