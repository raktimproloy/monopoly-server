import { GameState, TradeOfferPayload } from '../../../shared/types';

/**
 * Validates a trade proposal.
 */
export function canOfferTrade(
  state: GameState,
  offer: TradeOfferPayload
): { valid: boolean; error?: string } {
  const sender = state.players[offer.senderId];
  const receiver = state.players[offer.receiverId];

  if (!sender || sender.isBankrupt) {
    return { valid: false, error: 'Sender player is not active.' };
  }
  if (!receiver || receiver.isBankrupt) {
    return { valid: false, error: 'Receiver player is not active.' };
  }

  // 1. Verify Cash balances
  if (sender.balance < offer.offerCash) {
    return { valid: false, error: `${sender.name} does not have ৳${offer.offerCash} to trade.` };
  }
  if (receiver.balance < offer.requestCash) {
    return { valid: false, error: `${receiver.name} does not have ৳${offer.requestCash} to trade.` };
  }

  // 2. Verify Sender properties
  for (const idx of offer.offerPropertyIndexes) {
    const prop = state.properties[idx];
    if (!prop || prop.ownerId !== offer.senderId) {
      return { valid: false, error: `Sender does not own property at index ${idx}.` };
    }
    if (prop.houses > 0) {
      return { valid: false, error: `Cannot trade property at index ${idx} because it still has houses built on it.` };
    }
  }

  // 3. Verify Receiver properties
  for (const idx of offer.requestPropertyIndexes) {
    const prop = state.properties[idx];
    if (!prop || prop.ownerId !== offer.receiverId) {
      return { valid: false, error: `Receiver does not own property at index ${idx}.` };
    }
    if (prop.houses > 0) {
      return { valid: false, error: `Cannot trade property at index ${idx} because it still has houses built on it.` };
    }
  }

  return { valid: true };
}

/**
 * Executes a trade, moving cash and properties between parties. Assumes validation has run.
 */
export function executeTrade(
  state: GameState,
  offer: TradeOfferPayload
): { newState: GameState; description: string } {
  const newState = JSON.parse(JSON.stringify(state)) as GameState;
  const sender = newState.players[offer.senderId];
  const receiver = newState.players[offer.receiverId];

  // Transfer cash
  sender.balance = sender.balance - offer.offerCash + offer.requestCash;
  receiver.balance = receiver.balance - offer.requestCash + offer.offerCash;

  // Transfer sender properties to receiver
  for (const idx of offer.offerPropertyIndexes) {
    const prop = newState.properties[idx];
    if (prop) {
      prop.ownerId = offer.receiverId;
    }
  }

  // Transfer receiver properties to sender
  for (const idx of offer.requestPropertyIndexes) {
    const prop = newState.properties[idx];
    if (prop) {
      prop.ownerId = offer.senderId;
    }
  }

  // Check if this trade resolved a bankruptcy pending status
  if (newState.turnStatus === 'BANKRUPTCY_PENDING') {
    const activePlayer = newState.players[newState.currentTurnPlayerId];
    if (activePlayer && activePlayer.balance >= 0) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }
  }

  const description = `Trade complete! ${sender.name} and ${receiver.name} swapped assets. ` +
    `Sender gave: ৳${offer.offerCash} & properties [${offer.offerPropertyIndexes.join(', ')}]. ` +
    `Receiver gave: ৳${offer.requestCash} & properties [${offer.requestPropertyIndexes.join(', ')}].`;

  return { newState, description };
}
