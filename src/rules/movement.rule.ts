import { GameState, Player, BoardTile } from '../../../shared/types';

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
  let description = `${player.name} rolled [${d1}, ${d2}]`;

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
        description += ` failed to roll doubles for 3 turns. Paid $50 to get out of Jail.`;
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
    description += ` and moved from tile ${oldPosition} to ${newPosition}, passing GO and collecting $200.`;
  } else {
    description += ` and moved from tile ${oldPosition} to ${newPosition}.`;
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
    description += ` Landed on tax tile "${destTile.name}". Paid $${taxCost} to the bank.`;
  }

  // Check if tile is a purchasable property (STREET, RAILROAD, UTILITY)
  const isPurchasable = ['STREET', 'RAILROAD', 'UTILITY'].includes(destTile.type);
  if (isPurchasable) {
    const propState = newState.properties[newPosition];
    
    if (!propState || !propState.ownerId) {
      // Unowned
      nextAction = 'BUY_PROPERTY';
      description += ` Landed on unowned property "${destTile.name}". Can buy for $${destTile.price}.`;
    } else if (propState.ownerId !== playerId && !propState.isMortgaged) {
      // Owned by someone else, and not mortgaged -> Rent is due
      nextAction = 'PAY_RENT';
      rentDuePlayerId = propState.ownerId;
      
      // Calculate Rent
      if (destTile.type === 'STREET') {
        const houses = propState.houses;
        rentAmount = destTile.rent ? destTile.rent[houses] : 0;
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
        description += ` Landed on "${destTile.name}" owned by ${newState.players[propState.ownerId]?.name || 'another player'}. Rent of $${rentAmount} is due.`;
      }
    } else if (propState.ownerId === playerId) {
      description += ` Landed on their own property "${destTile.name}".`;
    } else if (propState.isMortgaged) {
      description += ` Landed on "${destTile.name}" which is currently mortgaged by ${newState.players[propState.ownerId]?.name || 'owner'}. No rent due.`;
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
