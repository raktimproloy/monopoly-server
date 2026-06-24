import { RoomService } from './room.service';
import { GameState } from '../types';
import { applyRentDebtCollection } from '../rules';
import { toBanglaNum } from '../utils/format';

export class BankService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Player takes a loan from the Government Bank.
   */
  async takeLoan(roomId: string, playerId: string, amount: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);

    if (player.loan && player.loan.remainingTurns > 0) {
      throw new Error(`আপনার ইতিমধ্যে একটি সক্রিয় লোন রয়েছে। নতুন লোন নেওয়ার আগে সেটি পরিশোধ করতে হবে।`);
    }

    const validAmounts = [100, 200, 400, 800];
    if (!validAmounts.includes(amount)) {
      throw new Error(`লোনের পরিমাণ সঠিক নয়। শুধুমাত্র ১০০, ২০০, ৪০০ বা ৮০০ নেওয়া যাবে।`);
    }

    let interestRate = 0;
    if (amount === 100) interestRate = 10;
    else if (amount === 200) interestRate = 15;
    else if (amount === 400) interestRate = 20;
    else if (amount === 800) interestRate = 25;

    const totalRepayment = amount + Math.floor((amount * interestRate) / 100);
    const remainingTurns = 5;
    const deductionPerTurn = Math.ceil(totalRepayment / remainingTurns);

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    // Player gets the money
    pState.balance += amount;
    // Bank loses the money
    newState.governmentBank.balance -= amount;

    // Set loan details
    pState.loan = {
      principal: amount,
      interestRate,
      totalRepayment,
      remainingAmount: totalRepayment,
      remainingTurns,
      deductionPerTurn
    };

    let description = `🏦 ${pState.name} সরকারি ব্যাংক থেকে ${toBanglaNum(interestRate)}% সুদে ৳${toBanglaNum(amount)} লোন নিয়েছেন।`;

    const debtResult = applyRentDebtCollection(newState, playerId);
    let finalState = debtResult.newState;
    if (debtResult.extraDescription) {
      description += debtResult.extraDescription;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      finalState,
      playerId,
      'TAKE_LOAN',
      { amount },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Player repays their active loan directly.
   */
  async repayLoan(roomId: string, playerId: string, amount?: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`গেম রুম ${roomId} পাওয়া যায়নি।`);

    const player = state.players[playerId];
    if (!player) throw new Error(`প্লেয়ার ${playerId} পাওয়া যায়নি।`);

    if (!player.loan || player.loan.remainingTurns <= 0) {
      throw new Error(`আপনার পরিশোধ করার মতো কোনো সক্রিয় লোন নেই।`);
    }

    const repayAmount = amount || player.loan.remainingAmount;
    if (player.balance < repayAmount) {
      throw new Error(`লোন পরিশোধ করার জন্য পর্যাপ্ত ব্যালেন্স নেই। আপনার ৳${toBanglaNum(repayAmount)} প্রয়োজন, কিন্তু আছে ৳${toBanglaNum(player.balance)}।`);
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const pState = newState.players[playerId];

    // Player pays the money
    pState.balance -= repayAmount;
    // Bank gets the money
    newState.governmentBank.balance += repayAmount;

    pState.loan!.remainingAmount -= repayAmount;
    
    let description = '';
    if (pState.loan!.remainingAmount <= 0) {
      pState.loan = undefined; // Cleared
      description = `💸 ${pState.name} তার ব্যাংক লোন সম্পূর্ণ পরিশোধ করেছেন!`;
    } else {
      const remainingTurns = pState.loan!.remainingTurns;
      if (remainingTurns > 0) {
        pState.loan!.deductionPerTurn = Math.ceil(pState.loan!.remainingAmount / remainingTurns);
      }
      description = `💸 ${pState.name} তার ব্যাংক লোনের জন্য ৳${toBanglaNum(repayAmount)} পরিশোধ করেছেন। (বাকি ঋণ: ৳${toBanglaNum(pState.loan!.remainingAmount)}, কিস্তি: ৳${toBanglaNum(pState.loan!.deductionPerTurn)}/দান)`;
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'REPAY_LOAN',
      { repayAmount },
      description
    );

    return { state: savedState, log: description };
  }
}
