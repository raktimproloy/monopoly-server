import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { generateLog } from '../utils/logGenerator';

export class PardonService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Sells a Get Out of Jail Free card to the bank for ৳50
   */
  async sellToBank(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);
    
    if (!player.getOutOfJailFreeCards || player.getOutOfJailFreeCards <= 0) {
      throw new Error('You do not have any Pardon cards to sell.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    pState.getOutOfJailFreeCards = (pState.getOutOfJailFreeCards || 1) - 1;
    pState.balance += 50;

    const description = `${player.name} একটি পার্ডন কার্ড (Get Out of Jail Free) ব্যাংকের কাছে ৳50-তে বিক্রি করেছেন।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'SELL_PARDON_CARD',
      { playerId },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Uses a Get Out of Jail Free card to escape jail
   */
  async useToEscapeJail(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);
    if (!player.inJail) throw new Error(`Player ${playerId} is not in jail.`);
    
    if (!player.getOutOfJailFreeCards || player.getOutOfJailFreeCards <= 0) {
      throw new Error('You do not have any Pardon cards to use.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    pState.getOutOfJailFreeCards = (pState.getOutOfJailFreeCards || 1) - 1;
    pState.inJail = false;
    pState.jailTurns = 0;
    newState.turnStatus = 'MUST_ROLL';

    const description = `${player.name} পার্ডন কার্ড (Get Out of Jail Free) ব্যবহার করে জেল থেকে ছাড়া পেয়েছেন।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'USE_PARDON_CARD',
      { playerId },
      description
    );

    return { state: savedState, log: description };
  }
}
