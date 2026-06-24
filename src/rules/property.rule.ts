import { GameState, BoardTile, PropertyState } from '../types';
import { generateLog } from '../utils/logGenerator';
import { toBanglaNum } from '../utils/format';

/**
 * Validates if a player can buy a specific property.
 */
export function canBuyProperty(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): { valid: boolean; error?: string } {
  const player = state.players[playerId];
  if (!player) {
    return { valid: false, error: 'Player not found.' };
  }

  // 1. Check if player is bankrupt or in jail
  if (player.isBankrupt) {
    return { valid: false, error: 'দেউলিয়া প্লেয়ার সম্পত্তি কিনতে পারবে না।' };
  }

  // 2. Check if tile is a purchasable property
  const tile = boardTiles[tileIndex];
  if (!tile || !['STREET', 'RAILROAD', 'UTILITY'].includes(tile.type)) {
    return { valid: false, error: 'এই ঘরটি কেনার যোগ্য নয়।' };
  }

  // 3. Verify location: Standard Monopoly rules say you must land on it
  if (player.position !== tileIndex) {
    return { valid: false, error: 'সম্পত্তিটি কিনতে হলে তার উপর থাকতে হবে।' };
  }

  // 4. Verify ownership
  const currentOwner = state.properties[tileIndex]?.ownerId;
  if (currentOwner) {
    return { valid: false, error: 'সম্পত্তিটি ইতোমধ্যে কেনা হয়েছে।' };
  }

  // 5. Check balance
  let cost = tile.price || 0;
  if (state.marketCrash?.active) {
    cost = Math.floor(cost * 0.7);
  }

  if (player.balance < cost) {
    return { valid: false, error: `পর্যাপ্ত ব্যালেন্স নেই। সম্পত্তির দাম ৳${toBanglaNum(cost)}, কিন্তু আপনার আছে ৳${toBanglaNum(player.balance)}।` };
  }

  return { valid: true };
}

/**
 * Performs state mutation for buying a property. Assumes validation has run.
 */
export function buyProperty(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players[playerId];
  const tile = boardTiles[tileIndex];
  let cost = tile.price || 0;

  if (newState.marketCrash?.active) {
    cost = Math.floor(cost * 0.7);
  }

  // Deduct balance
  player.balance -= cost;
  newState.governmentBank.balance += cost;

  // Set ownership
  newState.properties[tileIndex] = {
    tileIndex,
    ownerId: playerId,
    isMortgaged: false,
    houses: 0
  };

  const description = generateLog('boughtProperty', {
    playerName: player.name,
    tileName: tile.name,
    cost,
    balance: player.balance
  });
  return { newState, description };
}

/**
 * Validates if a player can mortgage a property.
 */
export function isPropertyHijackedByDon(state: GameState, tileIndex: number): boolean {
  const donPower = state.activeDonPower;
  if (!donPower || !donPower.targetTileIndexes.includes(tileIndex)) return false;
  const donPlayer = state.players[donPower.donPlayerId];
  return !!(donPlayer && !donPlayer.inJail);
}

export function canOwnerManageHijackedProperty(
  state: GameState,
  playerId: string,
  tileIndex: number
): { valid: boolean; error?: string } {
  const donPower = state.activeDonPower;
  if (
    donPower &&
    donPower.targetTileIndexes.includes(tileIndex) &&
    donPower.originalOwnerId === playerId &&
    isPropertyHijackedByDon(state, tileIndex)
  ) {
    return {
      valid: false,
      error: 'এই সম্পত্তিটি বর্তমানে ডন এর দখলে আছে। ডন পাওয়ার শেষ না হওয়া পর্যন্ত মালিক এটি নিয়ন্ত্রণ করতে পারবেন না।',
    };
  }
  return { valid: true };
}

export function canMortgageProperty(
  state: GameState,
  playerId: string,
  tileIndex: number
): { valid: boolean; error?: string } {
  const prop = state.properties[tileIndex];
  if (!prop || prop.ownerId !== playerId) {
    return { valid: false, error: 'আপনি এই সম্পত্তির মালিক নন।' };
  }

  if (prop.isMortgaged) {
    return { valid: false, error: 'সম্পত্তিটি ইতোমধ্যে বন্ধক রাখা হয়েছে।' };
  }

  if (prop.houses > 0) {
    return { valid: false, error: 'বন্ধক রাখার আগে সমস্ত বাড়ি বিক্রি করতে হবে।' };
  }

  const hijackCheck = canOwnerManageHijackedProperty(state, playerId, tileIndex);
  if (!hijackCheck.valid) return hijackCheck;

  return { valid: true };
}

/**
 * Performs state mutation to mortgage a property.
 */
export function mortgageProperty(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players[playerId];
  const prop = newState.properties[tileIndex];
  const tile = boardTiles[tileIndex];

  const mortgageVal = tile.mortgageValue || Math.floor((tile.price || 0) / 2);
  prop.isMortgaged = true;
  player.balance += mortgageVal;
  newState.governmentBank.balance -= mortgageVal;

  const description = generateLog('mortgagedProperty', {
    playerName: player.name,
    tileName: tile.name,
    mortgageVal,
    balance: player.balance
  });
  return { newState, description };
}

/**
 * Validates if a player can unmortgage a property.
 */
export function canUnmortgageProperty(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): { valid: boolean; error?: string } {
  const prop = state.properties[tileIndex];
  if (!prop || prop.ownerId !== playerId) {
    return { valid: false, error: 'আপনি এই সম্পত্তির মালিক নন।' };
  }

  if (!prop.isMortgaged) {
    return { valid: false, error: 'সম্পত্তিটি বন্ধক রাখা নেই।' };
  }

  const tile = boardTiles[tileIndex];
  const mortgageVal = tile.mortgageValue || Math.floor((tile.price || 0) / 2);
  const costToUnmortgage = Math.ceil(mortgageVal * 1.1); // 10% fee
  
  const player = state.players[playerId];
  if (player.balance < costToUnmortgage) {
    return {
      valid: false,
      error: `পর্যাপ্ত ব্যালেন্স নেই। বন্ধক ছাড়াতে খরচ হবে ৳${toBanglaNum(costToUnmortgage)} (বন্ধক মূল্য + ১০%), কিন্তু আপনার আছে ৳${toBanglaNum(player.balance)}।`
    };
  }

  const hijackCheck = canOwnerManageHijackedProperty(state, playerId, tileIndex);
  if (!hijackCheck.valid) return hijackCheck;

  return { valid: true };
}

/**
 * Performs state mutation to unmortgage a property.
 */
export function unmortgageProperty(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players[playerId];
  const prop = newState.properties[tileIndex];
  const tile = boardTiles[tileIndex];

  const mortgageVal = tile.mortgageValue || Math.floor((tile.price || 0) / 2);
  const costToUnmortgage = Math.ceil(mortgageVal * 1.1);

  prop.isMortgaged = false;
  player.balance -= costToUnmortgage;
  newState.governmentBank.balance += costToUnmortgage;

  const description = generateLog('unmortgagedProperty', {
    playerName: player.name,
    tileName: tile.name,
    cost: costToUnmortgage,
    balance: player.balance
  });
  return { newState, description };
}

/**
 * Calculates rent owed at a given tile position (for bankruptcy clawback).
 */
export function calculateRentAtTile(
  state: GameState,
  tileIndex: number,
  boardTiles: BoardTile[]
): { ownerId: string; rentAmount: number } | null {
  const propState = state.properties[tileIndex];
  const destTile = boardTiles[tileIndex];
  if (!propState?.ownerId || !destTile) return null;
  if (propState.isMortgaged) return null;

  let effectiveOwnerId = propState.ownerId;

  const donPower = state.activeDonPower;
  if (donPower && donPower.targetTileIndexes.includes(tileIndex)) {
    const donPlayer = state.players[donPower.donPlayerId];
    if (donPlayer && !donPlayer.inJail) {
      effectiveOwnerId = donPower.donPlayerId;
    }
  }

  const ownerPlayer = state.players[effectiveOwnerId];
  if (state.settings.jailLoss && ownerPlayer?.inJail) return null;

  let rentAmount = 0;

  if (destTile.type === 'STREET') {
    const houses = propState.houses;
    rentAmount = destTile.rent ? destTile.rent[houses] : 0;

    if (houses === 0 && state.settings.doubleRentOnCompleteSet) {
      const groupTiles = boardTiles.filter((t) => t.group === destTile.group);
      const ownsFullSet = groupTiles.every((t) => {
        const p = state.properties[t.index];
        return p && p.ownerId === propState.ownerId;
      });
      if (ownsFullSet) {
        rentAmount *= 2;
      }
    }
  } else if (destTile.type === 'RAILROAD') {
    const ownerRailroads = Object.values(state.properties).filter(
      (p) => p.ownerId === propState.ownerId && boardTiles[p.tileIndex].type === 'RAILROAD'
    ).length;
    rentAmount = (destTile.rent ? destTile.rent[ownerRailroads - 1] : 25) || 25;
  } else if (destTile.type === 'UTILITY') {
    const ownerUtilities = Object.values(state.properties).filter(
      (p) => p.ownerId === propState.ownerId && boardTiles[p.tileIndex].type === 'UTILITY'
    ).length;
    const multiplier = ownerUtilities === 2 ? 10 : 4;
    const [d1, d2] = state.dice;
    rentAmount = (d1 + d2) * multiplier;
  }

  if (!rentAmount || rentAmount <= 0) return null;

  if (state.marketCrash?.active) {
    rentAmount = Math.ceil(rentAmount * 1.4);
  }

  return { ownerId: effectiveOwnerId, rentAmount };
}

/**
 * When a debtor receives cash (mortgage, sell, etc.), route it to the rent creditor.
 */
export function applyRentDebtCollection(
  state: GameState,
  debtorId: string
): { newState: GameState; extraDescription: string } {
  const debt = state.pendingRentOwed;
  if (!debt || debt.debtorId !== debtorId || debt.remainingAmount <= 0) {
    return { newState: state, extraDescription: '' };
  }

  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const activeDebt = newState.pendingRentOwed!;
  const debtor = newState.players[debtorId];
  const creditor = newState.players[activeDebt.creditorId];

  if (!debtor || !creditor || creditor.isBankrupt) {
    return { newState: state, extraDescription: '' };
  }

  const available = Math.max(0, debtor.balance);
  if (available === 0) {
    return { newState: state, extraDescription: '' };
  }

  const pay = Math.min(available, activeDebt.remainingAmount);
  debtor.balance -= pay;
  creditor.balance += pay;
  activeDebt.remainingAmount -= pay;

  let extraDescription = ` ${debtor.name} ${creditor.name}-কে আরও ৳${toBanglaNum(pay)} ভাড়া দিয়েছেন।`;

  if (activeDebt.remainingAmount <= 0) {
    newState.pendingRentOwed = null;
    if (newState.turnStatus === 'BANKRUPTCY_PENDING') {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }
  }

  return { newState, extraDescription };
}

/**
 * Executes rent payment transfer from player to owner (pocket cash only on landing).
 */
export function payRent(
  state: GameState,
  playerId: string,
  ownerId: string,
  rentAmount: number,
  tileIndex?: number
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const renter = newState.players[playerId];
  const owner = newState.players[ownerId];

  if (!renter || !owner) {
    throw new Error('Renter or Owner player not found in state.');
  }

  const pocketCash = Math.max(0, renter.balance);
  const actualPaid = Math.min(rentAmount, pocketCash);
  const remaining = rentAmount - actualPaid;

  renter.balance -= actualPaid;
  owner.balance += actualPaid;

  let description = generateLog('paidRent', {
    payerName: renter.name,
    rentAmount: actualPaid,
    ownerName: owner.name
  });

  if (remaining > 0 && tileIndex !== undefined) {
    newState.pendingRentOwed = {
      debtorId: playerId,
      creditorId: ownerId,
      remainingAmount: remaining,
      tileIndex,
      fullRentAmount: rentAmount,
    };
    newState.turnStatus = 'BANKRUPTCY_PENDING';
    description += ` (মোট ভাড়া ৳${toBanglaNum(rentAmount)}, পকেটে ছিল ৳${toBanglaNum(actualPaid)}। বাকি ৳${toBanglaNum(remaining)} — বিক্রি/বন্ধক করলে ${owner.name} পাবেন।)`;
  } else {
    newState.pendingRentOwed = null;
    newState.turnStatus = 'MUST_ACT_OR_END';
  }

  return { newState, description };
}
