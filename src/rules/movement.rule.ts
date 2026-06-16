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
      description += ` ➡️ ডাবলে জেল থেকে মুক্তি!`;
    } else {
      player.jailTurns += 1;
      if (player.jailTurns >= 3) {
        // Must pay $50 to get out on 3rd fail
        player.inJail = false;
        player.jailTurns = 0;
        player.balance -= 50;
      description += ` ➡️ জেল জরিমানা ৳50।`;
      } else {
        description += ` ➡️ জেলে আছেন (${player.jailTurns}/3)।`;
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
      description += ` ➡️ ৩ ডাবলে সোজা জেলে!`;
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
      if (newState.marketCrash?.active) {
        description += ` ➡️ GO তে থেমে ৳0 বোনাস (মার্কেট ক্র্যাশ)!`;
      } else {
        let addedMoney = 300;
        let loanDeducted = 0;
        if (player.loan && player.loan.remainingTurns > 0) {
          loanDeducted = player.loan.deductionPerTurn;
          player.loan.remainingAmount -= loanDeducted;
          player.loan.remainingTurns -= 1;
          if (player.loan.remainingTurns <= 0 || player.loan.remainingAmount <= 0) {
            player.loan = undefined;
          }
        }
        player.balance += (addedMoney - loanDeducted);
        newState.governmentBank.balance -= (addedMoney - loanDeducted);
        description += ` ➡️ GO তে থেমে ৳300 বোনাস!`;
        if (loanDeducted > 0) {
          description += ` 🏦 (লোন বাবদ ৳${loanDeducted} কাটা হয়েছে)`;
        }
      }
    } else {
      if (newState.marketCrash?.active) {
        description += ` (মার্কেট ক্র্যাশের জন্য GO বোনাস নেই)`;
      } else {
        let addedMoney = 200;
        let loanDeducted = 0;
        if (player.loan && player.loan.remainingTurns > 0) {
          loanDeducted = player.loan.deductionPerTurn;
          player.loan.remainingAmount -= loanDeducted;
          player.loan.remainingTurns -= 1;
          if (player.loan.remainingTurns <= 0 || player.loan.remainingAmount <= 0) {
            player.loan = undefined;
          }
        }
        player.balance += (addedMoney - loanDeducted);
        newState.governmentBank.balance -= (addedMoney - loanDeducted);
        description += generateLog('goCollected', { oldPos: oldPosition, newPos: newPosition });
        if (loanDeducted > 0) {
          description += ` 🏦 (লোন বাবদ ৳${loanDeducted} কাটা হয়েছে)`;
        }
      }
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
    description += ` ➡️ সোজা জেলে!`;
    newState.turnStatus = 'MUST_ACT_OR_END';
    return { newState, description, nextAction: 'NONE' };
  }

  if (destTile.type === 'TAX') {
    let taxCost = destTile.price || 100;
    
    // Income Tax (Index 4) is 10% of total money
    if (newPosition === 4) {
      taxCost = Math.floor(player.balance * 0.10);
    }
    
    player.balance -= taxCost;
    newState.governmentBank.balance += taxCost;
    if (newState.settings.freeParkingCashPool) {
      newState.freeParkingPool = (newState.freeParkingPool || 0) + taxCost;
    }
    description += generateLog('taxPaid', { tileName: destTile.name, taxAmount: taxCost });
  }

  if (destTile.type === 'FREE_PARKING') {
    player.skipTurns = (player.skipTurns || 0) + 1;
    description += ` ➡️ ফ্রি পার্কিং!`;
    if (newState.settings.freeParkingCashPool && (newState.freeParkingPool || 0) > 0) {
      player.balance += (newState.freeParkingPool || 0);
      description += ` (+৳${newState.freeParkingPool})`;
      newState.freeParkingPool = 0;
    }
  }

  // Draw Card Logic (Chance / Chest)
  if (destTile.type === 'CHANCE' || destTile.type === 'CHEST') {
    if (newState.marketCrash?.active) {
      newState.drawnCard = {
        type: destTile.type,
        text: 'মার্কেট বন্ধ! মার্কেট ক্র্যাশ চলায় এই কার্ডের কোনো মূল্য নেই।',
        action: 'NONE'
      };
      description += ` ➡️ কার্ড তুলেছেন।`;
      nextAction = 'RESOLVE_CARD';
      newState.turnStatus = 'MUST_RESOLVE_CARD';
      return { newState, description, nextAction };
    }

    const deckType = destTile.type === 'CHANCE' ? 'chance' : 'communityChest';
    let card = drawCard(deckType);
    
    // Rare Don Card Logic
    if (!newState.donCardDrawn && Math.random() < 0.05) { // 5% chance
      card = {
        id: 'power_don',
        text: 'BECOME A DON! আপনি একটি স্পেশাল পাওয়ার কার্ড পেয়েছেন। এটি ব্যবহার করে অন্য কারও একটি সম্পত্তি ৩ দানের জন্য দখল করতে পারবেন।',
        action: 'BECOME_A_DON',
        isSecret: true
      };
      newState.donCardDrawn = true;
    }

    if (card) {
      newState.drawnCard = {
        type: destTile.type,
        text: card.text,
        action: card.action,
        value: card.value,
        isSecret: card.isSecret
      };
      
      // Do NOT apply effects or generate log yet. That happens after OK.
      description += ` ➡️ কার্ড তুলেছেন।`;
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
    } else {
      // Determine effective owner (could be hijacked by Don)
      let effectiveOwnerId = propState.ownerId;
      let isHijacked = false;
      const donPower = newState.activeDonPower;
      
      if (donPower && donPower.targetTileIndex === newPosition) {
        const donPlayer = newState.players[donPower.donPlayerId];
        if (donPlayer && !donPlayer.inJail) {
          effectiveOwnerId = donPower.donPlayerId;
          isHijacked = true;
        }
      }

      if (effectiveOwnerId === playerId) {
        description += generateLog('landedOwned', { tileName: destTile.name });
      } else if (propState.isMortgaged) {
        description += generateLog('landedMortgaged', { 
          tileName: destTile.name,
          ownerName: newState.players[propState.ownerId]?.name || 'owner'
        });
      } else {
        // We owe rent to the effective owner
        const ownerPlayer = newState.players[effectiveOwnerId];

        if (newState.settings.jailLoss && ownerPlayer?.inJail) {
          // Owner is in jail and jailLoss rule is active -> No rent
          description += ` ➡️ ${ownerPlayer.name} জেলে থাকায় কোনো রেন্ট দিতে হলো না! (Jail Loss)`;
        } else {
          nextAction = 'PAY_RENT';
          rentDuePlayerId = effectiveOwnerId;
          
          if (isHijacked) {
            description += ` ➡️ (Property Hijacked by Don!)`;
          }
          
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
            if (newState.marketCrash?.active) {
              rentAmount = Math.ceil(rentAmount * 1.40);
            }
            description += generateLog('landedOwnedPropertyRentDue', {
              tileName: destTile.name,
              ownerName: ownerPlayer?.name || 'another player',
              rentAmount
            });
          }
        }
      }
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
