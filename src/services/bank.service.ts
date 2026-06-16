import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';

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
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);

    if (player.loan && player.loan.remainingTurns > 0) {
      throw new Error(`You already have an active loan. You must repay it before taking another.`);
    }

    const validAmounts = [100, 200, 400, 800];
    if (!validAmounts.includes(amount)) {
      throw new Error(`Invalid loan amount. Must be one of: 100, 200, 400, 800.`);
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

    const description = `🏦 ${pState.name} has taken a loan of ৳${amount} from the Government Bank at ${interestRate}% interest.`;

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
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
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const player = state.players[playerId];
    if (!player) throw new Error(`Player ${playerId} not found.`);

    if (!player.loan || player.loan.remainingTurns <= 0) {
      throw new Error(`You do not have an active loan to repay.`);
    }

    const repayAmount = amount || player.loan.remainingAmount;
    if (player.balance < repayAmount) {
      throw new Error(`Insufficient funds to repay the loan. You need ৳${repayAmount} but have ৳${player.balance}.`);
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
      description = `💸 ${pState.name} has fully repaid their bank loan!`;
    } else {
      description = `💸 ${pState.name} has repaid ৳${repayAmount} towards their bank loan.`;
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
