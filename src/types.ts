export type GameStatus = 'LOBBY' | 'ACTIVE' | 'FINISHED';

export interface Player {
  id: string;
  name: string;
  position: number; // 0 to 39
  balance: number;
  isBankrupt: boolean;
  inJail: boolean;
  jailTurns: number;
  getOutOfJailFreeCards?: number;
  skipTurns?: number;
  powerCards?: string[]; // Array to hold power cards like 'BECOME_A_DON'
  avatar: string; // Color identifier or token icon
  loan?: {
    principal: number;
    interestRate: number;
    totalRepayment: number;
    remainingAmount: number;
    remainingTurns: number;
    deductionPerTurn: number;
  };
}

export interface ActiveDonPower {
  donPlayerId: string;
  targetTileIndexes: number[];
  originalOwnerId: string;
  remainingRounds: number; // Decremented each time all players complete a turn
}

export interface PropertyState {
  tileIndex: number;
  ownerId: string | null;
  isMortgaged: boolean;
  houses: number; // 0-4 houses, 5 = hotel
}

export interface GameSettings {
  startingCash: number;
  doubleRentOnCompleteSet: boolean;
  freeParkingCashPool: boolean;
  allowUnpurchasedAuction: boolean;
  allowMortgage: boolean;
  jailLoss?: boolean;
  enableTrafficPolice?: boolean;
}

export interface AuctionState {
  propertyIndex: number;
  currentBid: number;
  highestBidderId: string | null;
  endTime: number;
  sellerId: string | null;
  initiatorId: string;
  bids: { playerId: string; amount: number; timestamp: number }[];
}

export interface MarketCrashState {
  active: boolean;
  nextCrashTime: number | null; // Timestamp for when the next crash starts (null if max crashes reached)
  crashEndTime: number | null; // Timestamp for when the current crash ends (null if not active)
  crashCount: number; // 0 to 3
}

export interface TrafficPoliceState {
  active: boolean;
  position: number | null;
  nextAppearanceTime: number | null;
  disappearanceTime: number | null;
}

export interface PendingRentOwed {
  debtorId: string;
  creditorId: string;
  remainingAmount: number;
  tileIndex: number;
  fullRentAmount: number;
}

export interface GameState {
  roomId: string;
  players: Record<string, Player>;
  playerOrder: string[];
  currentTurnPlayerId: string;
  properties: Record<number, PropertyState>;
  dice: [number, number];
  doubleRollCount: number;
  gameStatus: GameStatus;
  winnerId: string | null;
  turnStatus: 'MUST_ROLL' | 'MUST_ACT_OR_END' | 'BANKRUPTCY_PENDING' | 'MUST_RESOLVE_CARD' | 'MUST_RESOLVE_LOTTERY';
  settings: GameSettings;
  freeParkingPool?: number;
  activeAuction?: AuctionState;
  drawnCard: {
    type: 'CHANCE' | 'CHEST';
    text: string;
    action: string;
    value?: number;
    isSecret?: boolean;
  } | null;
  marketCrash: MarketCrashState;
  donCardDrawn?: boolean;
  activeDonPower?: ActiveDonPower | null;
  governmentBank: {
    balance: number;
  };
  trafficPolice?: TrafficPoliceState;
  kickVotes?: Record<string, string>; // voterId -> targetPlayerId to kick
  /** Remaining rent owed after pocket-only payment on landing */
  pendingRentOwed?: PendingRentOwed | null;
  /** Active lottery state when a player lands on the LOTTERY tile */
  activeLottery?: LotteryState | null;
}

export type TileType =
  | 'START'
  | 'STREET'
  | 'RAILROAD'
  | 'UTILITY'
  | 'TAX'
  | 'CHANCE'
  | 'CHEST'
  | 'JAIL'
  | 'GO_TO_JAIL'
  | 'FREE_PARKING'
  | 'LOTTERY';

export interface BoardTile {
  index: number;
  name: string;
  type: TileType;
  price?: number;
  rent?: number[]; // [base, 1 house, 2 houses, 3 houses, 4 houses, hotel]
  mortgageValue?: number;
  houseCost?: number;
  group?: string; // e.g., 'Brown', 'Light Blue', 'Pink', etc.
}

export interface BoardData {
  tiles: BoardTile[];
}

export interface GameActionLog {
  id: string;
  timestamp: number;
  playerId: string;
  actionType: string;
  description: string;
  payload: any;
}

// Socket payload schemas for incoming requests
export interface RollDicePayload {
  playerId: string;
}

export interface BuyPropertyPayload {
  playerId: string;
  tileIndex: number;
}

export interface TradeOfferPayload {
  senderId: string;
  receiverId: string;
  offerCash: number;
  requestCash: number;
  offerPropertyIndexes: number[];
  requestPropertyIndexes: number[];
  offerPardonCards?: number;
  requestPardonCards?: number;
  durationSeconds?: number;
  expiresAt?: number;
}

export interface TradeResponsePayload {
  playerId: string;
  tradeId: string;
  accept: boolean;
}

export interface EndTurnPayload {
  playerId: string;
}

export interface DevForceCrashPayload {
  playerId: string;
}

export interface DevSetNextCrashPayload {
  playerId: string;
  delayMinutes: number;
}

export interface UsePowerCardPayload {
  playerId: string;
  cardType: string;
  payload: any; // E.g., { targetPlayerId: string, targetTileIndex: number } for BECOME_A_DON
}

export interface DevGivePowerCardPayload {
  playerId: string;
  cardType: string;
}

export interface TakeLoanPayload {
  playerId: string;
  amount: number;
}

export interface DevForcePolicePayload {
  playerId: string;
}

export interface DevSetNextPolicePayload {
  playerId: string;
  delayMinutes: number;
}

export interface DevGivePardonCardPayload {
  playerId: string;
}

export interface PlaceBidPayload {
  playerId: string;
  amountToAdd: number;
}

export interface KickVotePayload {
  playerId: string;
  targetPlayerId: string;
}

export interface LotteryState {
  playerId: string;          // Who triggered the lottery
  playerName: string;        // Display name of the player
  playerTicket: string;      // The 5-char code the player got (e.g. "OI3A7")
  winningCode: string;       // The target 5-char code for matching
  revealedCount: number;     // How many chars revealed so far (0–5)
  isComplete: boolean;       // Whether matching animation is done
  isWinner: boolean;         // Did they win 500?
  hasStarted: boolean;       // Has the player clicked start?
  prizeAmount: number;       // Accumulated prize (100 per match)
}
