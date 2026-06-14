import { GameState, Player, BoardTile } from '../../../shared/types';
import { drawCard, generateLog } from '../utils/logGenerator';

export interface MovementResult {
  newState: GameState;
  description: string;
  nextAction: 'BUY_PROPERTY' | 'PAY_RENT' | 'NONE';
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

  // 1. Jail Logic
  if (player.inJail) {
    if (isDouble) {
      player.inJail = false;
      player.jailTurns = 0;
      description += ` and got out of Jail by rolling doubles!`;
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= 3) {
        // Must pay $50 to get out on 3rd fail
        player.inJail = false;
        player.jailTurns = 0;
        player.balance -= 50;
      description += ` failed to roll doubles for 3 turns. Paid ৳50 to get out of Jail.`;
      } else {
        description += ` remains in Jail (turn ${player.jailTurns}/3).`;
        newState.turnStatus = 'MUST_ACT_OR_END';
        return { newState, description, nextAction: 'NONE' };
      }
    }
  }

  // 2. Double Roll Chain Check
  if (isDouble && !player.inJail) {
    newState.doubleRollCount += 1;
    if (newState.doubleRollCount >= 3) {
      // 3 doubles in a row sends player to jail
      player.inJail = true;
      player.jailTurns = 0;
      player.position = 10; // Jail position index
      newState.doubleRollCount = 0;
      newState.turnStatus = 'MUST_ACT_OR_END';
      description += `. Rolled doubles 3 times in a row! Sent to Jail.`;
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
    player.balance += 200;
    description += generateLog('goCollected', { oldPos: oldPosition, newPos: newPosition });
  } else {
    description += generateLog('movedTo', { tileName: boardTiles[newPosition]?.name || 'tile' });
  }

  // 4. Evaluate destination tile
  const destTile = boardTiles[newPosition];
  let nextAction: 'BUY_PROPERTY' | 'PAY_RENT' | 'NONE' = 'NONE';
  let rentDuePlayerId: string | undefined;
  let rentAmount: number | undefined;

  if (destTile.type === 'GO_TO_JAIL') {
    player.inJail = true;
    player.jailTurns = 0;
    player.position = 10; // Jail space
    newState.doubleRollCount = 0;
    description += ` Landed on "Go to Jail"! Sent directly to Jail.`;
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
      const logKey = destTile.type === 'CHANCE' ? 'chanceDrawn' : 'chestDrawn';
      description += generateLog(logKey, { cardText: card.text });

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
              player.balance += 200; // Passed GO
            }
            player.position = newPos;
            description += generateLog('movedTo', { tileName: boardTiles[newPos]?.name || 'tile' });
          }
          break;
        case 'GET_OUT_OF_JAIL_FREE':
          player.getOutOfJailFreeCards = (player.getOutOfJailFreeCards || 0) + 1;
          break;
      }
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
