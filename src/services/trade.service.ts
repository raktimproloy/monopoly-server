import { RoomService } from './room.service';
import { GameState, TradeOfferPayload, PendingTradeEntry } from '../types';
import { canOfferTrade, executeTrade, applyRentDebtCollection } from '../rules';
import { toBanglaNum } from '../utils/format';

export class TradeService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  private generateTradeId(): string {
    return `trade_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  }

  private ensurePendingTrades(state: GameState): PendingTradeEntry[] {
    if (!state.pendingTrades) state.pendingTrades = [];
    return state.pendingTrades;
  }

  private findTrade(state: GameState, tradeId: string): PendingTradeEntry | undefined {
    return this.ensurePendingTrades(state).find((t) => t.tradeId === tradeId);
  }

  private removeTrade(state: GameState, tradeId: string): boolean {
    const list = this.ensurePendingTrades(state);
    const idx = list.findIndex((t) => t.tradeId === tradeId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  private normalizeOffer(offer: TradeOfferPayload): TradeOfferPayload {
    const normalized = { ...offer };
    if (normalized.durationSeconds && normalized.durationSeconds > 0) {
      normalized.expiresAt = Date.now() + normalized.durationSeconds * 1000;
    } else {
      delete normalized.expiresAt;
    }
    return normalized;
  }

  private validateProposal(state: GameState, offer: TradeOfferPayload): { valid: boolean; error?: string } {
    if (offer.senderId === offer.receiverId) {
      return { valid: false, error: 'নিজের সাথে ট্রেড করা যাবে না।' };
    }

    const sender = state.players[offer.senderId];
    const receiver = state.players[offer.receiverId];
    if (!sender || sender.isBankrupt) {
      return { valid: false, error: 'প্রস্তাবকারী খেলোয়াড় সক্রিয় নেই।' };
    }
    if (!receiver || receiver.isBankrupt) {
      return { valid: false, error: 'প্রাপক খেলোয়াড় সক্রিয় নেই।' };
    }

    if (state.settings?.jailLoss) {
      if (sender.inJail) return { valid: false, error: 'জেলে থাকা অবস্থায় ট্রেড প্রস্তাব করা যাবে না।' };
      if (receiver.inJail) return { valid: false, error: 'জেলে থাকা খেলোয়াড়ের সাথে ট্রেড করা যাবে না।' };
    }

    const hasAssets =
      offer.offerCash > 0 ||
      offer.requestCash > 0 ||
      offer.offerPropertyIndexes.length > 0 ||
      offer.requestPropertyIndexes.length > 0 ||
      (offer.offerPardonCards || 0) > 0 ||
      (offer.requestPardonCards || 0) > 0;

    if (!hasAssets) {
      return { valid: false, error: 'ট্রেডে কমপক্ষে একটি সম্পদ বা নগদ থাকতে হবে।' };
    }

    return canOfferTrade(state, offer);
  }

  async proposeTrade(
    roomId: string,
    offer: TradeOfferPayload,
    replacesTradeId?: string
  ): Promise<{ state: GameState; log: string; tradeId: string; expiresAt?: number }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);
    if (state.gameStatus !== 'ACTIVE') throw new Error('Game is not active.');

    const validation = this.validateProposal(state, offer);
    if (!validation.valid) throw new Error(validation.error || 'Trade proposal is invalid.');

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const normalizedOffer = this.normalizeOffer(offer);
    const now = Date.now();

    if (replacesTradeId) {
      const existing = this.findTrade(newState, replacesTradeId);
      if (!existing) throw new Error('পূর্ববর্তী ট্রেড খুঁজে পাওয়া যায়নি।');
      const isParticipant =
        existing.offer.senderId === offer.senderId || existing.offer.receiverId === offer.senderId;
      if (!isParticipant) throw new Error('এই ট্রেড আপডেট করার অনুমতি নেই।');
      this.removeTrade(newState, replacesTradeId);
    }

    const tradeId = this.generateTradeId();
    this.ensurePendingTrades(newState).push({
      tradeId,
      offer: normalizedOffer,
      createdAt: now,
      updatedAt: now,
    });

    const senderName = newState.players[offer.senderId]?.name || 'Player';
    const receiverName = newState.players[offer.receiverId]?.name || 'Player';
    const log = replacesTradeId
      ? `${senderName} ${receiverName}-এর সাথে ট্রেড আপডেট করেছেন।`
      : `${senderName} ${receiverName}-কে ট্রেড প্রস্তাব পাঠিয়েছেন।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      offer.senderId,
      replacesTradeId ? 'UPDATE_TRADE' : 'PROPOSE_TRADE',
      { tradeId, offer: normalizedOffer, replacesTradeId },
      log
    );

    return { state: savedState, log, tradeId, expiresAt: normalizedOffer.expiresAt };
  }

  async cancelTrade(
    roomId: string,
    tradeId: string,
    playerId: string
  ): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const trade = this.findTrade(state, tradeId);
    if (!trade) throw new Error('Trade offer expired or does not exist.');

    const { offer } = trade;
    if (offer.senderId !== playerId && offer.receiverId !== playerId) {
      throw new Error('Unauthorized. You are not part of this trade.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    this.removeTrade(newState, tradeId);

    const actorName = state.players[playerId]?.name || 'Player';
    const otherName =
      playerId === offer.senderId
        ? state.players[offer.receiverId]?.name || 'Player'
        : state.players[offer.senderId]?.name || 'Player';

    const log =
      playerId === offer.senderId
        ? `${actorName} ${otherName}-কে পাঠানো ট্রেড প্রস্তাব বাতিল করেছেন।`
        : `${actorName} ${otherName}-এর ট্রেড প্রস্তাব প্রত্যাখ্যান করেছেন।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'CANCEL_TRADE',
      { tradeId },
      log
    );

    return { state: savedState, log };
  }

  async acceptTrade(
    roomId: string,
    tradeId: string,
    playerId: string
  ): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const trade = this.findTrade(state, tradeId);
    if (!trade) throw new Error('Trade offer expired or does not exist.');

    const { offer } = trade;
    if (offer.receiverId !== playerId) {
      throw new Error('Unauthorized. You are not the receiver of this trade.');
    }

    const validation = this.validateProposal(state, offer);
    if (!validation.valid) throw new Error(validation.error || 'Trade is no longer valid.');

    const { newState, description } = executeTrade(state, offer);
    this.removeTrade(newState, tradeId);

    let finalState = newState;
    let finalDescription = description;
    for (const pid of [offer.senderId, offer.receiverId]) {
      const collected = applyRentDebtCollection(finalState, pid);
      finalState = collected.newState;
      finalDescription += collected.extraDescription;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'EXECUTE_TRADE',
      { tradeId, offer },
      finalDescription
    );

    return { state: savedState, log: finalDescription };
  }

  async expireTrade(roomId: string, tradeId: string): Promise<{ state: GameState; log: string } | null> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) return null;

    const trade = this.findTrade(state, tradeId);
    if (!trade) return null;

    const { offer } = trade;
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    this.removeTrade(newState, tradeId);

    const senderName = state.players[offer.senderId]?.name || 'Player';
    const receiverName = state.players[offer.receiverId]?.name || 'Player';
    const log = `${senderName} এবং ${receiverName}-এর মধ্যকার ট্রেডের সময়সীমা শেষ হয়ে গেছে।`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      'SYSTEM',
      'EXPIRE_TRADE',
      { tradeId },
      log
    );

    return { state: savedState, log };
  }

  /** @deprecated Use acceptTrade */
  async executeTrade(roomId: string, offer: TradeOfferPayload): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const validation = canOfferTrade(state, offer);
    if (!validation.valid) throw new Error(validation.error || 'Trade proposal is invalid.');

    const { newState, description } = executeTrade(state, offer);

    let finalState = newState;
    let finalDescription = description;
    for (const pid of [offer.senderId, offer.receiverId]) {
      const collected = applyRentDebtCollection(finalState, pid);
      finalState = collected.newState;
      finalDescription += collected.extraDescription;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      offer.senderId,
      'EXECUTE_TRADE',
      offer,
      finalDescription
    );

    return { state: savedState, log: finalDescription };
  }
}
