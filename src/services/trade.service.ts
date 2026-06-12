import { RoomService } from './room.service';
import { GameState, TradeOfferPayload } from '../../../shared/types';
import { canOfferTrade, executeTrade } from '../rules';

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

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      offer.senderId,
      'EXECUTE_TRADE',
      offer,
      description
    );

    return { state: savedState, log: description };
  }
}
