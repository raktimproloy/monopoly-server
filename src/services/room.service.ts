import { db } from '../config/database';
import { runtimeFlags } from '../config/runtime';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { toBanglaNum } from '../utils/format';
import { GameState, Player, BoardTile, GameSettings } from '../types';
import { logger } from '../utils/logger';
import { WorldEventOrchestrator } from './world_event.orchestrator';
import { roomManager } from '../managers/RoomManager';
import { gameStateStore } from '../state/GameStateStore';
import { postgresPersistence } from '../persistence/PostgresPersistence';

// Legacy exports used by admin clear-db endpoint
export const memoryRooms: Record<string, { state: GameState; version: number; templateId: number }> = {};
export const memoryLogs: any[] = [];
/** @deprecated Use runtimeFlags — kept for backward compatibility */
export const stateFlags = runtimeFlags;

// Standard board tiles fallback if database query fails
// export const STANDARD_TILES_FALLBACK: BoardTile[] = [
//   { index: 0, name: "GO", type: "START" },
//   { index: 1, name: "Mediterranean Avenue", type: "STREET", price: 60, rent: [2, 10, 30, 90, 160, 250], mortgageValue: 30, houseCost: 50, group: "Brown" },
//   { index: 2, name: "Community Chest", type: "CHEST" },
//   { index: 3, name: "Baltic Avenue", type: "STREET", price: 60, rent: [4, 20, 60, 180, 320, 450], mortgageValue: 30, houseCost: 50, group: "Brown" },
//   { index: 4, name: "Income Tax", type: "TAX", price: 200 },
//   { index: 5, name: "Reading Railroad", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
//   { index: 6, name: "Oriental Avenue", type: "STREET", price: 100, rent: [6, 30, 90, 270, 400, 550], mortgageValue: 50, houseCost: 50, group: "Light Blue" },
//   { index: 7, name: "Chance", type: "CHANCE" },
//   { index: 8, name: "Vermont Avenue", type: "STREET", price: 100, rent: [6, 30, 90, 270, 400, 550], mortgageValue: 50, houseCost: 50, group: "Light Blue" },
//   { index: 9, name: "Connecticut Avenue", type: "STREET", price: 120, rent: [8, 40, 100, 300, 450, 600], mortgageValue: 60, houseCost: 50, group: "Light Blue" },
//   { index: 10, name: "Just Visiting / Jail", type: "JAIL" },
//   { index: 11, name: "St. Charles Place", type: "STREET", price: 140, rent: [10, 50, 150, 450, 625, 750], mortgageValue: 70, houseCost: 100, group: "Pink" },
//   { index: 12, name: "Electric Company", type: "UTILITY", price: 150, rent: [4, 10], mortgageValue: 75 },
//   { index: 13, name: "States Avenue", type: "STREET", price: 140, rent: [10, 50, 150, 450, 625, 750], mortgageValue: 70, houseCost: 100, group: "Pink" },
//   { index: 14, name: "Virginia Avenue", type: "STREET", price: 160, rent: [12, 60, 180, 500, 700, 900], mortgageValue: 80, houseCost: 100, group: "Pink" },
//   { index: 15, name: "Pennsylvania Railroad", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
//   { index: 16, name: "St. James Place", type: "STREET", price: 180, rent: [14, 70, 200, 550, 750, 950], mortgageValue: 90, houseCost: 100, group: "Orange" },
//   { index: 17, name: "Community Chest", type: "CHEST" },
//   { index: 18, name: "Tennessee Avenue", type: "STREET", price: 180, rent: [14, 70, 200, 550, 750, 950], mortgageValue: 90, houseCost: 100, group: "Orange" },
//   { index: 19, name: "New York Avenue", type: "STREET", price: 200, rent: [16, 80, 220, 600, 800, 1000], mortgageValue: 100, houseCost: 100, group: "Orange" },
//   { index: 20, name: "Free Parking", type: "FREE_PARKING" },
//   { index: 21, name: "Kentucky Avenue", type: "STREET", price: 220, rent: [18, 90, 250, 700, 875, 1050], mortgageValue: 110, houseCost: 150, group: "Red" },
//   { index: 22, name: "Chance", type: "CHANCE" },
//   { index: 23, name: "Indiana Avenue", type: "STREET", price: 220, rent: [18, 90, 250, 700, 875, 1050], mortgageValue: 110, houseCost: 150, group: "Red" },
//   { index: 24, name: "Illinois Avenue", type: "STREET", price: 240, rent: [20, 100, 300, 750, 925, 1100], mortgageValue: 120, houseCost: 150, group: "Red" },
//   { index: 25, name: "B. & O. Railroad", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
//   { index: 26, name: "Atlantic Avenue", type: "STREET", price: 260, rent: [22, 110, 330, 800, 975, 1150], mortgageValue: 130, houseCost: 150, group: "Yellow" },
//   { index: 27, name: "Ventnor Avenue", type: "STREET", price: 260, rent: [22, 110, 330, 800, 975, 1150], mortgageValue: 130, houseCost: 150, group: "Yellow" },
//   { index: 28, name: "Water Works", type: "UTILITY", price: 150, rent: [4, 10], mortgageValue: 75 },
//   { index: 29, name: "Marvin Gardens", type: "STREET", price: 280, rent: [24, 120, 360, 850, 1025, 1200], mortgageValue: 140, houseCost: 150, group: "Yellow" },
//   { index: 30, name: "Go To Jail", type: "GO_TO_JAIL" },
//   { index: 31, name: "Pacific Avenue", type: "STREET", price: 300, rent: [26, 130, 390, 900, 1100, 1275], mortgageValue: 150, houseCost: 200, group: "Green" },
//   { index: 32, name: "North Carolina Avenue", type: "STREET", price: 300, rent: [26, 130, 390, 900, 1100, 1275], mortgageValue: 150, houseCost: 200, group: "Green" },
//   { index: 33, name: "Community Chest", type: "CHEST" },
//   { index: 34, name: "Pennsylvania Avenue", type: "STREET", price: 320, rent: [28, 150, 450, 1000, 1200, 1400], mortgageValue: 160, houseCost: 200, group: "Green" },
//   { index: 35, name: "Short Line Railroad", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
//   { index: 36, name: "Chance", type: "CHANCE" },
//   { index: 37, name: "Park Place", type: "STREET", price: 350, rent: [35, 175, 500, 1100, 1300, 1500], mortgageValue: 175, houseCost: 200, group: "Dark Blue" },
//   { index: 38, name: "Luxury Tax", type: "TAX", price: 100 },
//   { index: 39, name: "Boardwalk", type: "STREET", price: 400, rent: [50, 200, 600, 1400, 1700, 2000], mortgageValue: 200, houseCost: 200, group: "Dark Blue" }
// ];

// Bangladesh Division-District Board Configuration (Updated with unique names)
export const STANDARD_TILES_FALLBACK: BoardTile[] = [
  { index: 0, name: "শুরু", type: "START" },
  { index: 1, name: "পঞ্চগড় (রংপুর)", type: "STREET", price: 60, rent: [2, 10, 30, 90, 160, 250], mortgageValue: 30, houseCost: 50, group: "Brown" },
  { index: 2, name: "গুপ্তধন", type: "CHEST" },
  { index: 3, name: "রংপুর (রংপুর)", type: "STREET", price: 60, rent: [4, 20, 60, 180, 320, 450], mortgageValue: 30, houseCost: 50, group: "Brown" },
  { index: 4, name: "আয়কর\n(১০%)", type: "TAX", price: 0 },
  { index: 5, name: "রংপুর রেল", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
  { index: 6, name: "বরগুনা (বরিশাল)", type: "STREET", price: 100, rent: [6, 30, 90, 270, 400, 550], mortgageValue: 50, houseCost: 50, group: "Light Blue" },
  { index: 7, name: "ভাগ্য পরীক্ষা", type: "CHANCE" },
  { index: 8, name: "ভোলা (বরিশাল)", type: "STREET", price: 100, rent: [6, 30, 90, 270, 400, 550], mortgageValue: 50, houseCost: 50, group: "Light Blue" },
  { index: 9, name: "বরিশাল (বরিশাল)", type: "STREET", price: 120, rent: [8, 40, 100, 300, 450, 600], mortgageValue: 60, houseCost: 50, group: "Light Blue" },
  { index: 10, name: "জেল", type: "JAIL" },
  { index: 11, name: "যশোর (খুলনা)", type: "STREET", price: 140, rent: [10, 50, 150, 450, 625, 750], mortgageValue: 70, houseCost: 100, group: "Pink" },
  { index: 12, name: "বিদ্যুৎ কেন্দ্র", type: "UTILITY", price: 150, rent: [4, 10], mortgageValue: 75 },
  { index: 13, name: "কুষ্টিয়া (খুলনা)", type: "STREET", price: 140, rent: [10, 50, 150, 450, 625, 750], mortgageValue: 70, houseCost: 100, group: "Pink" },
  { index: 14, name: "খুলনা (খুলনা)", type: "STREET", price: 160, rent: [12, 60, 180, 500, 700, 900], mortgageValue: 80, houseCost: 100, group: "Pink" },
  { index: 15, name: "রাজশাহী রেল", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
  { index: 16, name: "বগুড়া (রাজশাহী)", type: "STREET", price: 180, rent: [14, 70, 200, 550, 750, 950], mortgageValue: 90, houseCost: 100, group: "Orange" },
  { index: 17, name: "ভাগ্য পরীক্ষা", type: "CHANCE" },
  { index: 18, name: "নাটোর (রাজশাহী)", type: "STREET", price: 180, rent: [14, 70, 200, 550, 750, 950], mortgageValue: 90, houseCost: 100, group: "Orange" },
  { index: 19, name: "রাজশাহী (রাজশাহী)", type: "STREET", price: 200, rent: [16, 80, 220, 600, 800, 1000], mortgageValue: 100, houseCost: 100, group: "Orange" },
  { index: 20, name: "অবসর", type: "FREE_PARKING" },
  { index: 21, name: "শ্রীমঙ্গল (সিলেট)", type: "STREET", price: 220, rent: [18, 90, 250, 700, 875, 1050], mortgageValue: 110, houseCost: 150, group: "Red" },
  { index: 22, name: "ভাগ্য পরীক্ষা", type: "CHANCE" },
  { index: 23, name: "হবিগঞ্জ (সিলেট)", type: "STREET", price: 220, rent: [18, 90, 250, 700, 875, 1050], mortgageValue: 110, houseCost: 150, group: "Red" },
  { index: 24, name: "সিলেট (সিলেট)", type: "STREET", price: 240, rent: [20, 100, 300, 750, 925, 1100], mortgageValue: 120, houseCost: 150, group: "Red" },
  { index: 25, name: "সিলেট রেল", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
  { index: 26, name: "কুমিল্লা (চট্টগ্রাম)", type: "STREET", price: 260, rent: [22, 110, 330, 800, 975, 1150], mortgageValue: 130, houseCost: 150, group: "Yellow" },
  { index: 27, name: "লক্ষ্মীপুর (চট্টগ্রাম)", type: "STREET", price: 260, rent: [22, 110, 330, 800, 975, 1150], mortgageValue: 130, houseCost: 150, group: "Yellow" },
  { index: 28, name: "পানি সরবরাহ", type: "UTILITY", price: 150, rent: [4, 10], mortgageValue: 75 },
  { index: 29, name: "চট্টগ্রাম (চট্টগ্রাম)", type: "STREET", price: 280, rent: [24, 120, 360, 850, 1025, 1200], mortgageValue: 140, houseCost: 150, group: "Yellow" },
  { index: 30, name: "জেলে যাও", type: "GO_TO_JAIL" },
  { index: 31, name: "নেত্রকোণা (ময়মনসিংহ)", type: "STREET", price: 300, rent: [26, 130, 390, 900, 1100, 1275], mortgageValue: 150, houseCost: 200, group: "Green" },
  { index: 32, name: "শেরপুর (ময়মনসিংহ)", type: "STREET", price: 300, rent: [26, 130, 390, 900, 1100, 1275], mortgageValue: 150, houseCost: 200, group: "Green" },
  { index: 33, name: "গুপ্তধন", type: "CHEST" },
  { index: 34, name: "ময়মনসিংহ (ময়মনসিংহ)", type: "STREET", price: 320, rent: [28, 150, 450, 1000, 1200, 1400], mortgageValue: 160, houseCost: 200, group: "Green" },
  { index: 35, name: "ঢাকা রেল", type: "RAILROAD", price: 200, rent: [25, 50, 100, 200], mortgageValue: 100 },
  { index: 36, name: "ভাগ্য পরীক্ষা", type: "CHANCE" },
  { index: 37, name: "গুলশান (ঢাকা)", type: "STREET", price: 350, rent: [35, 175, 500, 1100, 1300, 1500], mortgageValue: 175, houseCost: 200, group: "Dark Blue" },
  { index: 38, name: "লটারি", type: "LOTTERY" },
  { index: 39, name: "ঢাকা (ঢাকা)", type: "STREET", price: 400, rent: [50, 200, 600, 1400, 1700, 2000], mortgageValue: 200, houseCost: 200, group: "Dark Blue" }
];

export class RoomService {
  /**
   * Loads board template from database. Falls back to default if connection fails.
   */
  async loadBoardTemplate(templateName: string = 'Standard Monopoly'): Promise<{ id: number; tiles: BoardTile[] }> {
    if (stateFlags.useMemoryFallback) {
      return { id: 1, tiles: STANDARD_TILES_FALLBACK };
    }
    try {
      const rows = await db.query(
        'SELECT id, board_data FROM board_templates WHERE name = $1 LIMIT 1',
        [templateName]
      );
      if (rows.length > 0) {
        if (templateName === 'Standard Monopoly') {
          // Forcefully sync the DB with the updated Bengali tiles
          await db.query(
            'UPDATE board_templates SET board_data = $1 WHERE id = $2',
            [{ tiles: STANDARD_TILES_FALLBACK }, rows[0].id]
          );
          return { id: rows[0].id, tiles: STANDARD_TILES_FALLBACK };
        }
        return {
          id: rows[0].id,
          tiles: rows[0].board_data.tiles as BoardTile[]
        };
      }
      logger.warn(`Board template "${templateName}" not found in DB. Seeding defaults.`);
      return { id: 1, tiles: STANDARD_TILES_FALLBACK };
    } catch (err) {
      logger.warn('Failed to connect to database. Falling back to in-memory mode.', err);
      stateFlags.useMemoryFallback = true;
      return { id: 1, tiles: STANDARD_TILES_FALLBACK };
    }
  }

  /**
   * Initializes a new room state in the database or cache. Start in LOBBY state.
   */
  async createRoom(roomId: string, templateName: string, initialPlayers: { id: string; name: string; avatar: string }[]): Promise<GameState> {
    const { id: templateId, tiles } = await this.loadBoardTemplate(templateName);

    const playersMap: Record<string, Player> = {};
    const playerOrder: string[] = [];

    const defaultSettings: GameSettings = {
      startingCash: 2000,
      doubleRentOnCompleteSet: false,
      freeParkingCashPool: false,
      allowUnpurchasedAuction: false,
      allowMortgage: false,
      jailLoss: false,
      enableTrafficPolice: true
    };

    initialPlayers.forEach((p) => {
      playersMap[p.id] = {
        id: p.id,
        name: p.name,
        position: 0,
        balance: defaultSettings.startingCash,
        isBankrupt: false,
        inJail: false,
        jailTurns: 0,
        avatar: p.avatar
      };
      playerOrder.push(p.id);
    });

    const initialState: GameState = {
      roomId,
      players: playersMap,
      playerOrder,
      currentTurnPlayerId: playerOrder[0] || '',
      properties: {},
      dice: [1, 1],
      doubleRollCount: 0,
      gameStatus: 'LOBBY', // Initialized as LOBBY, waiting for players
      winnerId: null,
      turnStatus: 'MUST_ROLL',
      settings: defaultSettings,
      freeParkingPool: 0,
      activeAuction: undefined,
      drawnCard: null,
      marketCrash: {
        active: false,
        nextCrashTime: null,
        crashEndTime: null,
        crashCount: 0
      },
      governmentBank: {
        balance: Math.floor(Math.random() * (1500000 - 700000 + 1)) + 700000
      },
      pendingTrades: []
    };

    await roomManager.createRoom(roomId, initialState, templateId);
    logger.info(`Room ${roomId} created in Redis active store (v1)`);

    void postgresPersistence.ensureRoomRecord(roomId, initialState, templateId);

    roomManager.emit('stateUpdated', {
      roomId,
      previousState: initialState,
      state: initialState,
      version: 1,
      log: 'Room created',
      playerId: playerOrder[0] || 'system',
      actionType: 'CREATE_ROOM',
      actionPayload: {},
    });

    return initialState;
  }

  /**
   * Adds a new player or updates an existing player's profile inside the LOBBY.
   */
  async joinRoom(roomId: string, player: { id: string; name: string; avatar: string }): Promise<GameState> {
    const state = await this.getRoomState(roomId);
    if (!state) {
      // Dynamic room fallback
      return this.createRoom(roomId, 'Standard Monopoly', [player]);
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    if (newState.gameStatus !== 'LOBBY') {
      // If game is active and player is rejoining, return existing state
      if (newState.players[player.id]) {
        return newState;
      }
      throw new Error('Game session has already started in this room.');
    }

    // Ensure avatar color signature is unique
    const takenColors = Object.values(newState.players)
      .filter((p) => p.id !== player.id)
      .map(p => p.avatar.toLowerCase());

    if (takenColors.includes(player.avatar.toLowerCase())) {
      const AVATAR_COLORS = ['#6366f1', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#d946ef'];
      const available = AVATAR_COLORS.find(col => !takenColors.includes(col.toLowerCase()));
      if (available) {
        player.avatar = available;
      } else {
        // Fallback to random color if standard ones are taken
        player.avatar = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
      }
    }

    // Add or update player details (allows edit of callsign and appearance!)
    if (newState.players[player.id]) {
      newState.players[player.id].name = player.name;
      newState.players[player.id].avatar = player.avatar;
    } else {
      newState.players[player.id] = {
        id: player.id,
        name: player.name,
        position: 0,
        balance: newState.settings.startingCash,
        isBankrupt: false,
        inJail: false,
        jailTurns: 0,
        avatar: player.avatar
      };
      newState.playerOrder.push(player.id);
    }

    const resultState = await this.updateRoomState(
      roomId,
      newState,
      player.id,
      'JOIN_LOBBY',
      { name: player.name, avatar: player.avatar },
      `${player.name} লবিতে যুক্ত হয়েছেন।`
    );

    return resultState;
  }

  /**
   * Updates game settings inside the LOBBY.
   */
  async updateSettings(roomId: string, settings: GameSettings, playerId: string): Promise<GameState> {
    const state = await this.getRoomState(roomId);
    if (!state) throw new Error(`Room ${roomId} not found.`);

    if (state.gameStatus !== 'LOBBY') {
      throw new Error('Cannot change configuration parameters after match start.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    // Update setting parameters
    newState.settings = settings;

    // Reset player balances to match new starting balance configuration
    Object.keys(newState.players).forEach((pId) => {
      newState.players[pId].balance = settings.startingCash;
    });

    const log = `গেমের নিয়ম পরিবর্তন করা হয়েছে: প্রারম্ভিক টাকা ৳${toBanglaNum(settings.startingCash)}, ফ্রি পার্কিং পুল: ${settings.freeParkingCashPool ? 'হ্যাঁ' : 'না'}, নিলাম: ${settings.allowUnpurchasedAuction ? 'হ্যাঁ' : 'না'}, মর্টগেজ: ${settings.allowMortgage ? 'হ্যাঁ' : 'না'}, জেল লস: ${settings.jailLoss ? 'হ্যাঁ' : 'না'}।`;

    const resultState = await this.updateRoomState(
      roomId,
      newState,
      playerId,
      'UPDATE_SETTINGS',
      settings,
      log
    );

    return resultState;
  }

  /**
   * Commits the lobby and begins active game play.
   */
  async startGame(roomId: string, playerId: string): Promise<GameState> {
    const state = await this.getRoomState(roomId);
    if (!state) throw new Error(`Room ${roomId} not found.`);

    if (state.gameStatus !== 'LOBBY') {
      throw new Error('Session is already active.');
    }

    if (state.playerOrder.length < 2) {
      // Add a mock CPU player if there is only 1 user, to make it single-player testable out-of-the-box
      state.players['cpu_player'] = {
        id: 'cpu_player',
        name: 'BoardMaster CPU',
        position: 0,
        balance: state.settings.startingCash,
        isBankrupt: false,
        inJail: false,
        jailTurns: 0,
        avatar: '#BC13FE' // purple
      };
      state.playerOrder.push('cpu_player');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    // Randomize initial turn order sequence
    newState.playerOrder.sort(() => Math.random() - 0.5);
    newState.currentTurnPlayerId = newState.playerOrder[0];
    newState.gameStatus = 'ACTIVE';
    newState.turnStatus = 'MUST_ROLL';
    newState.pendingTrades = [];

    // Initialize unified world event scheduler (market crash + traffic police)
    const { newState: stateWithEvents } = WorldEventOrchestrator.initOnGameStart(newState);

    const resultState = await this.updateRoomState(
      roomId,
      stateWithEvents,
      playerId,
      'START_GAME',
      {},
      `${newState.players[newState.currentTurnPlayerId].name}-এর চাল দিয়ে খেলা শুরু হলো।`
    );

    return resultState;
  }

  /**
   * Kicks a player from the lobby if the requester is the host.
   */
  public async kickPlayerFromLobby(roomId: string, hostId: string, targetId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.getRoomState(roomId);
    if (!state) throw new Error('Room not found');
    if (state.gameStatus !== 'LOBBY') throw new Error('Game has already started.');

    // Verify the kicker is the host
    if (state.playerOrder[0] !== hostId) {
      throw new Error('Only the host can kick players.');
    }

    // Verify the target player exists
    const targetPlayer = state.players[targetId];
    if (!targetPlayer) {
      throw new Error('Target player not found.');
    }

    // Remove the player
    delete state.players[targetId];
    state.playerOrder = state.playerOrder.filter(id => id !== targetId);

    const log = `${targetPlayer.name} has been kicked from the lobby by the host.`;
    
    const updatedState = await this.updateRoomState(roomId, state, hostId, 'KICK_PLAYER', { targetId }, log);
    return { state: updatedState, log };
  }

  /**
   * Restarts the game with the same players and settings after a finished match.
   */
  async restartGame(roomId: string, playerId: string): Promise<GameState> {
    const state = await this.getRoomState(roomId);
    if (!state) throw new Error(`Room ${roomId} not found.`);
    if (state.gameStatus !== 'FINISHED') throw new Error('Game must be finished before restarting.');

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const settings = { ...newState.settings };

    Object.keys(newState.players).forEach((pId) => {
      const p = newState.players[pId];
      p.position = 0;
      p.balance = settings.startingCash;
      p.isBankrupt = false;
      p.inJail = false;
      p.jailTurns = 0;
      delete p.loan;
      delete p.getOutOfJailFreeCards;
      delete p.skipTurns;
      delete p.powerCards;
    });

    newState.properties = {};
    newState.playerOrder.sort(() => Math.random() - 0.5);
    newState.currentTurnPlayerId = newState.playerOrder[0];
    newState.gameStatus = 'ACTIVE';
    newState.turnStatus = 'MUST_ROLL';
    newState.winnerId = null;
    newState.dice = [1, 1];
    newState.doubleRollCount = 0;
    newState.freeParkingPool = 0;
    newState.activeAuction = undefined;
    newState.drawnCard = null;
    newState.kickVotes = {};
    newState.pendingRentOwed = null;
    newState.activeDonPower = null;
    newState.donCardDrawn = false;
    newState.pendingTrades = [];
    const { newState: stateWithEvents } = WorldEventOrchestrator.initOnGameStart(newState);

    const resultState = await this.updateRoomState(
      roomId,
      stateWithEvents,
      playerId,
      'RESTART_GAME',
      {},
      `নতুন গেম শুরু! ${stateWithEvents.players[stateWithEvents.currentTurnPlayerId].name}-এর চাল দিয়ে শুরু হলো।`
    );

    return resultState;
  }

  /**
   * Loads active game state.
   */
  async getRoomState(roomId: string): Promise<GameState | null> {
    const hot = await gameStateStore.getState(roomId);
    if (hot) return hot;

    if (runtimeFlags.useMemoryFallback) {
      return memoryRooms[roomId]?.state || null;
    }

    try {
      const rows = await db.query<{ state: GameState; board_template_id: number }>(
        'SELECT state, board_template_id FROM game_rooms WHERE room_id = $1 LIMIT 1',
        [roomId]
      );
      if (rows.length === 0) return null;
      const state = rows[0].state;
      await gameStateStore.create(roomId, state, rows[0].board_template_id || 1);
      return state;
    } catch (err) {
      logger.warn('Database read failed. Using memory fallback.', err);
      runtimeFlags.useMemoryFallback = true;
      return memoryRooms[roomId]?.state || null;
    }
  }

  /**
   * Saves updated game state to Redis (hot path) and queues cold-path PG audit log.
   * Broadcast is triggered automatically via RoomManager → RoomBroadcaster.
   */
  async updateRoomState(
    roomId: string,
    newState: GameState,
    playerId: string,
    actionType: string,
    actionPayload: any,
    logMessage: string
  ): Promise<GameState> {
    const event = await roomManager.commitUpdate(roomId, newState, {
      playerId,
      actionType,
      actionPayload,
      log: logMessage,
    });

    const record = await gameStateStore.get(roomId);
    if (record) {
      void postgresPersistence.ensureRoomRecord(roomId, event.state, record.templateId);
    }

    postgresPersistence.queueLog({
      room_id: roomId,
      player_id: playerId,
      action_type: actionType,
      action_payload: actionPayload,
      state_snapshot: event.state,
    });

    if (event.state.gameStatus === 'FINISHED') {
      const record = await gameStateStore.get(roomId);
      if (record) {
        void postgresPersistence.persistFinalRoomState(roomId, event.state, record.templateId);
      }
    }

    return event.state;
  }

  /**
   * Removes a player from a room. In LOBBY state, fully removes the player.
   * In ACTIVE state, marks them as bankrupt/disconnected and rotates the turn if needed.
   * Returns the updated state, or null if the room was deleted.
   */
  async removePlayer(roomId: string, playerId: string): Promise<{ state: GameState | null; log: string; roomDeleted: boolean }> {
    const state = await this.getRoomState(roomId);
    if (!state) return { state: null, log: '', roomDeleted: false };

    const player = state.players[playerId];
    if (!player) return { state, log: '', roomDeleted: false };

    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    if (newState.gameStatus === 'LOBBY') {
      // In lobby: fully remove the player from the room
      delete newState.players[playerId];
      newState.playerOrder = newState.playerOrder.filter(id => id !== playerId);

      // If no players remain, delete the room entirely
      if (Object.keys(newState.players).length === 0) {
        await this.deleteRoom(roomId);
        return { state: null, log: `${player.name} left. Room dissolved.`, roomDeleted: true };
      }

      const savedState = await this.updateRoomState(
        roomId, newState, playerId, 'PLAYER_LEFT',
        { playerId },
        `${player.name} লবি থেকে বের হয়ে গেছেন।`
      );
      return { state: savedState, log: `${player.name} লবি থেকে বের হয়ে গেছেন।`, roomDeleted: false };
    }

    if (newState.gameStatus === 'ACTIVE') {
      // In active game: mark the player as bankrupt and return their properties to bank
      newState.players[playerId].isBankrupt = true;
      newState.players[playerId].balance = 0;

      // Return all their properties to the bank
      const playerProperties = Object.values(newState.properties).filter(p => p.ownerId === playerId);
      playerProperties.forEach(p => {
        delete newState.properties[p.tileIndex];
      });

      // Clear Don power if the disconnected player was the Don
      if (newState.activeDonPower && newState.activeDonPower.donPlayerId === playerId) {
        newState.activeDonPower = null;
      }

      // Rotate turn if it was their turn
      if (newState.currentTurnPlayerId === playerId) {
        const currentIndex = newState.playerOrder.indexOf(playerId);
        let nextIndex = (currentIndex + 1) % newState.playerOrder.length;
        let attempts = 0;
        while (newState.players[newState.playerOrder[nextIndex]].isBankrupt && attempts < newState.playerOrder.length) {
          nextIndex = (nextIndex + 1) % newState.playerOrder.length;
          attempts++;
        }
        newState.currentTurnPlayerId = newState.playerOrder[nextIndex];
        newState.turnStatus = 'MUST_ROLL';
        newState.doubleRollCount = 0;
      }

      // Check if game is finished (only 1 non-bankrupt player left)
      const activePlayers = Object.values(newState.players).filter(p => !p.isBankrupt);
      let description = `${player.name} গেম থেকে বের হয়ে গেছেন এবং তার সম্পত্তি বাজেয়াপ্ত করা হয়েছে।`;
      if (activePlayers.length <= 1) {
        newState.gameStatus = 'FINISHED';
        newState.winnerId = activePlayers[0]?.id || null;
        if (newState.winnerId) {
          description += ` Game over! ${newState.players[newState.winnerId].name} wins!`;
        }
      }

      const savedState = await this.updateRoomState(
        roomId, newState, playerId, 'PLAYER_DISCONNECTED',
        { playerId },
        description
      );
      return { state: savedState, log: description, roomDeleted: false };
    }

    // FINISHED state: just remove, and if empty, delete
    delete newState.players[playerId];
    newState.playerOrder = newState.playerOrder.filter(id => id !== playerId);
    if (Object.keys(newState.players).length === 0) {
      await this.deleteRoom(roomId);
      return { state: null, log: '', roomDeleted: true };
    }
    return { state: newState, log: '', roomDeleted: false };
  }

  /**
   * Deletes a room entirely from memory/database.
   */
  async deleteRoom(roomId: string): Promise<void> {
    logger.info(`Deleting room ${roomId} — no players remaining.`);

    const record = await gameStateStore.delete(roomId);
    delete memoryRooms[roomId];

    if (record) {
      void postgresPersistence.persistFinalRoomState(roomId, record.state, record.templateId);
    }
    void postgresPersistence.deleteRoomRecord(roomId);
  }
}
