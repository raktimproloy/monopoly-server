import { RoomService } from './room.service';
import { PropertyService } from './property.service';
import { TradeService } from './trade.service';
import { ActionService } from './action.service';
import { GameState, TradeOfferPayload, BoardTile } from '../../../shared/types';

export class GameService {
  private roomService: RoomService;
  private propertyService: PropertyService;
  private tradeService: TradeService;
  private actionService: ActionService;

  constructor() {
    this.roomService = new RoomService();
    this.propertyService = new PropertyService(this.roomService);
    this.tradeService = new TradeService(this.roomService);
    this.actionService = new ActionService(this.roomService);
  }

  /**
   * Delegates board loading to RoomService.
   */
  async loadBoardTemplate(templateName: string = 'Standard Monopoly'): Promise<{ id: number; tiles: BoardTile[] }> {
    return this.roomService.loadBoardTemplate(templateName);
  }

  /**
   * Delegates room creation to RoomService.
   */
  async createRoom(roomId: string, templateName: string, initialPlayers: { id: string; name: string; avatar: string }[]): Promise<GameState> {
    return this.roomService.createRoom(roomId, templateName, initialPlayers);
  }

  /**
   * Delegates dynamic player connection updates inside the lobby.
   */
  async joinRoom(roomId: string, player: { id: string; name: string; avatar: string }): Promise<GameState> {
    return this.roomService.joinRoom(roomId, player);
  }

  /**
   * Delegates custom rule sets configuration in the lobby.
   */
  async updateSettings(roomId: string, settings: any, playerId: string): Promise<GameState> {
    return this.roomService.updateSettings(roomId, settings, playerId);
  }

  /**
   * Commits the lobby and begins active game play.
   */
  async startGame(roomId: string, playerId: string): Promise<GameState> {
    return this.roomService.startGame(roomId, playerId);
  }

  /**
   * Delegates room state retrieval to RoomService.
   */
  async getRoomState(roomId: string): Promise<GameState | null> {
    return this.roomService.getRoomState(roomId);
  }

  /**
   * Delegates rolling dice action to ActionService.
   */
  async rollDice(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    return this.actionService.rollDice(roomId, playerId);
  }

  /**
   * Delegates buying property to PropertyService.
   */
  async buyProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.buyProperty(roomId, playerId, tileIndex);
  }

  /**
   * Delegates mortgaging property to PropertyService.
   */
  async mortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.mortgageProperty(roomId, playerId, tileIndex);
  }

  /**
   * Delegates unmortgaging property to PropertyService.
   */
  async unmortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.unmortgageProperty(roomId, playerId, tileIndex);
  }

  /**
   * Delegates building a house to PropertyService.
   */
  async buildHouse(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.buildHouse(roomId, playerId, tileIndex);
  }

  /**
   * Delegates breaking a house to PropertyService.
   */
  async sellHouse(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.sellHouse(roomId, playerId, tileIndex);
  }

  /**
   * Delegates selling a property to PropertyService.
   */
  async sellProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.sellProperty(roomId, playerId, tileIndex);
  }

  /**
   * Delegates property auctioning to PropertyService.
   */
  async auctionProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    return this.propertyService.auctionProperty(roomId, playerId, tileIndex);
  }

  /**
   * Delegates trade execution to TradeService.
   */
  async executeTrade(roomId: string, offer: TradeOfferPayload): Promise<{ state: GameState; log: string }> {
    return this.tradeService.executeTrade(roomId, offer);
  }

  /**
   * Delegates ending turn to ActionService.
   */
  async endTurn(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    return this.actionService.endTurn(roomId, playerId);
  }

  /**
   * Delegates declaring bankruptcy to ActionService.
   */
  async declareBankruptcy(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    return this.actionService.declareBankruptcy(roomId, playerId);
  }

  /**
   * Delegates paying jail fine to ActionService.
   */
  async payJailFine(roomId: string, playerId: string): Promise<{ state: GameState; log: string }> {
    return this.actionService.payJailFine(roomId, playerId);
  }

  /**
   * Delegates player removal to RoomService.
   */
  async removePlayer(roomId: string, playerId: string): Promise<{ state: GameState | null; log: string; roomDeleted: boolean }> {
    return this.roomService.removePlayer(roomId, playerId);
  }

  /**
   * Delegates room deletion to RoomService.
   */
  async deleteRoom(roomId: string): Promise<void> {
    return this.roomService.deleteRoom(roomId);
  }
}
