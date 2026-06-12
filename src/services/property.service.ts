import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { canBuyProperty, buyProperty, canMortgageProperty, mortgageProperty, canUnmortgageProperty, unmortgageProperty } from '../rules';

export class PropertyService {
  private roomService: RoomService;

  constructor(roomService: RoomService) {
    this.roomService = roomService;
  }

  /**
   * Purchases the tile the player is currently standing on.
   */
  async buyProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canBuyProperty(state, playerId, tileIndex, tiles);
    if (!validation.valid) {
      // DEV MODE / FORCE BUY BYPASS
      // If action is rejected (e.g., player is not standing on the tile), allow remote dev buy
      const tile = tiles.find(t => t.index === tileIndex);
      if (tile && tile.price && !state.properties[tileIndex]?.ownerId) {
        const newState = JSON.parse(JSON.stringify(state)) as GameState;
        const player = newState.players[playerId];
        
        player.balance -= tile.price;
        newState.properties[tileIndex] = {
          tileIndex,
          ownerId: playerId,
          houses: 0,
          isMortgaged: false
        };
        
        const description = `[DEV] ${player.name} remotely acquired ${tile.name} for $${tile.price}.`;
        const savedState = await this.roomService.updateRoomState(
          roomId, newState, playerId, 'BUY_PROPERTY', { tileIndex }, description
        );
        return { state: savedState, log: description };
      }

      throw new Error(validation.error || 'Action rejected by rules engine.');
    }

    const { newState, description } = buyProperty(state, playerId, tileIndex, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'BUY_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Mortgages an owned property space.
   */
  async mortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canMortgageProperty(state, playerId, tileIndex);
    if (!validation.valid) {
      throw new Error(validation.error || 'Cannot mortgage property.');
    }

    const { newState, description } = mortgageProperty(state, playerId, tileIndex, tiles);

    if (newState.players[playerId].balance >= 0 && newState.turnStatus === 'BANKRUPTCY_PENDING') {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'MORTGAGE_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Unmortgages a mortgaged property space.
   */
  async unmortgageProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canUnmortgageProperty(state, playerId, tileIndex, tiles);
    if (!validation.valid) {
      throw new Error(validation.error || 'Cannot unmortgage property.');
    }

    const { newState, description } = unmortgageProperty(state, playerId, tileIndex, tiles);

    const savedState = await this.roomService.updateRoomState(
      roomId,
      newState,
      playerId,
      'UNMORTGAGE_PROPERTY',
      { tileIndex },
      description
    );

    return { state: savedState, log: description };
  }

  /**
   * Builds a house or hotel on a property group if criteria are met.
   */
  async buildHouse(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || tile.type !== 'STREET' || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property for building.');
    }

    const groupTiles = tiles.filter(t => t.group === tile.group);
    const groupProps = groupTiles.map(t => newState.properties[t.index]);

    const ownsFullSet = groupProps.every(p => p && p.ownerId === playerId);
    if (!ownsFullSet) throw new Error('Must own the full color set to build.');
    if (groupProps.some(p => p && p.isMortgaged)) throw new Error('Cannot build if any property in the group is mortgaged.');

    const currentHouses = prop.houses || 0;
    if (currentHouses >= 5) throw new Error('Maximum upgrades already built on this property.');

    const minHouses = Math.min(...groupProps.map(p => (p && p.houses) ? p.houses : 0));
    if (currentHouses > minHouses) throw new Error('You must build evenly across the group.');

    const cost = tile.houseCost || 0;
    const player = newState.players[playerId];
    if (player.balance < cost) throw new Error('Insufficient funds to build.');

    player.balance -= cost;
    prop.houses = currentHouses + 1;

    const description = `${player.name} built a ${prop.houses === 5 ? 'hotel' : 'house'} on ${tile.name} for $${cost}.`;

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'BUILD_HOUSE', { tileIndex }, description
    );
    return { state: savedState, log: description };
  }

  /**
   * Sells (breaks) a house or hotel for half its value.
   */
  async sellHouse(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || tile.type !== 'STREET' || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property for selling houses.');
    }

    const groupTiles = tiles.filter(t => t.group === tile.group);
    const groupProps = groupTiles.map(t => newState.properties[t.index]);

    const currentHouses = prop.houses || 0;
    if (currentHouses <= 0) throw new Error('No houses to sell on this property.');

    const maxHouses = Math.max(...groupProps.map(p => (p && p.houses) ? p.houses : 0));
    if (currentHouses < maxHouses) throw new Error('You must break houses evenly across the group.');

    const refund = Math.floor((tile.houseCost || 0) / 2);
    const player = newState.players[playerId];

    player.balance += refund;
    prop.houses = currentHouses - 1;

    const description = `${player.name} broke a ${currentHouses === 5 ? 'hotel' : 'house'} from ${tile.name} for $${refund}.`;

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'SELL_HOUSE', { tileIndex }, description
    );
    return { state: savedState, log: description };
  }

  /**
   * Surrenders an unimproved property back to the bank for its mortgage value.
   */
  async sellProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property to sell.');
    }

    if (tile.type === 'STREET' && tile.group) {
      const groupTiles = tiles.filter(t => t.group === tile.group);
      const groupHasHouses = groupTiles.some(t => {
        const p = newState.properties[t.index];
        return p && p.houses > 0;
      });
      if (groupHasHouses) throw new Error('Must break all houses on the color group before selling the property.');
    }

    const player = newState.players[playerId];
    const refundAmount = prop.isMortgaged ? 0 : (tile.mortgageValue || Math.floor((tile.price || 0) / 2));
    player.balance += refundAmount;

    delete newState.properties[tileIndex];

    const description = `${player.name} liquidated ${tile.name} to the bank for $${refundAmount}.`;

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'SELL_PROPERTY', { tileIndex }, description
    );
    return { state: savedState, log: description };
  }

  /**
   * Initiates an auction sequence when a property is declined.
   */
  async auctionProperty(roomId: string, playerId: string, tileIndex: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const player = newState.players[playerId];

    const description = `${player.name} declined to buy ${tile?.name}. The property has been sent to AUCTION!`;

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'AUCTION_PROPERTY', { tileIndex }, description
    );
    return { state: savedState, log: description };
  }
}
