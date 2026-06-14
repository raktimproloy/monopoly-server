import { GameState, Player, BoardTile } from '../../../shared/types';
import { drawCard, generateLog } from '../utils/logGenerator';

export interface MovementResult {
  newState: GameState;
  description: string;
  nextAction: 'BUY_PROPERTY' | 'PAY_RENT' | 'NONE' | 'RESOLVE_CARD';
  rentDuePlayerId?: string;
  rentAmount?: number;
}

/**
 * Executes movement rules on the current game state for a rolling player.
 * Server authoritative, pure business logic.
 */
export function executeMovement(
  state: GameState,
  playerId: string,
  diceRoll: [number, number],
  boardTiles: BoardTile[]
): MovementResult {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players[playerId];
  
  if (!player) {
    throw new Error(`Player ${playerId} not found in game state`);
  }

  const [d1, d2] = diceRoll;
  const isDouble = d1 === d2;
  let description = generateLog('rolledDice', { playerName: player.name, dice1: d1, dice2: d2 });

  // Update dice in state
  newState.dice = diceRoll;

  const wasInJail = player.inJail;

  // 1. Jail Logic
  if (wasInJail) {
    if (isDouble) {
      player.inJail = false;
      player.jailTurns = 0;
      description += ` ডাবল পাওয়ায় জেল থেকে মুক্তি পেয়েছেন!`;
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= 3) {
        // Must pay $50 to get out on 3rd fail
        player.inJail = false;
        player.jailTurns = 0;
        player.balance -= 50;
      description += ` পরপর ৩ বার ডাবল পেতে ব্যর্থ হয়েছেন। ৳50 জরিমানা দিয়ে জেল থেকে ছাড়া পেলেন।`;
      } else {
        description += ` এখনও জেলে আছেন (চাল ${player.jailTurns}/3)।`;
        newState.turnStatus = 'MUST_ACT_OR_END';
        return { newState, description, nextAction: 'NONE' };
      }
    }
  }

  // 2. Double Roll Chain Check
  if (isDouble && !wasInJail) {
    newState.doubleRollCount += 1;
    if (newState.doubleRollCount >= 3) {
      // 3 doubles in a row sends player to jail
      player.inJail = true;
      player.jailTurns = 0;
      player.position = 10; // Jail position index
      newState.doubleRollCount = 0;
      newState.turnStatus = 'MUST_ACT_OR_END';
      description += ` পরপর ৩ বার ডাবল পাওয়ায় সোজা জেলে পাঠানো হয়েছে!`;
      return { newState, description, nextAction: 'NONE' };
    }
  } else {
    newState.doubleRollCount = 0;
  }

  // 3. Move Player
  const oldPosition = player.position;
  const totalTiles = boardTiles.length;
  const newPosition = (oldPosition + d1 + d2) % totalTiles;
  player.position = newPosition;

  // Check if passed GO
  if (newPosition < oldPosition) {
    if (newPosition === 0) {
      player.balance += 300;
      description += ` এবং ঠিক 'শুরু' (GO) ঘরে এসে থেমেছেন, তাই ৳300 বোনাস পেয়েছেন।`;
    } else {
      player.balance += 200;
      description += generateLog('goCollected', { oldPos: oldPosition, newPos: newPosition });
    }
  } else {
    description += generateLog('movedTo', { tileName: boardTiles[newPosition]?.name || 'tile' });
  }

  // 4. Evaluate destination tile
  const destTile = boardTiles[newPosition];
  let nextAction: 'BUY_PROPERTY' | 'PAY_RENT' | 'NONE' | 'RESOLVE_CARD' = 'NONE';
  let rentDuePlayerId: string | undefined;
  let rentAmount: number | undefined;

  if (destTile.type === 'GO_TO_JAIL') {
    player.inJail = true;
    player.jailTurns = 0;
    player.position = 10; // Jail space
    newState.doubleRollCount = 0;
    description += ` সোজা জেলে পাঠানো হয়েছে!`;
    newState.turnStatus = 'MUST_ACT_OR_END';
    return { newState, description, nextAction: 'NONE' };
  }

  if (destTile.type === 'TAX') {
    const taxCost = destTile.price || 100;
    player.balance -= taxCost;
    description += generateLog('taxPaid', { tileName: destTile.name, taxAmount: taxCost });
  }

  // Draw Card Logic (Chance / Chest)
  if (destTile.type === 'CHANCE' || destTile.type === 'CHEST') {
    const deckType = destTile.type === 'CHANCE' ? 'chance' : 'communityChest';
    const card = drawCard(deckType);
    
    if (card) {
      newState.drawnCard = {
        type: destTile.type,
        text: card.text,
        action: card.action,
        value: card.value,
        isSecret: card.isSecret
      };
      
      // Do NOT apply effects or generate log yet. That happens after OK.
      description += ` এবং একটি কার্ড তুলেছেন।`;
      nextAction = 'RESOLVE_CARD';
      newState.turnStatus = 'MUST_RESOLVE_CARD';
      return { newState, description, nextAction };
    }
  }

  // Check if tile is a purchasable property (STREET, RAILROAD, UTILITY)
  const isPurchasable = ['STREET', 'RAILROAD', 'UTILITY'].includes(destTile.type);
  if (isPurchasable) {
    const propState = newState.properties[newPosition];
    
    if (!propState || !propState.ownerId) {
      // Unowned
      nextAction = 'BUY_PROPERTY';
      description += generateLog('landedUnownedProperty', { tileName: destTile.name, price: destTile.price });
    } else if (propState.ownerId !== playerId && !propState.isMortgaged) {
      // Owned by someone else, and not mortgaged -> Rent is due
      nextAction = 'PAY_RENT';
      rentDuePlayerId = propState.ownerId;
      
      // Calculate Rent
      if (destTile.type === 'STREET') {
        const houses = propState.houses;
        rentAmount = destTile.rent ? destTile.rent[houses] : 0;
        
        if (houses === 0 && newState.settings.doubleRentOnCompleteSet) {
          const groupTiles = boardTiles.filter(t => t.group === destTile.group);
          const ownsFullSet = groupTiles.every(t => {
            const p = newState.properties[t.index];
            return p && p.ownerId === propState.ownerId;
          });
          if (ownsFullSet) {
            rentAmount *= 2;
          }
        }
      } else if (destTile.type === 'RAILROAD') {
        // Count owned railroads
        const ownerRailroads = Object.values(newState.properties).filter(
          (p) => p.ownerId === propState.ownerId && boardTiles[p.tileIndex].type === 'RAILROAD'
        ).length;
        rentAmount = (destTile.rent ? destTile.rent[ownerRailroads - 1] : 25) || 25;
      } else if (destTile.type === 'UTILITY') {
        // Count owned utilities
        const ownerUtilities = Object.values(newState.properties).filter(
          (p) => p.ownerId === propState.ownerId && boardTiles[p.tileIndex].type === 'UTILITY'
        ).length;
        const multiplier = ownerUtilities === 2 ? 10 : 4;
        rentAmount = (d1 + d2) * multiplier;
      }

      if (rentAmount && rentAmount > 0) {
        description += generateLog('landedOwnedPropertyRentDue', {
          tileName: destTile.name,
          ownerName: newState.players[propState.ownerId]?.name || 'another player',
          rentAmount
        });
      }
    } else if (propState.ownerId === playerId) {
      description += generateLog('landedOwned', { tileName: destTile.name });
    } else if (propState.isMortgaged) {
      description += generateLog('landedMortgaged', { 
        tileName: destTile.name,
        ownerName: newState.players[propState.ownerId]?.name || 'owner'
      });
    }
  }

  // Update status
  if (nextAction === 'NONE') {
    newState.turnStatus = 'MUST_ACT_OR_END';
  } else if (nextAction === 'PAY_RENT') {
    newState.turnStatus = 'BANKRUPTCY_PENDING'; // player must resolve rent before turn actions
  } else if (nextAction === 'BUY_PROPERTY') {
    newState.turnStatus = 'MUST_ACT_OR_END';
  }

  return {
    newState,
    description,
    nextAction,
    rentDuePlayerId,
    rentAmount
  };
}
