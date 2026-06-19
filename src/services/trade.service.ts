import { RoomService } from './room.service';
import { GameState, TradeOfferPayload } from '../types';
import { canOfferTrade, executeTrade, applyRentDebtCollection } from '../rules';

export class TradeService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Accepts and executes a peer-to-peer trade transaction.
   */
  async executeTrade(roomId: string, offer: TradeOfferPayload): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const validation = canOfferTrade(state, offer);
    if (!validation.valid) {
      throw new Error(validation.error || 'Trade proposal is invalid.');
    }

    const { newState, description } = executeTrade(state, offer);

    let finalState = newState;
    let finalDescription = description;
    for (const pid of [offer.senderId, offer.receiverId]) {
      const collected = applyRentDebtCollection(finalState, pid);
      finalState = collected.newState;
      finalDescription += collected.extraDescription;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      offer.senderId,
      'EXECUTE_TRADE',
      offer,
      finalDescription
    );

    return { state: savedState, log: finalDescription };
  }
}
