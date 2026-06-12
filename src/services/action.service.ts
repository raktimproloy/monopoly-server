import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { executeMovement, payRent } from '../rules';

export class ActionService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Performs the Roll Dice transaction: Rolls, moves, updates tile, applies landing rules.
   */
  async rollDice(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const dice: [number, number] = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1
    ];

    const { newState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      state,
      playerId,
      dice,
      tiles
    );

    let finalState = newState;
    let finalDescription = description;

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount);
      finalState = rentResult.newState;
      finalDescription += ` Rent payment processed automatically: ${rentResult.description}`;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'ROLL_DICE',
      { dice, originalPlayer: playerId },
      finalDescription
    );

    return { state: savedState, log: finalDescription };
  }

  /**
   * Ends the current turn and rolls the state over to the next active player.
   */
  async endTurn(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (player.balance < 0) {
      throw new Error('You cannot end your turn while your cash balance is negative! Sell assets or declare bankruptcy.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;

    const currentIndex = newState.playerOrder.indexOf(playerId);
    let nextIndex = (currentIndex + 1) % newState.playerOrder.length;

    let attempts = 0;
    while (newState.players[newState.playerOrder[nextIndex]].isBankrupt && attempts < newState.playerOrder.length) {
      nextIndex = (nextIndex + 1) % newState.playerOrder.length;
      attempts++;
    }

    const nextPlayerId = newState.playerOrder[nextIndex];
    newState.currentTurnPlayerId = nextPlayerId;
    newState.turnStatus = 'MUST_ROLL';
    newState.doubleRollCount = 0;

    const description = `${player.name} ended their turn. It is now ${newState.players[nextPlayerId].name}'s turn.`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'END_TURN',
      { endedPlayer: playerId, nextPlayer: nextPlayerId },
      description
    );

    return { state: savedState, log: description };
  }
}
