import { GameState, BoardTile, PropertyState } from '../../../shared/types';

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
  const cost = tile.price || 0;
  if (player.balance < cost) {
    return { valid: false, error: `Insufficient balance. Property costs $${cost}, you have $${player.balance}.` };
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
  const cost = tile.price || 0;

  // Deduct balance
  player.balance -= cost;

  // Set ownership
  newState.properties[tileIndex] = {
    tileIndex,
    ownerId: playerId,
    isMortgaged: false,
    houses: 0
  };

  const description = `${player.name} bought "${tile.name}" for $${cost}. Remaining balance: $${player.balance}.`;
  return { newState, description };
}

/**
 * Validates if a player can mortgage a property.
 */
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

  const description = `${player.name} mortgaged "${tile.name}" and received $${mortgageVal}. Current balance: $${player.balance}.`;
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
      error: `Insufficient balance. Unmortgage costs $${costToUnmortgage} (mortgage value + 10%), you have $${player.balance}.`
    };
  }

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

  const description = `${player.name} unmortgaged "${tile.name}" for $${costToUnmortgage}. Remaining balance: $${player.balance}.`;
  return { newState, description };
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

  let description = `${renter.name} paid rent of $${rentAmount} to ${owner.name}.`;

  if (renter.balance < 0) {
    newState.turnStatus = 'BANKRUPTCY_PENDING';
    description += ` ${renter.name} is in debt! Must mortgage properties or declare bankruptcy.`;
  } else {
    newState.turnStatus = 'MUST_ACT_OR_END';
  }

  return { newState, description };
}
