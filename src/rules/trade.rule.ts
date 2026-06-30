import { GameState, TradeOfferPayload } from '../types';
import { generateLog } from '../utils/logGenerator';
import { canOwnerManageHijackedProperty } from './property.rule';
import { toBanglaNum } from '../utils/format';

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
    return { valid: false, error: 'প্রস্তাবকারী খেলোয়াড় সক্রিয় নেই।' };
  }
  if (!receiver || receiver.isBankrupt) {
    return { valid: false, error: 'যার কাছে প্রস্তাব পাঠাচ্ছেন সে সক্রিয় নেই।' };
  }

  // 1. Verify Cash balances
  if (sender.balance < offer.offerCash) {
    return { valid: false, error: `${sender.name}-এর কাছে ৳${toBanglaNum(offer.offerCash)} নেই।` };
  }
  if (receiver.balance < offer.requestCash) {
    return { valid: false, error: `${receiver.name}-এর কাছে ৳${toBanglaNum(offer.requestCash)} নেই।` };
  }

  const offerPardon = offer.offerPardonCards || 0;
  const requestPardon = offer.requestPardonCards || 0;
  if (offerPardon > (sender.getOutOfJailFreeCards || 0)) {
    return { valid: false, error: `${sender.name}-এর কাছে পর্যাপ্ত পার্ডন কার্ড নেই।` };
  }
  if (requestPardon > (receiver.getOutOfJailFreeCards || 0)) {
    return { valid: false, error: `${receiver.name}-এর কাছে পর্যাপ্ত পার্ডন কার্ড নেই।` };
  }

  // 2. Verify Sender properties
  for (const idx of offer.offerPropertyIndexes) {
    const prop = state.properties[idx];
    if (!prop || prop.ownerId !== offer.senderId) {
      return { valid: false, error: `প্রস্তাবকারী এই সম্পত্তির মালিক নন।` };
    }
    if (prop.houses > 0) {
      return { valid: false, error: `বাড়ি নির্মাণ করা অবস্থায় সম্পত্তি ট্রেড করা যাবে না।` };
    }
    const hijackCheck = canOwnerManageHijackedProperty(state, offer.senderId, idx);
    if (!hijackCheck.valid) return hijackCheck;
  }

  // 3. Verify Receiver properties
  for (const idx of offer.requestPropertyIndexes) {
    const prop = state.properties[idx];
    if (!prop || prop.ownerId !== offer.receiverId) {
      return { valid: false, error: `যার কাছে প্রস্তাব পাঠাচ্ছেন সে এই সম্পত্তির মালিক নন।` };
    }
    if (prop.houses > 0) {
      return { valid: false, error: `বাড়ি নির্মাণ করা অবস্থায় সম্পত্তি ট্রেড করা যাবে না।` };
    }
    const hijackCheck = canOwnerManageHijackedProperty(state, offer.receiverId, idx);
    if (!hijackCheck.valid) return hijackCheck;
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

  const offerPardon = offer.offerPardonCards || 0;
  const requestPardon = offer.requestPardonCards || 0;
  if (offerPardon > 0) {
    sender.getOutOfJailFreeCards = (sender.getOutOfJailFreeCards || 0) - offerPardon;
    receiver.getOutOfJailFreeCards = (receiver.getOutOfJailFreeCards || 0) + offerPardon;
  }
  if (requestPardon > 0) {
    receiver.getOutOfJailFreeCards = (receiver.getOutOfJailFreeCards || 0) - requestPardon;
    sender.getOutOfJailFreeCards = (sender.getOutOfJailFreeCards || 0) + requestPardon;
  }

  // Check if this trade resolved a bankruptcy pending status
  if (newState.turnStatus === 'BANKRUPTCY_PENDING') {
    const activePlayer = newState.players[newState.currentTurnPlayerId];
    if (activePlayer && activePlayer.balance >= 0) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }
  }

  const description = generateLog('tradeComplete', {
    senderName: sender.name,
    receiverName: receiver.name
  });

  let cashNote = '';
  if (offer.offerCash > 0 && offer.requestCash > 0) {
    cashNote = ` (${sender.name} ${receiver.name}-কে ৳${toBanglaNum(offer.offerCash)} দিয়েছেন, ${receiver.name} ${sender.name}-কে ৳${toBanglaNum(offer.requestCash)} দিয়েছেন)`;
  } else if (offer.offerCash > 0) {
    cashNote = ` (${sender.name} ${receiver.name}-কে ৳${toBanglaNum(offer.offerCash)} দিয়েছেন)`;
  } else if (offer.requestCash > 0) {
    cashNote = ` (${receiver.name} ${sender.name}-কে ৳${toBanglaNum(offer.requestCash)} দিয়েছেন)`;
  }

  return { newState, description: description + cashNote };
}
