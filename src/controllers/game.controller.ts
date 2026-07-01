import { Server, Socket } from 'socket.io';
import { GameService } from '../services/game.service';
import { RoomBroadcaster } from '../broadcast/RoomBroadcaster';
import { logger } from '../utils/logger';
import {
  antiCheatGuard,
  RollDiceSchema,
  BuyPropertySchema,
  DevTeleportSchema,
  DevRollDiceSchema,
  EndTurnSchema,
  DeclareBankruptcySchema,
  PayJailFineSchema,
  CastKickVoteSchema,
  RestartGameSchema,
  TradeOfferSchema,
  TradeResponseSchema,
  CancelTradeSchema
} from '../middleware/socketValidation';
import { TradeOfferPayload } from '../types';

// Per-trade expiry timers keyed by roomId:tradeId
const tradeExpiryTimers: Record<string, NodeJS.Timeout> = {};

// Maps socket.id → roomId for fast lookup on disconnect
const socketRoomMap: Record<string, string> = {};

// Per-room player ping (ms RTT) reported by each client
const roomPlayerPings: Record<string, Record<string, number>> = {};

// Tracks last activity timestamp per room for inactivity TTL
const roomActivity: Record<string, number> = {};

// Inactivity timeout: rooms with no activity for 30 minutes are auto-deleted
const ROOM_INACTIVITY_TTL_MS = 30 * 60 * 1000;
// Finished game cleanup: delete finished games after 5 minutes
const FINISHED_ROOM_TTL_MS = 5 * 60 * 1000;

export class GameController {
  private io: Server;
  private gameService: GameService;
  private broadcaster: RoomBroadcaster;

  constructor(io: Server, broadcaster: RoomBroadcaster) {
    this.io = io;
    this.broadcaster = broadcaster;
    this.gameService = new GameService();

    // Start periodic room cleanup sweep every 5 minutes
    setInterval(() => this.cleanupInactiveRooms(), 5 * 60 * 1000);
    // Start game timer ticker every 5 seconds (market crash, police, etc)
    setInterval(() => this.tickGameTimers(), 5 * 1000);
    logger.info('Room lifecycle manager initialized (TTL: 30min inactivity, 5min post-finish)');
  }

  /**
   * Processes all game timers (market crash, traffic police) for all active rooms.
   */
  private async tickGameTimers() {
    const roomIds = Object.keys(roomActivity);
    for (const roomId of roomIds) {
      try {
        const result = await this.gameService.processGameTimers(roomId);
        if (result) {
          this.processBotTurn(roomId, result.state);
        }
      } catch (err) {
        logger.error(`Error processing game timers for room ${roomId}`, err);
      }
    }
  }

  /**
   * Periodic sweep to remove stale/inactive rooms from memory.
   */
  private async cleanupInactiveRooms() {
    const now = Date.now();
    const roomIds = Object.keys(roomActivity);

    for (const roomId of roomIds) {
      const lastActive = roomActivity[roomId];
      const state = await this.gameService.getRoomState(roomId);

      if (!state) {
        // Room already deleted elsewhere, clean up tracking
        delete roomActivity[roomId];
        continue;
      }

      const isFinished = state.gameStatus === 'FINISHED';
      const ttl = isFinished ? FINISHED_ROOM_TTL_MS : ROOM_INACTIVITY_TTL_MS;

      if (now - lastActive > ttl) {
        logger.info(`Auto-deleting ${isFinished ? 'finished' : 'inactive'} room ${roomId} (idle ${Math.round((now - lastActive) / 1000)}s)`);
        await this.gameService.deleteRoom(roomId);
        delete roomActivity[roomId];

        // Notify any remaining sockets in this room
        this.io.to(roomId).emit('room_expired', {
          reason: isFinished ? 'Game has ended.' : 'Room closed due to inactivity.'
        });
      }
    }
  }

  private activeAuctionsTimeout: Record<string, NodeJS.Timeout> = {};

  private startAuctionTimer(roomId: string, endTime: number) {
    if (this.activeAuctionsTimeout[roomId]) {
      clearTimeout(this.activeAuctionsTimeout[roomId]);
    }
    const delay = endTime - Date.now();
    this.activeAuctionsTimeout[roomId] = setTimeout(async () => {
      try {
        const { state, log } = await this.gameService.resolveAuction(roomId);
        delete this.activeAuctionsTimeout[roomId];
      } catch (err) {
        logger.error(`Error resolving auction for room ${roomId}`, err);
      }
    }, delay > 0 ? delay : 0);
  }

  private tradeTimerKey(roomId: string, tradeId: string): string {
    return `${roomId}:${tradeId}`;
  }

  private clearTradeExpiryTimer(roomId: string, tradeId: string): void {
    const key = this.tradeTimerKey(roomId, tradeId);
    if (tradeExpiryTimers[key]) {
      clearTimeout(tradeExpiryTimers[key]);
      delete tradeExpiryTimers[key];
    }
  }

  private scheduleTradeExpiry(roomId: string, tradeId: string, delayMs: number): void {
    const key = this.tradeTimerKey(roomId, tradeId);
    this.clearTradeExpiryTimer(roomId, tradeId);
    tradeExpiryTimers[key] = setTimeout(async () => {
      delete tradeExpiryTimers[key];
      try {
        await this.gameService.expireTrade(roomId, tradeId);
      } catch (err) {
        logger.error(`Error expiring trade ${tradeId} in room ${roomId}`, err);
      }
    }, delayMs > 0 ? delayMs : 0);
  }

  /**
   * Updates the last activity timestamp for a room.
   */
  private touchRoom(roomId: string) {
    roomActivity[roomId] = Date.now();
  }

  /**
   * Registers room event listeners for a newly connected socket.
   */
  public registerConnection(socket: Socket) {
    const userId = socket.data?.userId as string;
    logger.info(`User socket connected: ${socket.id} (userId: ${userId})`);

    // --- Ping / latency ---
    socket.on('ping_check', (_sentAt: number, callback?: () => void) => {
      if (typeof callback === 'function') callback();
    });

    socket.on('report_ping', ({ roomId, playerId, ping }: { roomId: string; playerId: string; ping: number }) => {
      if (!roomId || !playerId || typeof ping !== 'number') return;
      if (!roomPlayerPings[roomId]) roomPlayerPings[roomId] = {};
      const rounded = Math.round(ping);
      const previous = roomPlayerPings[roomId][playerId];
      roomPlayerPings[roomId][playerId] = rounded;
      // Only fan-out to the room when the value moved meaningfully — avoids a
      // full-room broadcast every few seconds for negligible jitter.
      if (previous === undefined || Math.abs(previous - rounded) >= 15) {
        this.io.to(roomId).emit('player_pings_updated', roomPlayerPings[roomId]);
      }
    });

    // --- 1. Join Room Event ---
    socket.on('join_room', async ({ roomId, name, avatar }: { roomId: string; name: string; avatar: string }) => {
      try {
        if (!roomId || !name) {
          return socket.emit('error_message', 'Invalid Room ID or Player Name');
        }

        // Join socket.io room channel for room-isolated broadcasts
        await socket.join(roomId);
        await this.broadcaster.subscribeRoom(roomId);
        logger.info(`Socket ${socket.id} joined room channel: ${roomId}`);
        
        this.touchRoom(roomId);

        const state = await this.gameService.joinRoom(roomId, {
          id: userId,
          name,
          avatar: avatar || '#00F5FF'
        });

        // Broadcast player join to other room members
        socket.to(roomId).emit('player_joined', { userId, name, avatar });
        
        // Broadcast full state update to update existing player screens in lobby

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

    // --- 1.05 Add Bot Event ---
    socket.on('add_bot', async () => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const state = await this.gameService.getRoomState(roomId);
        if (!state) return;
        if (state.gameStatus !== 'LOBBY') {
          return socket.emit('error_message', 'Game already started');
        }
        const botId = `bot_${Math.random().toString(36).substring(2, 9)}`;
        const botName = `Bot ${Object.keys(state.players).length}`;
        const AVATAR_COLORS = ['#ffffff', '#8b5cf6', '#14b8a6', '#a3e635', '#d946ef', '#94a3b8', '#e0b0ff', '#00fa9a'];
        const botAvatar = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
        
        const updatedState = await this.gameService.joinRoom(roomId, {
          id: botId,
          name: botName,
          avatar: botAvatar
        });
      } catch (err: any) {
        logger.error(`Error in add_bot for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to add bot');
      }
    });

    // --- 1.06 Get Room Details Event ---
    socket.on('get_room_details', async ({ roomId }: { roomId: string }, callback: (data: any) => void) => {
      try {
        if (!roomId) {
          return callback({ error: 'Invalid Room ID' });
        }
        const state = await this.gameService.getRoomState(roomId);
        if (!state) {
          return callback({ exists: false, players: [] });
        }
        const players = Object.values(state.players).map(p => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar
        }));
        callback({
          exists: true,
          gameStatus: state.gameStatus,
          players
        });
      } catch (err: any) {
        logger.error(`Error in get_room_details for room ${roomId}`, err);
        callback({ error: err.message || 'Failed to get room details' });
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
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in start_game for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to start game');
      }
    });

    // --- 1.3 Kick Player from Lobby Event ---
    socket.on('kick_player_from_lobby', async (payload: { playerId: string, targetId: string }) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, targetId } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');
        if (state.gameStatus !== 'LOBBY') return socket.emit('error_message', 'Can only kick players from the lobby.');

        const { state: updatedState, log } = await this.gameService.kickPlayerFromLobby(roomId, playerId, targetId);
        this.io.to(targetId).emit('kicked_from_lobby');

      } catch (err: any) {
        logger.error(`Error in kick_player_from_lobby for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to kick player');
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
        this.processBotTurn(roomId, updatedState);

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
        this.processBotTurn(roomId, updatedState);

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

      } catch (err: any) {
        logger.error(`Error in unmortgage_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.1 Build House Event ---
    socket.on('build_house', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.buildHouse(roomId, playerId, tileIndex);
      } catch (err: any) {
        logger.error(`Error in build_house for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.2 Sell House Event ---
    socket.on('sell_house', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.sellHouse(roomId, playerId, tileIndex);
      } catch (err: any) {
        logger.error(`Error in sell_house for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.3 Sell Property Event ---
    socket.on('sell_property', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.sellProperty(roomId, playerId, tileIndex);
      } catch (err: any) {
        logger.error(`Error in sell_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.4 Auction Property Event ---
    socket.on('auction_property', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = BuyPropertySchema.parse(payload);
        const { playerId, tileIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.auctionProperty(roomId, playerId, tileIndex);
        this.startAuctionTimer(roomId, (updatedState as any).activeAuction.endTime);
      } catch (err: any) {
        logger.error(`Error in auction_property for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.5 Place Bid Event ---
    socket.on('place_bid', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, amountToAdd } = payload;
        
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.placeBid(roomId, playerId, amountToAdd);
        this.startAuctionTimer(roomId, (updatedState as any).activeAuction.endTime);
      } catch (err: any) {
        logger.error(`Error in place_bid for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });
    // --- 6. Propose Trade Event ---
    socket.on('propose_trade', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = TradeOfferSchema.parse(payload);
        const { replacesTradeId, ...offerFields } = parsed;
        const offer = offerFields as TradeOfferPayload;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, offer.senderId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const receiverCheck = antiCheatGuard.verifyMembership(state, offer.receiverId);
        if (!receiverCheck.valid) return socket.emit('error_message', receiverCheck.error);

        const { tradeId, expiresAt } = await this.gameService.proposeTrade(roomId, offer, replacesTradeId);

        if (replacesTradeId) {
          this.clearTradeExpiryTimer(roomId, replacesTradeId);
        }

        if (expiresAt) {
          const delayMs = Math.max(0, expiresAt - Date.now());
          this.scheduleTradeExpiry(roomId, tradeId, delayMs);
        }

      } catch (err: any) {
        logger.error(`Error in propose_trade for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Trade validation error');
      }
    });

    // --- 6b. Cancel Trade Event ---
    socket.on('cancel_trade', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, tradeId } = CancelTradeSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        await this.gameService.cancelTrade(roomId, tradeId, playerId);
        this.clearTradeExpiryTimer(roomId, tradeId);
      } catch (err: any) {
        logger.error(`Error in cancel_trade for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Trade cancel error');
      }
    });

    // --- 5.6 Dev Teleport Event ---
    socket.on('dev_teleport', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = DevTeleportSchema.parse(payload);
        const { playerId, targetIndex } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        const { state: updatedState, log } = await this.gameService.devTeleport(roomId, playerId, targetIndex);
      } catch (err: any) {
        logger.error(`Error in dev_teleport for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.8 Dev Add Funds Event ---
    socket.on('dev_add_funds', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, amount } = payload;
        if (!playerId || typeof amount !== 'number') {
          return socket.emit('error_message', 'Invalid payload for dev_add_funds');
        }

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        const { state: updatedState, log } = await this.gameService.devAddFunds(roomId, playerId, amount);
      } catch (err: any) {
        logger.error(`Error in dev_add_funds for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.7 Dev Force Roll Event ---
    socket.on('dev_roll_dice', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const parsed = DevRollDiceSchema.parse(payload);
        const { playerId, d1, d2 } = parsed;

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const turnCheck = antiCheatGuard.verifyTurn(state, playerId);
        if (!turnCheck.valid) return socket.emit('error_message', turnCheck.error);

        const { state: updatedState, log } = await this.gameService.devRollDice(roomId, playerId, d1, d2);
      } catch (err: any) {
        logger.error(`Error in dev_roll_dice for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.9 Dev Force Crash Event ---
    socket.on('dev_force_crash', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.devForceCrash(roomId, playerId);
      } catch (err: any) {
        logger.error(`Error in dev_force_crash for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.10 Dev Set Next Crash Event ---
    socket.on('dev_set_next_crash', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, delayMinutes } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.devSetNextCrash(roomId, playerId, delayMinutes);
      } catch (err: any) {
        logger.error(`Error in dev_set_next_crash for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.11 Dev Give Power Card Event ---
    socket.on('dev_give_power_card', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, cardType } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.devGivePowerCard(roomId, playerId, cardType);
      } catch (err: any) {
        logger.error(`Error in dev_give_power_card for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 5.12 Use Power Card Event ---
    socket.on('use_power_card', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, cardType, actionPayload } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.usePowerCard(roomId, playerId, cardType, actionPayload);
      } catch (err: any) {
        logger.error(`Error in use_power_card for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    socket.on('dev_force_police', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);
        
        const { state: updatedState, log } = await this.gameService.devForcePolice(roomId, playerId);
      } catch (err: any) {
        logger.error(`Error in dev_force_police for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    socket.on('dev_set_next_police', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId, delayMinutes } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.devSetNextPolice(roomId, playerId, delayMinutes);
      } catch (err: any) {
        logger.error(`Error in dev_set_next_police for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
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

        if (accept) {
          await this.gameService.acceptTrade(roomId, tradeId, playerId);
        } else {
          await this.gameService.cancelTrade(roomId, tradeId, playerId);
        }

        this.clearTradeExpiryTimer(roomId, tradeId);
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
        if (state.turnStatus === 'MUST_ROLL' && !state.players[playerId].inJail) {
          return socket.emit('error_message', 'You must roll the dice before ending your turn.');
        }

        // Lottery guard
        if (state.activeLottery && !state.activeLottery.isComplete) {
          return socket.emit('error_message', 'লটারি শেষ হয়নি!');
        }

        const { state: updatedState, log } = await this.gameService.endTurn(roomId, playerId);
        this.processBotTurn(roomId, updatedState);

      } catch (err: any) {
        logger.error(`Error in end_turn for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Validation error');
      }
    });

    // --- 8.4 Lottery Start Event ---
    socket.on('lottery_start', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId } = payload || {};
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId || userId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.startLottery(roomId, playerId || userId);
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in lottery_start for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to start lottery');
      }
    });

    // --- 8.5 Lottery Reveal Event ---
    socket.on('lottery_reveal', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId } = payload || {};
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId || userId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.revealLotteryDigit(roomId, playerId || userId);
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in lottery_reveal for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to reveal lottery digit');
      }
    });

    socket.on('resolve_card', async () => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { state: updatedState, log } = await this.gameService.resolveCard(roomId, userId);
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in resolve_card for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to resolve card');
      }
    });

    socket.on('sell_pardon_card', async () => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { state: updatedState, log } = await this.gameService.sellPardonCardToBank(roomId, userId);
      } catch (err: any) {
        logger.error(`Error in sell_pardon_card for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to sell pardon card');
      }
    });

    socket.on('use_pardon_card', async () => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { state: updatedState, log } = await this.gameService.usePardonCardToEscape(roomId, userId);
      } catch (err: any) {
        logger.error(`Error in use_pardon_card for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to use pardon card');
      }
    });

    socket.on('take_loan', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId, amount } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.takeLoan(roomId, playerId, amount);
      } catch (err: any) {
        logger.error(`Error in take_loan for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to take loan');
      }
    });

    socket.on('repay_loan', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');
      try {
        const { playerId, amount } = payload;
        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const { state: updatedState, log } = await this.gameService.repayLoan(roomId, playerId, amount);
      } catch (err: any) {
        logger.error(`Error in repay_loan for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to repay loan');
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
        this.processBotTurn(roomId, updatedState);

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

      } catch (err: any) {
        logger.error(`Error in pay_jail_fine for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Jail fine payment failed');
      }
    });

    // --- 8.7 Cast Kick Vote Event ---
    socket.on('cast_kick_vote', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId, targetPlayerId } = CastKickVoteSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const membershipCheck = antiCheatGuard.verifyMembership(state, playerId);
        if (!membershipCheck.valid) return socket.emit('error_message', membershipCheck.error);

        const { state: updatedState, log } = await this.gameService.castKickVote(roomId, playerId, targetPlayerId);
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in cast_kick_vote for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Kick vote failed');
      }
    });

    // --- 8.8 Restart Game Event ---
    socket.on('restart_game', async (payload: any) => {
      const roomId = this.getSocketRoom(socket);
      if (!roomId) return socket.emit('error_message', 'Not in a game room');

      try {
        const { playerId } = RestartGameSchema.parse(payload);

        const identityCheck = antiCheatGuard.verifySocketIdentity(socket, playerId);
        if (!identityCheck.valid) return socket.emit('error_message', identityCheck.error);

        const state = await this.gameService.getRoomState(roomId);
        if (!state) return socket.emit('error_message', 'Game session not found.');

        const membershipCheck = antiCheatGuard.verifyMembership(state, playerId);
        if (!membershipCheck.valid) return socket.emit('error_message', membershipCheck.error);

        const updatedState = await this.gameService.restartGame(roomId, playerId);
        this.processBotTurn(roomId, updatedState);
      } catch (err: any) {
        logger.error(`Error in restart_game for room ${roomId}`, err);
        socket.emit('error_message', err.message || 'Failed to restart game');
      }
    });

    // --- 9. Disconnect Event ---
    socket.on('disconnect', () => {
      logger.info(`User socket disconnected: ${socket.id} (userId: ${userId})`);
      const roomId = this.getSocketRoom(socket);
      if (roomId && userId && roomPlayerPings[roomId]) {
        delete roomPlayerPings[roomId][userId];
        this.io.to(roomId).emit('player_pings_updated', roomPlayerPings[roomId]);
      }
    });
  }

  /**
   * Helper to retrieve room membership of the socket connection.
   */
  private getSocketRoom(socket: Socket): string | null {
    // Standard approach: socket rooms contains socket ID itself and any room channels joined
    const rooms = Array.from(socket.rooms).filter((r) => r !== socket.id);
    if (rooms.length > 0) {
      this.touchRoom(rooms[0]);
      return rooms[0];
    }
    return null;
  }

  /**
   * Bot AI Loop
   */
  private async processBotTurn(roomId: string, state: any) {
    if (state.gameStatus !== 'ACTIVE') return;
    const currentTurnPlayerId = state.currentTurnPlayerId;
    if (!currentTurnPlayerId.startsWith('bot_')) return;
    
    // Wait a bit to simulate thinking
    setTimeout(async () => {
      try {
        const latestState = await this.gameService.getRoomState(roomId);
        if (!latestState || latestState.gameStatus !== 'ACTIVE' || latestState.currentTurnPlayerId !== currentTurnPlayerId) return;

        if (latestState.turnStatus === 'MUST_ROLL') {
          const { state: updatedState, log } = await this.gameService.rollDice(roomId, currentTurnPlayerId);
          this.processBotTurn(roomId, updatedState);
        } else if (latestState.turnStatus === 'MUST_ACT_OR_END' || latestState.turnStatus === 'BANKRUPTCY_PENDING') {
          const botPlayer = latestState.players[currentTurnPlayerId];
          if (botPlayer.balance < 0) {
            const { state: updatedState, log } = await this.gameService.declareBankruptcy(roomId, currentTurnPlayerId);
            this.processBotTurn(roomId, updatedState);
            return;
          }

          // Check if bot is on an unowned property
          const botPosition = botPlayer.position;
          const template = await this.gameService.loadBoardTemplate();
          const tile = template.tiles[botPosition];
          if (tile && (tile.type === 'STREET' || tile.type === 'RAILROAD' || tile.type === 'UTILITY')) {
            if (!latestState.properties[botPosition] && botPlayer.balance >= (tile.price || 0)) {
              const { state: updatedState, log } = await this.gameService.buyProperty(roomId, currentTurnPlayerId, botPosition);
              this.processBotTurn(roomId, updatedState);
              return;
            }
          }
          
          // End turn
          const { state: updatedState, log } = await this.gameService.endTurn(roomId, currentTurnPlayerId);
          this.processBotTurn(roomId, updatedState);
        } else if (latestState.turnStatus === 'MUST_RESOLVE_CARD') {
          // Bot resolves chance/chest card
          const { state: updatedState, log } = await this.gameService.resolveCard(roomId, currentTurnPlayerId);
          this.processBotTurn(roomId, updatedState);
        } else if (latestState.turnStatus === 'MUST_RESOLVE_LOTTERY') {
          // Bot auto-starts and auto-reveals all lottery digits
          let currentBotState = latestState;
          if (currentBotState.activeLottery && !currentBotState.activeLottery.hasStarted) {
            const { state: startedState, log: startLog } = await this.gameService.startLottery(roomId, currentTurnPlayerId);
            currentBotState = startedState;
          }
          while (currentBotState.activeLottery && !currentBotState.activeLottery.isComplete) {
            const { state: revealedState, log: revealLog } = await this.gameService.revealLotteryDigit(roomId, currentTurnPlayerId);
            currentBotState = revealedState;
          }
          this.processBotTurn(roomId, currentBotState);
        }
      } catch (err) {
        logger.error(`Bot AI error in room ${roomId}`, err);
        // Fallback to ending turn to avoid stuck state
        try {
          const { state: updatedState, log } = await this.gameService.endTurn(roomId, currentTurnPlayerId);
          this.processBotTurn(roomId, updatedState);
        } catch (fallbackErr) {}
      }
    }, 1500);
  }
}
