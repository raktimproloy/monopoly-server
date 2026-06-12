import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { canBuyProperty, buyProperty, canMortgageProperty, mortgageProperty, canUnmortgageProperty, unmortgageProperty } from '../rules';

export class PropertyService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Purchases the tile the player is currently standing on.
   */
  async buyProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canBuyProperty(state, playerId, tileIndex, tiles);
    if (!validation.valid) {
      throw new Error(validation.error || 'Action rejected by rules engine.');
    }

    const { newState, description } = buyProperty(state, playerId, tileIndex, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'BUY_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Mortgages an owned property space.
   */
  async mortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canMortgageProperty(state, playerId, tileIndex);
    if (!validation.valid) {
      throw new Error(validation.error || 'Cannot mortgage property.');
    }

    const { newState, description } = mortgageProperty(state, playerId, tileIndex, tiles);

    if (newState.players[playerId].balance >= 0 && newState.turnStatus === 'BANKRUPTCY_PENDING') {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'MORTGAGE_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Unmortgages a mortgaged property space.
   */
  async unmortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canUnmortgageProperty(state, playerId, tileIndex, tiles);
    if (!validation.valid) {
      throw new Error(validation.error || 'Cannot unmortgage property.');
    }

    const { newState, description } = unmortgageProperty(state, playerId, tileIndex, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'UNMORTGAGE_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }
}
