import { RoomService } from './room.service';
import { GameState, BoardTile } from '../types';
import { executeMovement, payRent, calculateRentAtTile, executeRandomPropertyVisit } from '../rules';
import { generateLog } from '../utils/logGenerator';
import { toBanglaNum } from '../utils/format';

const AUTO_END_TURN_DELAY_MS = 800;

export class ActionService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  private scheduleAutoEndTurn(roomId: string, playerId: string, delayMs = AUTO_END_TURN_DELAY_MS): void {
    setTimeout(async () => {
      try {
        const currentState = await this.roomService.getRoomState(roomId);
        if (
          currentState &&
          currentState.currentTurnPlayerId === playerId &&
          currentState.turnStatus === 'MUST_ACT_OR_END'
        ) {
          await this.endTurn(roomId, playerId);
        }
      } catch (_e) {
        // ignore race / stale turn
      }
    }, delayMs);
  }

  /**
   * After a double roll, skip the "end turn" step when no buy decision is pending.
   */
  private applyDoubleRollTurnStatus(state: GameState, playerId: string, tiles: BoardTile[]): GameState {
    const player = state.players[playerId];
    if (!player) return state;

    const isDouble = state.dice[0] === state.dice[1] && state.dice[0] > 0;
    if (!isDouble || state.doubleRollCount <= 0 || player.inJail) return state;
    if (state.turnStatus !== 'MUST_ACT_OR_END') return state;

    const pos = player.position;
    const tile = tiles[pos];
    const prop = state.properties[pos];
    const canBuy =
      tile &&
      ['STREET', 'RAILROAD', 'UTILITY'].includes(tile.type) &&
      !prop?.ownerId;

    if (!canBuy) {
      state.turnStatus = 'MUST_ROLL';
    }

    return state;
  }

  /**
   * Performs the Roll Dice transaction: Rolls, moves, updates tile, applies landing rules.
   */
  async rollDice(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    if (state.turnStatus !== 'MUST_ROLL') {
      throw new Error(`ডাইস রোল করা সম্ভব নয়। বর্তমান স্ট্যাটাস: ${state.turnStatus}।`);
    }

    const { tiles } = await this.roomService.loadBoardTemplate();

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];
    let initialLog = '';


    const dice: [number, number] = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1
    ];

    newState.rollCounter = (newState.rollCounter || 0) + 1;

    const { newState: updatedState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      newState,
      playerId,
      dice,
      tiles
    );

    let finalState = updatedState;
    let finalDescription = initialLog + description;

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const tileIndex = updatedState.players[playerId].position;
      const rentResult = payRent(updatedState, playerId, rentDuePlayerId, rentAmount, tileIndex);
      finalState = rentResult.newState;
      finalDescription = finalDescription + ' ' + rentResult.description;
    }

    finalState = this.applyDoubleRollTurnStatus(finalState, playerId, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'ROLL_DICE',
      { dice, originalPlayer: playerId },
      finalDescription
    );

    if (nextAction === 'AUTO_END_TURN') {
      this.scheduleAutoEndTurn(roomId, playerId);
    }

    return { state: savedState, log: finalDescription };
  }

  /**
   * Dev-only feature: Add funds to a player's balance.
   */
  async devAddFunds(roomId: string, playerId: string, amount: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.players[playerId].balance += amount;

    const description = `🔧 DEV: ${player.name}-কে ৳${toBanglaNum(amount)} প্রদান করা হয়েছে।`;

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
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

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
    let finalDescription = `[DEV] ${newState.players[playerId].name} টেলিপোর্ট করে ${targetIndex} নম্বর টাইল-এ গেছেন।`;
    
    // Extract just the landing logic from the movement rule's description
    const actionMatch = description.match(/\.\s*(Landed on.+|Paid.+|Sent directly to Jail.+)/);
    if (actionMatch) {
      finalDescription += ` ${actionMatch[1]}`;
    }

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const tileIndex = newState.players[playerId].position;
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount, tileIndex);
      finalState = rentResult.newState;
      finalDescription = finalDescription + ' ' + rentResult.description;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'DEV_TELEPORT',
      { targetIndex },
      finalDescription
    );

    if (nextAction === 'AUTO_END_TURN') {
      this.scheduleAutoEndTurn(roomId, playerId, 2500);
    }

    return { state: savedState, log: finalDescription };
  }

  /**
   * Dev-only feature: Forces a dice roll with manually provided integers.
   */
  async devRollDice(roomId: string, playerId: string, d1: number, d2: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const dice: [number, number] = [d1, d2];
    state.rollCounter = (state.rollCounter || 0) + 1;

    const { newState, description, nextAction, rentDuePlayerId, rentAmount } = executeMovement(
      state,
      playerId,
      dice,
      tiles
    );

    let finalState = newState;
    let finalDescription = `[DEV] ${description}`;

    if (nextAction === 'PAY_RENT' && rentDuePlayerId && rentAmount) {
      const tileIndex = newState.players[playerId].position;
      const rentResult = payRent(newState, playerId, rentDuePlayerId, rentAmount, tileIndex);
      finalState = rentResult.newState;
      finalDescription = finalDescription + ' ' + rentResult.description;
    }

    finalState = this.applyDoubleRollTurnStatus(finalState, playerId, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'DEV_ROLL_DICE',
      { dice, originalPlayer: playerId },
      finalDescription
    );

    if (nextAction === 'AUTO_END_TURN') {
      this.scheduleAutoEndTurn(roomId, playerId, 2500);
    }

    return { state: savedState, log: finalDescription };
  }

  /**
   * Ends the current turn and rolls the state over to the next active player.
   */
  async endTurn(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];

    // Block ending turn while lottery is active
    if (state.activeLottery && !state.activeLottery.isComplete) {
      throw new Error('লটারি শেষ হয়নি! লটারি ম্যাচিং সম্পূর্ণ না হওয়া পর্যন্ত টার্ন শেষ করা যাবে না।');
    }

    if (player.balance < 0) {
      throw new Error('আপনার ব্যালেন্স নেতিবাচক, টার্ন শেষ করা সম্ভব নয়! সম্পত্তি বিক্রি করুন বা দেউলিয়া ঘোষণা করুন।');
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
    newState.turnStatus = 'MUST_ROLL';
    newState.doubleRollCount = 0;
    newState.dice = [0, 0]; // reset dice visually for next player

    // Don Power Expiration Logic
    if (newState.activeDonPower) {
      newState.activeDonPower.remainingRounds -= 1;
      if (newState.activeDonPower.remainingRounds <= 0) {
        description += ` 🚔 ডন পাওয়ারের মেয়াদ শেষ! সম্পত্তি তার আসল মালিকের কাছে ফেরত গেছে।`;
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
   * Declares bankruptcy for a player. All properties return to the bank; no creditor receives assets or unpaid debt.
   */
  async declareBankruptcy(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);
    if (player.isBankrupt) throw new Error(`প্লেয়ার ${playerId} ইতিমধ্যে দেউলিয়া।`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    newState.pendingRentOwed = null;

    // Legacy: reverse overpayment if balance somehow negative from other charges
    if (pState.balance < 0) {
      const { tiles: boardTiles } = await this.roomService.loadBoardTemplate();
      const rentInfo = calculateRentAtTile(newState, pState.position, boardTiles);
      if (rentInfo && rentInfo.ownerId !== playerId) {
        const creditor = newState.players[rentInfo.ownerId];
        if (creditor) {
          const clawback = Math.min(creditor.balance, Math.abs(pState.balance));
          creditor.balance = Math.max(0, creditor.balance - clawback);
        }
      }
    }

    pState.isBankrupt = true;
    pState.balance = 0;

    // Return all properties to the bank (free — no player receives them)
    const playerProperties = Object.values(newState.properties).filter(
      (p) => p.ownerId === playerId
    );
    playerProperties.forEach((p) => {
      delete newState.properties[p.tileIndex];
    });

    // Clear Don power if the bankrupt player was the Don
    if (newState.activeDonPower && newState.activeDonPower.donPlayerId === playerId) {
      newState.activeDonPower = null;
    }

    let description = generateLog('bankruptcyDeclared', {
      playerName: pState.name
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
      description += ` এখন ${newState.players[nextPlayerId].name}-এর চাল।`;
    }

    // Check if game is finished (only 1 non-bankrupt player left)
    const activePlayers = Object.values(newState.players).filter((p) => !p.isBankrupt);
    if (activePlayers.length <= 1) {
      newState.gameStatus = 'FINISHED';
      newState.winnerId = activePlayers[0]?.id || null;
      if (newState.winnerId) {
        description += ` খেলা শেষ! ${newState.players[newState.winnerId].name} বিজয়ী হয়েছেন!`;
      }
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'DECLARE_BANKRUPTCY',
      { bankruptPlayerId: playerId },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Pays a fine of $50 to get out of Jail.
   */
  async payJailFine(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);
    if (!player.inJail) throw new Error(`প্লেয়ার ${playerId} জেলে নেই।`);
    if (player.balance < 50) throw new Error(`পর্যাপ্ত ব্যালেন্স নেই। জেল থেকে বের হওয়ার জরিমানা ৳৫০, কিন্তু আপনার আছে ৳${toBanglaNum(player.balance)}।`);

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
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    if (state.turnStatus !== 'MUST_RESOLVE_CARD') {
      throw new Error(`কার্ড রিজলভ করা সম্ভব নয়। স্ট্যাটাস: ${state.turnStatus}।`);
    }
    if (state.currentTurnPlayerId !== playerId) {
      throw new Error(`এখন আপনার কার্ড রিজলভ করার পালা নয়।`);
    }

    const card = state.drawnCard;
    if (!card) {
      throw new Error(`রিজলভ করার জন্য কোনো কার্ড নেই।`);
    }

    const { tiles: boardTiles } = await this.roomService.loadBoardTemplate();
    let newState = JSON.parse(JSON.stringify(state)) as GameState;
    const player = newState.players[playerId];

    const logKey = card.type === 'CHANCE' ? 'chanceDrawn' : 'chestDrawn';
    let description = generateLog(logKey, { cardText: card.text });

    switch (card.action) {
      case 'ADD_MONEY':
        player.balance += (card.value || 0);
        newState.governmentBank.balance -= (card.value || 0);
        description += ` (+৳${toBanglaNum(card.value || 0)} পেয়েছেন)`;
        break;
      case 'DEDUCT_MONEY':
        player.balance -= (card.value || 0);
        newState.governmentBank.balance += (card.value || 0);
        if (newState.settings.freeParkingCashPool) {
          newState.freeParkingPool = (newState.freeParkingPool || 0) + (card.value || 0);
        }
        description += ` (-৳${toBanglaNum(card.value || 0)} দিয়েছেন)`;
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
              description += ` এবং ঠিক 'শুরু' (GO) ঘরে এসে থেমেছেন, তাই ৳${toBanglaNum(300)} বোনাস পেয়েছেন।`;
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
      case 'BIRTHDAY_GIFT': {
        const giftAmount = card.value || 50;
        const activeOtherPlayers = Object.values(newState.players).filter(
          (p) => p.id !== playerId && !p.isBankrupt
        );
        for (const otherPlayer of activeOtherPlayers) {
          otherPlayer.balance -= giftAmount;
          player.balance += giftAmount;
        }
        description += ` (অন্যান্য ${toBanglaNum(activeOtherPlayers.length)} জন সক্রিয় খেলোয়াড় প্রত্যেকে আপনাকে ৳${toBanglaNum(giftAmount)} করে দিয়েছেন)`;
        break;
      }
      case 'NEW_JOB_CELEBRATION': {
        const giftAmount = card.value || 50;
        const activeOtherPlayers = Object.values(newState.players).filter(
          (p) => p.id !== playerId && !p.isBankrupt
        );
        for (const otherPlayer of activeOtherPlayers) {
          player.balance -= giftAmount;
          otherPlayer.balance += giftAmount;
        }
        description += ` (আপনি অন্যান্য ${toBanglaNum(activeOtherPlayers.length)} জন সক্রিয় খেলোয়াড়কে প্রত্যেকে ৳${toBanglaNum(giftAmount)} করে দিয়েছেন)`;
        break;
      }
      case 'VISIT_RANDOM_PROPERTY': {
        if (card.value === undefined) {
          throw new Error('র্যান্ডম সম্পত্তি কার্ডের গন্তব্য নির্ধারণ করা যায়নি।');
        }

        const visit = executeRandomPropertyVisit(newState, playerId, card.value, boardTiles);
        newState = visit.newState;
        description += visit.description;

        if (visit.nextAction === 'PAY_RENT' && visit.rentDuePlayerId && visit.rentAmount) {
          const rentResult = payRent(
            newState,
            playerId,
            visit.rentDuePlayerId,
            visit.rentAmount,
            card.value
          );
          newState = rentResult.newState;
          description += ' ' + rentResult.description;
        }
        break;
      }
    }

    if (card.isSecret) {
      if (card.action === 'GET_OUT_OF_JAIL_FREE') {
        description = `${player.name} পার্ডন কার্ড পেয়েছেন!`;
      } else if (card.action === 'BECOME_A_DON') {
        description = `${player.name} পাওয়ার কার্ড পেয়েছেন!`;
      } else {
        description = `${player.name} একটি গোপন কার্ড পেয়েছেন!`;
      }
    } else {
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

    if (card.action === 'GO_TO_JAIL') {
      this.scheduleAutoEndTurn(roomId, playerId);
    }

    return { state: savedState, log: description };
  }

  /**
   * Starts the lottery (hasStarted = true).
   */
  async startLottery(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    if (!state.activeLottery) {
      throw new Error('কোনো লটারি সচল নেই।');
    }
    if (state.activeLottery.hasStarted) {
      throw new Error('লটারি ইতিমধ্যে শুরু হয়েছে।');
    }
    if (state.currentTurnPlayerId !== playerId) {
      throw new Error('এখন আপনার লটারি শুরু করার পালা নয়।');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    newState.activeLottery!.hasStarted = true;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'START_LOTTERY',
      {},
      `🎰 ${newState.players[playerId].name} লটারি শুরু করেছেন!`
    );

    return { state: savedState, log: `🎰 ${newState.players[playerId].name} লটারি শুরু করেছেন!` };
  }

  /**
   * Reveals the next character of the lottery winning code.
   * Called repeatedly (one at a time) until all 5 characters are revealed.
   */
  async revealLotteryDigit(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    if (!state.activeLottery) {
      throw new Error('লটারি সচল নেই।');
    }
    if (!state.activeLottery.hasStarted) {
      throw new Error('লটারি শুরু হয়নি।');
    }
    if (state.activeLottery.isComplete) {
      throw new Error('লটারি ইতিমধ্যে শেষ হয়েছে।');
    }
    if (state.currentTurnPlayerId !== playerId) {
      throw new Error('আপনার লটারি দেখার পালা নয়।');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const lottery = newState.activeLottery!;
    const player = newState.players[playerId];

    // Reveal next character
    lottery.revealedCount += 1;

    let description = '';
    const revealedIdx = lottery.revealedCount - 1;
    const playerChar = lottery.playerTicket[revealedIdx];
    const winChar = lottery.winningCode[revealedIdx];
    const matched = playerChar === winChar;

    if (matched) {
      lottery.prizeAmount += 100;
    }

    description = `🎰 লটারি ডিজিট ${toBanglaNum(lottery.revealedCount)}/৫: ${winChar} ${matched ? '✅ (+৳১০০)' : '❌'}`;

    // Check if all 5 revealed
    if (lottery.revealedCount >= 5) {
      lottery.isComplete = true;
      lottery.isWinner = lottery.prizeAmount > 0;

      if (lottery.isWinner) {
        player.balance += lottery.prizeAmount;
        newState.governmentBank.balance -= lottery.prizeAmount;
        description = `🎰🎉 ${player.name} লটারিতে ৳${toBanglaNum(lottery.prizeAmount)} জিতেছেন!`;
      } else {
        description = `🎰 ${player.name} এর লটারি শেষ — কোনো মিল হয়নি।`;
      }

      newState.turnStatus = 'MUST_ACT_OR_END';
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'LOTTERY_REVEAL',
      { revealedCount: lottery.revealedCount },
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
      const targetTileIndexes = payload.targetTileIndexes as number[];
      if (!targetTileIndexes || !Array.isArray(targetTileIndexes) || targetTileIndexes.length === 0 || targetTileIndexes.length > 3) {
        throw new Error('Invalid target properties.');
      }
      
      const originalOwnerId = newState.properties[targetTileIndexes[0]]?.ownerId;

      for (const index of targetTileIndexes) {
        const targetProperty = newState.properties[index];
        if (!targetProperty || !targetProperty.ownerId) {
          throw new Error('Target property is not owned by anyone.');
        }
        if (targetProperty.ownerId === playerId) {
          throw new Error('You cannot hijack your own property.');
        }
        if (targetProperty.ownerId !== originalOwnerId) {
          throw new Error('All hijacked properties must belong to the same player.');
        }
      }

      // Remove card
      const cardIndex = player.powerCards.indexOf(cardType);
      player.powerCards.splice(cardIndex, 1);

      // Active players count for calculating 1 full round (activePlayers * 1 turn)
      const activePlayers = Object.values(newState.players).filter(p => !p.isBankrupt).length;
      const totalTurns = activePlayers * 1;

      newState.activeDonPower = {
        donPlayerId: playerId,
        targetTileIndexes: targetTileIndexes,
        originalOwnerId: originalOwnerId!,
        remainingRounds: totalTurns
      };

      const { tiles } = await this.roomService.loadBoardTemplate();
      const tileNames = targetTileIndexes.map(index => tiles.find(t => t.index === index)?.name || 'a property').join(', ');

      description = `🕴️ ${player.name} has become a Don! They hijacked ${tileNames} for the next ${totalTurns} turns!`;
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

  /**
   * Casts or changes a kick vote. When 50%+ of active players vote for someone, they are eliminated.
   */
  async castKickVote(
    roomId: string,
    voterId: string,
    targetPlayerId: string | null
  ): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);
    if (state.gameStatus !== 'ACTIVE') throw new Error('Kick votes are only allowed during active games.');

    const voter = state.players[voterId];
    if (!voter || voter.isBankrupt) throw new Error('You cannot vote while bankrupt.');

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    if (!newState.kickVotes) newState.kickVotes = {};

    if (targetPlayerId === null) {
      delete newState.kickVotes[voterId];
    } else {
      if (targetPlayerId === voterId) throw new Error('You cannot vote to kick yourself.');
      const target = newState.players[targetPlayerId];
      if (!target || target.isBankrupt) throw new Error('Invalid kick target.');
      newState.kickVotes[voterId] = targetPlayerId;
    }

    let description = targetPlayerId
      ? `${voter.name} ${newState.players[targetPlayerId]?.name}-কে কিক করার জন্য ভোট দিয়েছেন।`
      : `${voter.name} তাদের কিক ভোট প্রত্যাহার করেছেন।`;

    const activePlayers = Object.values(newState.players).filter((p) => !p.isBankrupt);
    const requiredVotes = Math.ceil(activePlayers.length / 2);

    const voteCounts: Record<string, number> = {};
    for (const [vId, tId] of Object.entries(newState.kickVotes)) {
      const v = newState.players[vId];
      const t = newState.players[tId];
      if (!v || v.isBankrupt || !t || t.isBankrupt) continue;
      voteCounts[tId] = (voteCounts[tId] || 0) + 1;
    }

    let kickedPlayerId: string | null = null;
    for (const [tId, count] of Object.entries(voteCounts)) {
      if (count >= requiredVotes) {
        kickedPlayerId = tId;
        break;
      }
    }

    if (kickedPlayerId) {
      const kicked = newState.players[kickedPlayerId];
      kicked.isBankrupt = true;
      kicked.balance = 0;

      Object.values(newState.properties)
        .filter((p) => p.ownerId === kickedPlayerId)
        .forEach((p) => delete newState.properties[p.tileIndex]);

      newState.kickVotes = {};

      if (newState.currentTurnPlayerId === kickedPlayerId) {
        const currentIndex = newState.playerOrder.indexOf(kickedPlayerId);
        let nextIndex = (currentIndex + 1) % newState.playerOrder.length;
        let attempts = 0;
        while (newState.players[newState.playerOrder[nextIndex]].isBankrupt && attempts < newState.playerOrder.length) {
          nextIndex = (nextIndex + 1) % newState.playerOrder.length;
          attempts++;
        }
        const nextPlayerId = newState.playerOrder[nextIndex];
        newState.currentTurnPlayerId = nextPlayerId;
        newState.turnStatus = newState.players[nextPlayerId].inJail ? 'MUST_ACT_OR_END' : 'MUST_ROLL';
        newState.doubleRollCount = 0;
      }

      const remaining = Object.values(newState.players).filter((p) => !p.isBankrupt);
      description = `${kicked.name} ভোটের মাধ্যমে গেম থেকে বের হয়ে গেছেন!`;
      if (remaining.length <= 1) {
        newState.gameStatus = 'FINISHED';
        newState.winnerId = remaining[0]?.id || null;
        if (newState.winnerId) {
          description += ` গেম শেষ! ${newState.players[newState.winnerId].name} জিতেছেন!`;
        }
      }
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      voterId,
      kickedPlayerId ? 'PLAYER_KICKED' : 'CAST_KICK_VOTE',
      { voterId, targetPlayerId, kickedPlayerId },
      description
    );

    return { state: savedState, log: description };
  }
}
