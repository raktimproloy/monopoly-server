import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { executeMovement, payRent } from '../rules';
import { generateLog } from '../utils/logGenerator';

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

    // Check if the player rolled doubles and wasn't sent to jail (doubleRollCount > 0)
    if (newState.dice && newState.dice[0] === newState.dice[1] && newState.doubleRollCount > 0) {
      newState.turnStatus = 'MUST_ROLL';
      newState.dice = [0, 0]; // reset dice visually
      const description = `${player.name} ডাবল পাওয়ায় আবার চাল দেবেন!`;
      
      const savedState = await this.roomService.updateRoomState(
        roomId,
        newState,
        playerId,
        'END_TURN_DOUBLE',
        { endedPlayer: playerId, nextPlayer: playerId },
        description
      );
      
      return { state: savedState, log: description };
    }

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
    newState.dice = [0, 0]; // reset dice visually for next player

    const description = generateLog('turnEnded', {
      playerName: player.name,
      nextPlayerName: newState.players[nextPlayerId].name
    });

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

    let description = generateLog('bankruptcyDeclared', {
      playerName: pState.name,
      creditorName
    });

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

    const description = generateLog('paidJailFine', {
      playerName: pState.name
    });

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

  /**
   * Resolves a drawn Chance or Chest card after the user clicks OK.
   */
  async resolveCard(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    if (state.turnStatus !== 'MUST_RESOLVE_CARD') {
      throw new Error(`Cannot resolve card. Turn status is ${state.turnStatus}.`);
    }
    if (state.currentTurnPlayerId !== playerId) {
      throw new Error(`Not your turn to resolve card.`);
    }

    const card = state.drawnCard;
    if (!card) {
      throw new Error(`No card drawn to resolve.`);
    }

    const { tiles: boardTiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const player = newState.players[playerId];

    const logKey = card.type === 'CHANCE' ? 'chanceDrawn' : 'chestDrawn';
    let description = generateLog(logKey, { cardText: card.text });

    switch (card.action) {
      case 'ADD_MONEY':
        player.balance += (card.value || 0);
        break;
      case 'DEDUCT_MONEY':
        player.balance -= (card.value || 0);
        break;
      case 'GO_TO_JAIL':
        player.inJail = true;
        player.jailTurns = 0;
        player.position = 10;
        newState.doubleRollCount = 0;
        description += generateLog('sentToJail', {});
        break;
      case 'MOVE_TO':
        if (card.value !== undefined) {
          const newPos = card.value;
          if (newPos < player.position) {
            if (newPos === 0) {
              player.balance += 300;
              description += ` এবং ঠিক 'শুরু' (GO) ঘরে এসে থেমেছেন, তাই ৳300 বোনাস পেয়েছেন।`;
            } else {
              player.balance += 200; // Passed GO
              description += generateLog('movedTo', { tileName: boardTiles[newPos]?.name || 'tile' });
            }
          } else {
            description += generateLog('movedTo', { tileName: boardTiles[newPos]?.name || 'tile' });
          }
          player.position = newPos;
        }
        break;
      case 'GET_OUT_OF_JAIL_FREE':
        player.getOutOfJailFreeCards = (player.getOutOfJailFreeCards || 0) + 1;
        break;
    }

    if (card.isSecret) {
      description = `${player.name} একটি গোপন কার্ড পেয়েছেন!`;
    } else {
      // Prepend player name
      description = `${player.name} ${description}`;
    }

    newState.drawnCard = null;
    newState.turnStatus = 'MUST_ACT_OR_END';

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'RESOLVE_CARD',
      { cardAction: card.action },
      description
    );

    return { state: savedState, log: description };
  }
}
