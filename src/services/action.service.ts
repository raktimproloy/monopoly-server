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

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];
    let initialLog = '';


    const dice: [number, number] = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1
    ];

    const { newState: updatedState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      newState,
      playerId,
      dice,
      tiles
    );

    let finalState = updatedState;
    let finalDescription = initialLog + description;

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount);
      finalState = rentResult.newState;
      finalDescription = rentResult.description;
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
   * Dev-only feature: Add funds to a player's balance.
   */
  async devAddFunds(roomId: string, playerId: string, amount: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.players[playerId].balance += amount;

    const description = `🔧 DEV: ${player.name}-কে ৳${amount} প্রদান করা হয়েছে।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'DEV_ADD_FUNDS',
      { amount },
      description
    );

    return { state: savedState, log: description };
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
      finalDescription = rentResult.description;
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
      finalDescription = rentResult.description;
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
    let description = '';

    // Check if the player rolled doubles and wasn't sent to jail (doubleRollCount > 0)
    if (newState.dice && newState.dice[0] === newState.dice[1] && newState.doubleRollCount > 0) {
      newState.turnStatus = 'MUST_ROLL';
      newState.dice = [0, 0]; // reset dice visually
      description = `${player.name} ডাবল পাওয়ায় আবার চাল দেবেন!`;
      
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

    // Auto jail release logic
    if (newState.players[playerId].inJail) {
      // Only increment jail turns if they started the turn in jail (dice not rolled)
      if (newState.dice[0] === 0 && newState.dice[1] === 0) {
        newState.players[playerId].jailTurns += 1;
        if (newState.players[playerId].jailTurns >= 3) {
          newState.players[playerId].inJail = false;
          newState.players[playerId].jailTurns = 0;
          description += `${player.name} ৩ দান জেলে থাকার পর স্বয়ংক্রিয়ভাবে মুক্তি পেয়েছেন! `;
        }
      }
    }

    const currentIndex = newState.playerOrder.indexOf(playerId);
    let nextIndex = (currentIndex + 1) % newState.playerOrder.length;

    let attempts = 0;
    while (attempts < newState.playerOrder.length) {
      const candidateId = newState.playerOrder[nextIndex];
      const candidate = newState.players[candidateId];

      if (candidate.isBankrupt) {
        nextIndex = (nextIndex + 1) % newState.playerOrder.length;
        attempts++;
        continue;
      }

      if (candidate.skipTurns && candidate.skipTurns > 0) {
        candidate.skipTurns -= 1;
        description += `${candidate.name} অবসরে থাকায় এই দানটি দিতে পারলেন না। `;
        nextIndex = (nextIndex + 1) % newState.playerOrder.length;
        attempts++;
        continue;
      }
      break;
    }

    const nextPlayerId = newState.playerOrder[nextIndex];
    newState.currentTurnPlayerId = nextPlayerId;
    if (newState.players[nextPlayerId].inJail) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    } else {
      newState.turnStatus = 'MUST_ROLL';
    }
    newState.doubleRollCount = 0;
    newState.dice = [0, 0]; // reset dice visually for next player

    // Don Power Expiration Logic
    if (newState.activeDonPower) {
      newState.activeDonPower.remainingRounds -= 1;
      if (newState.activeDonPower.remainingRounds <= 0) {
        description += ` 🚔 Don power expired! The property has been returned to its original owner.`;
        newState.activeDonPower = null;
      }
    }

    description += generateLog('turnEnded', {
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
      if (newState.players[nextPlayerId].inJail) {
        newState.turnStatus = 'MUST_ACT_OR_END';
      } else {
        newState.turnStatus = 'MUST_ROLL';
      }
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
    newState.governmentBank.balance += 50;
    if (newState.settings.freeParkingCashPool) {
      newState.freeParkingPool = (newState.freeParkingPool || 0) + 50;
    }

    let description = generateLog('paidJailFine', {
      playerName: pState.name
    });

    const currentIndex = newState.playerOrder.indexOf(playerId);
    let nextIndex = (currentIndex + 1) % newState.playerOrder.length;
    let attempts = 0;
    while (attempts < newState.playerOrder.length) {
      const candidateId = newState.playerOrder[nextIndex];
      const candidate = newState.players[candidateId];

      if (candidate.isBankrupt) {
        nextIndex = (nextIndex + 1) % newState.playerOrder.length;
        attempts++;
        continue;
      }
      if (candidate.skipTurns && candidate.skipTurns > 0) {
        candidate.skipTurns -= 1;
        description += ` ${candidate.name} অবসরে থাকায় এই দানটি দিতে পারলেন না।`;
        nextIndex = (nextIndex + 1) % newState.playerOrder.length;
        attempts++;
        continue;
      }
      break;
    }

    const nextPlayerId = newState.playerOrder[nextIndex];
    newState.currentTurnPlayerId = nextPlayerId;
    if (newState.players[nextPlayerId].inJail) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    } else {
      newState.turnStatus = 'MUST_ROLL';
    }
    newState.doubleRollCount = 0;
    newState.dice = [0, 0];

    description += ` এবার ${newState.players[nextPlayerId].name}-এর দান।`;

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
        newState.governmentBank.balance -= (card.value || 0);
        break;
      case 'DEDUCT_MONEY':
        player.balance -= (card.value || 0);
        newState.governmentBank.balance += (card.value || 0);
        if (newState.settings.freeParkingCashPool) {
          newState.freeParkingPool = (newState.freeParkingPool || 0) + (card.value || 0);
        }
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
              newState.governmentBank.balance -= 300;
              description += ` এবং ঠিক 'শুরু' (GO) ঘরে এসে থেমেছেন, তাই ৳300 বোনাস পেয়েছেন।`;
            } else {
              player.balance += 200; // Passed GO
              newState.governmentBank.balance -= 200;
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
      case 'BECOME_A_DON':
        player.powerCards = player.powerCards || [];
        player.powerCards.push('BECOME_A_DON');
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

  /**
   * DEV: Gives a specific power card to a player.
   */
  async devGivePowerCard(roomId: string, playerId: string, cardType: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const player = newState.players[playerId];
    
    if (!player) throw new Error(`Player ${playerId} not found.`);

    player.powerCards = player.powerCards || [];
    player.powerCards.push(cardType);

    const description = `🔧 DEV: ${player.name} has been granted the ${cardType} power card.`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'DEV_GIVE_POWER_CARD',
      { cardType },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Uses a power card.
   */
  async usePowerCard(roomId: string, playerId: string, cardType: string, payload: any): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const player = newState.players[playerId];
    
    if (!player) throw new Error(`Player ${playerId} not found.`);
    if (!player.powerCards || !player.powerCards.includes(cardType)) {
      throw new Error(`You do not have the ${cardType} card.`);
    }

    let description = '';

    if (cardType === 'BECOME_A_DON') {
      const targetTileIndex = payload.targetTileIndex;
      const targetProperty = newState.properties[targetTileIndex];

      if (!targetProperty || !targetProperty.ownerId) {
        throw new Error('Target property is not owned by anyone.');
      }
      if (targetProperty.ownerId === playerId) {
        throw new Error('You cannot hijack your own property.');
      }

      // Remove card
      const cardIndex = player.powerCards.indexOf(cardType);
      player.powerCards.splice(cardIndex, 1);

      // Active players count for calculating 3 full rounds (activePlayers * 3 turns)
      const activePlayers = Object.values(newState.players).filter(p => !p.isBankrupt).length;
      const totalTurns = activePlayers * 3;

      newState.activeDonPower = {
        donPlayerId: playerId,
        targetTileIndex: targetTileIndex,
        originalOwnerId: targetProperty.ownerId,
        remainingRounds: totalTurns
      };

      const { tiles } = await this.roomService.loadBoardTemplate();
      const tileName = tiles.find(t => t.index === targetTileIndex)?.name || 'a property';

      description = `🕴️ ${player.name} has become a Don! They hijacked ${tileName} for the next ${totalTurns} turns!`;
    } else {
      throw new Error(`Unknown power card type: ${cardType}`);
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'USE_POWER_CARD',
      { cardType, payload },
      description
    );

    return { state: savedState, log: description };
  }
}
