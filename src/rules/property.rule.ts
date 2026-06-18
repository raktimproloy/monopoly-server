import { GameState, BoardTile, PropertyState } from '../../../shared/types';
import { generateLog } from '../utils/logGenerator';

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
    return { valid: false, error: 'Bankrupt players cannot buy properties.' };
  }

  // 2. Check if tile is a purchasable property
  const tile = boardTiles[tileIndex];
  if (!tile || !['STREET', 'RAILROAD', 'UTILITY'].includes(tile.type)) {
    return { valid: false, error: 'Tile is not a purchasable property.' };
  }

  // 3. Verify location: Standard Monopoly rules say you must land on it
  if (player.position !== tileIndex) {
    return { valid: false, error: 'Player must stand on the property to buy it.' };
  }

  // 4. Verify ownership
  const currentOwner = state.properties[tileIndex]?.ownerId;
  if (currentOwner) {
    return { valid: false, error: 'Property is already owned.' };
  }

  // 5. Check balance
  let cost = tile.price || 0;
  if (state.marketCrash?.active) {
    cost = Math.floor(cost * 0.7);
  }

  if (player.balance < cost) {
    return { valid: false, error: `Insufficient balance. Property costs ৳${cost}, you have ৳${player.balance}.` };
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
  if (!donPower || donPower.targetTileIndex !== tileIndex) return false;
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
    donPower.targetTileIndex === tileIndex &&
    donPower.originalOwnerId === playerId &&
    isPropertyHijackedByDon(state, tileIndex)
  ) {
    return {
      valid: false,
      error: 'This property is hijacked by the Don. The owner cannot manage it until the Don power expires.',
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
    return { valid: false, error: 'You do not own this property.' };
  }

  if (prop.isMortgaged) {
    return { valid: false, error: 'Property is already mortgaged.' };
  }

  if (prop.houses > 0) {
    return { valid: false, error: 'Must sell all houses before mortgaging property.' };
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
    return { valid: false, error: 'You do not own this property.' };
  }

  if (!prop.isMortgaged) {
    return { valid: false, error: 'Property is not mortgaged.' };
  }

  const tile = boardTiles[tileIndex];
  const mortgageVal = tile.mortgageValue || Math.floor((tile.price || 0) / 2);
  const costToUnmortgage = Math.ceil(mortgageVal * 1.1); // 10% fee
  
  const player = state.players[playerId];
  if (player.balance < costToUnmortgage) {
    return {
      valid: false,
      error: `Insufficient balance. Unmortgage costs ৳${costToUnmortgage} (mortgage value + 10%), you have ৳${player.balance}.`
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
  if (donPower && donPower.targetTileIndex === tileIndex) {
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
 * Executes rent payment transfer from player to owner.
 */
export function payRent(
  state: GameState,
  playerId: string,
  ownerId: string,
  rentAmount: number
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const renter = newState.players[playerId];
  const owner = newState.players[ownerId];

  if (!renter || !owner) {
    throw new Error('Renter or Owner player not found in state.');
  }

  renter.balance -= rentAmount;
  owner.balance += rentAmount;

  let description = generateLog('paidRent', {
    payerName: renter.name,
    rentAmount,
    ownerName: owner.name
  });

  if (renter.balance < 0) {
    newState.turnStatus = 'BANKRUPTCY_PENDING';
    description += ` ${renter.name} is in debt! Must mortgage properties or declare bankruptcy.`;
  } else {
    newState.turnStatus = 'MUST_ACT_OR_END';
  }

  return { newState, description };
}
