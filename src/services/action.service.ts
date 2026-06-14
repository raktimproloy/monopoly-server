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
   * Dev-only feature: Teleports player to a specific tile and simulates landing.
   */
  async devTeleport(roomId: string, playerId: string, targetIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();
    
    // Temporarily mutate position to target so executeMovement evaluates it naturally as a [0,0] roll
    const tempState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = tempState.players[playerId];
    pState.position = targetIndex;
    pState.inJail = false; // Free from jail forcefully if teleporting

    const { newState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      tempState,
      playerId,
      [0, 0],
      tiles
    );

    let finalState = newState;
    let finalDescription = `[DEV] ${newState.players[playerId].name} teleported to tile ${targetIndex}.`;
    
    // Extract just the landing logic from the movement rule's description
    const actionMatch = description.match(/\.\s*(Landed on.+|Paid.+|Sent directly to Jail.+)/);
    if (actionMatch) {
      finalDescription += ` ${actionMatch[1]}`;
    }

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount);
      finalState = rentResult.newState;
      finalDescription += ` Rent payment processed automatically: ${rentResult.description}`;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'DEV_TELEPORT',
      { targetIndex },
      finalDescription
    );

    return { state: savedState, log: finalDescription };
  }

  /**
   * Dev-only feature: Forces a dice roll with manually provided integers.
   */
  async devRollDice(roomId: string, playerId: string, d1: number, d2: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const dice: [number, number] = [d1, d2];

    const { newState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      state,
      playerId,
      dice,
      tiles
    );

    let finalState = newState;
    let finalDescription = `[DEV] ${description}`;

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount);
      finalState = rentResult.newState;
      finalDescription += ` Rent payment processed automatically: ${rentResult.description}`;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'DEV_ROLL_DICE',
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

  /**
   * Declares bankruptcy for a player, surrendering assets to their creditor or the bank.
   */
  async declareBankruptcy(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);
    if (player.isBankrupt) throw new Error(`Player ${playerId} is already bankrupt.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    pState.isBankrupt = true;
    pState.balance = 0;

    const currentTileIndex = pState.position;
    const propState = state.properties[currentTileIndex];
    const { tiles: boardTiles } = await this.roomService.loadBoardTemplate();

    let creditorName = 'the bank';
    let creditorId: string | null = null;

    // Check if player is on a property owned by someone else
    if (
      propState &&
      propState.ownerId &&
      propState.ownerId !== playerId &&
      !propState.isMortgaged
    ) {
      creditorId = propState.ownerId;
      creditorName = newState.players[creditorId]?.name || 'another player';
    }

    // Distribute properties
    const playerProperties = Object.values(newState.properties).filter(
      (p) => p.ownerId === playerId
    );

    if (creditorId) {
      // Transfer all properties to creditor
      playerProperties.forEach((p) => {
        p.ownerId = creditorId;
        // Keep mortgaged status, but sell houses
        p.houses = 0;
      });
    } else {
      // Return properties to bank (reset them)
      playerProperties.forEach((p) => {
        delete newState.properties[p.tileIndex];
      });
    }

    let description = `${pState.name} declared bankruptcy and surrendered all assets to ${creditorName}.`;

    // Rotate turn if it was their turn
    if (newState.currentTurnPlayerId === playerId) {
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
      description += ` It is now ${newState.players[nextPlayerId].name}'s turn.`;
    }

    // Check if game is finished (only 1 non-bankrupt player left)
    const activePlayers = Object.values(newState.players).filter((p) => !p.isBankrupt);
    if (activePlayers.length <= 1) {
      newState.gameStatus = 'FINISHED';
      newState.winnerId = activePlayers[0]?.id || null;
      if (newState.winnerId) {
        description += ` Game over! ${newState.players[newState.winnerId].name} is the winner!`;
      }
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'DECLARE_BANKRUPTCY',
      { bankruptPlayerId: playerId, creditorId },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Pays a fine of $50 to get out of Jail.
   */
  async payJailFine(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);
    if (!player.inJail) throw new Error(`Player ${playerId} is not in jail.`);
    if (player.balance < 50) throw new Error(`Insufficient funds. Paying jail fine costs ৳50, you have ৳${player.balance}.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    pState.inJail = false;
    pState.jailTurns = 0;
    pState.balance -= 50;
    newState.turnStatus = 'MUST_ROLL';

    const description = `${pState.name} paid ৳50 fine and is released from Jail.`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'PAY_JAIL_FINE',
      { playerId },
      description
    );

    return { state: savedState, log: description };
  }
}
