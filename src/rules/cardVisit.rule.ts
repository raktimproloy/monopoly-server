import { GameState, BoardTile } from '../types';
import { generateLog } from '../utils/logGenerator';
import { toBanglaNum } from '../utils/format';
import { calculateRentAtTile } from './property.rule';

export const GO_PASS_BONUS_AMOUNT = 200;

export type PropertyLandingAction = 'BUY_PROPERTY' | 'PAY_RENT' | 'NONE';

export interface PropertyLandingResult {
  newState: GameState;
  description: string;
  nextAction: PropertyLandingAction;
  rentDuePlayerId?: string;
  rentAmount?: number;
}

const PURCHASABLE_TYPES = new Set(['STREET', 'RAILROAD', 'UTILITY']);

/** e.g. ধানমন্ডি → ধানমন্ডিতে যান, গুলশান → গুলশানে যান */
export function formatTileVisitInstruction(tileName: string): string {
  const base = tileName.split('(')[0].split('\n')[0].trim();
  if (!base) return 'যান';

  if (base.endsWith('ি') && !base.endsWith('ী')) {
    return `${base}তে যান`;
  }
  if (base.endsWith('ী')) {
    return `${base}তে যান`;
  }
  return `${base}ে যান`;
}

export function getPurchasableTiles(boardTiles: BoardTile[]): BoardTile[] {
  return boardTiles.filter((t) => PURCHASABLE_TYPES.has(t.type));
}

/** Picks a random street / railroad / utility, optionally excluding one tile index. */
export function pickRandomPurchasableTile(
  boardTiles: BoardTile[],
  excludeIndex?: number
): BoardTile | null {
  const pool = getPurchasableTiles(boardTiles).filter((t) => t.index !== excludeIndex);
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Short card face — destination only; rent/buy show in separate history lines. */
export function buildRandomPropertyVisitCardText(
  _state: GameState,
  _playerId: string,
  tile: BoardTile,
  _boardTiles: BoardTile[]
): string {
  return formatTileVisitInstruction(tile.name);
}

function applyLoanDeductionOnGoBonus(player: GameState['players'][string], bonus: number): number {
  if (!player.loan || player.loan.remainingTurns <= 0) return 0;

  let loanDeducted = 0;
  if (player.loan.remainingTurns === 1) {
    loanDeducted = player.loan.remainingAmount;
  } else {
    loanDeducted = Math.min(player.loan.deductionPerTurn, player.loan.remainingAmount);
  }

  player.loan.remainingAmount -= loanDeducted;
  player.loan.remainingTurns -= 1;

  if (player.loan.remainingTurns > 0 && player.loan.remainingAmount > 0) {
    player.loan.deductionPerTurn = Math.ceil(player.loan.remainingAmount / player.loan.remainingTurns);
  }

  if (player.loan.remainingTurns <= 0 || player.loan.remainingAmount <= 0) {
    player.loan = undefined;
  }

  return Math.min(loanDeducted, bonus);
}

/** Awards GO pass bonus when teleport wraps backward on the board (passed GO). */
export function applyGoPassBonusIfNeeded(
  state: GameState,
  playerId: string,
  oldPosition: number,
  newPosition: number
): string {
  if (newPosition >= oldPosition) return '';

  const player = state.players[playerId];
  if (!player) return '';

  let loanDeducted = applyLoanDeductionOnGoBonus(player, GO_PASS_BONUS_AMOUNT);
  const netBonus = GO_PASS_BONUS_AMOUNT - loanDeducted;

  player.balance += netBonus;
  state.governmentBank.balance -= netBonus;

  let description = generateLog('goCollected', { oldPos: oldPosition, newPos: newPosition });
  if (loanDeducted > 0) {
    description += ` 🏦 (লোন বাবদ ৳${toBanglaNum(loanDeducted)} কাটা হয়েছে)`;
  }

  return description;
}

/** Standard property landing rules (buy / own / rent) for a tile the player stops on. */
export function evaluatePropertyLanding(
  state: GameState,
  playerId: string,
  tileIndex: number,
  boardTiles: BoardTile[]
): PropertyLandingResult {
  const destTile = boardTiles[tileIndex];
  let description = '';
  let nextAction: PropertyLandingAction = 'NONE';
  let rentDuePlayerId: string | undefined;
  let rentAmount: number | undefined;

  if (!destTile || !PURCHASABLE_TYPES.has(destTile.type)) {
    return { newState: state, description, nextAction };
  }

  const propState = state.properties[tileIndex];

  if (!propState?.ownerId) {
    nextAction = 'BUY_PROPERTY';
    description += generateLog('landedUnownedProperty', {
      tileName: destTile.name,
      price: destTile.price,
    });
    return { newState: state, description, nextAction };
  }

  const donPower = state.activeDonPower;
  let effectiveOwnerId = propState.ownerId;
  let isHijacked = false;

  if (donPower && donPower.targetTileIndexes.includes(tileIndex)) {
    const donPlayer = state.players[donPower.donPlayerId];
    if (donPlayer && !donPlayer.inJail) {
      effectiveOwnerId = donPower.donPlayerId;
      isHijacked = true;
    }
  }

  if (effectiveOwnerId === playerId) {
    description += generateLog('landedOwned', { tileName: destTile.name });
    return { newState: state, description, nextAction };
  }

  if (propState.isMortgaged) {
    description += generateLog('landedMortgaged', {
      tileName: destTile.name,
      ownerName: state.players[propState.ownerId]?.name || 'owner',
    });
    return { newState: state, description, nextAction };
  }

  const ownerPlayer = state.players[effectiveOwnerId];
  if (state.settings.jailLoss && ownerPlayer?.inJail) {
    description += ` ➡️ ${ownerPlayer.name} জেলে থাকায় কোনো রেন্ট দিতে হলো না! (Jail Loss)`;
    return { newState: state, description, nextAction };
  }

  const rentInfo = calculateRentAtTile(state, tileIndex, boardTiles);
  if (rentInfo && rentInfo.ownerId !== playerId && rentInfo.rentAmount > 0) {
    nextAction = 'PAY_RENT';
    rentDuePlayerId = rentInfo.ownerId;
    rentAmount = rentInfo.rentAmount;

    if (isHijacked) {
      description += ` ➡️ (Property Hijacked by Don!)`;
    }

    description += generateLog('landedOwnedPropertyRentDue', {
      tileName: destTile.name,
      ownerName: ownerPlayer?.name || 'another player',
      rentAmount,
    });
  }

  return { newState: state, description, nextAction, rentDuePlayerId, rentAmount };
}

/**
 * Teleports the player to a property tile after resolving a chance card.
 * Applies GO pass bonus, then full landing rules (rent / buy / own).
 */
export function executeRandomPropertyVisit(
  state: GameState,
  playerId: string,
  targetIndex: number,
  boardTiles: BoardTile[]
): PropertyLandingResult {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const player = newState.players[playerId];
  const destTile = boardTiles[targetIndex];

  if (!player || !destTile) {
    return { newState, description: '', nextAction: 'NONE' };
  }

  const oldPosition = player.position;
  newState.doubleRollCount = 0;

  let description = applyGoPassBonusIfNeeded(newState, playerId, oldPosition, targetIndex);
  player.position = targetIndex;
  description += generateLog('movedTo', { tileName: destTile.name });

  const landing = evaluatePropertyLanding(newState, playerId, targetIndex, boardTiles);
  landing.description = description + landing.description;

  return landing;
}
