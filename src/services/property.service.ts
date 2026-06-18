import { RoomService } from './room.service';
import { GameState } from '../../../shared/types';
import { canBuyProperty, buyProperty, canMortgageProperty, mortgageProperty, canUnmortgageProperty, unmortgageProperty, canOwnerManageHijackedProperty } from '../rules';
import { generateLog } from '../utils/logGenerator';

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
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

    const { tiles } = await this.roomService.loadBoardTemplate();

    const validation = canBuyProperty(state, playerId, tileIndex, tiles);
    if (!validation.valid) {
      // DEV MODE / FORCE BUY BYPASS
      // If action is rejected (e.g., player is not standing on the tile), allow remote dev buy
      const tile = tiles.find(t => t.index === tileIndex);
      if (tile && tile.price && !state.properties[tileIndex]?.ownerId) {
        const newState = JSON.parse(JSON.stringify(state)) as GameState;
        const player = newState.players[playerId];
        
        let cost = tile.price;
        if (newState.marketCrash?.active) {
          cost = Math.floor(cost * 0.7);
        }

        player.balance -= cost;
        newState.governmentBank.balance += cost;
        newState.properties[tileIndex] = {
          tileIndex,
          ownerId: playerId,
          houses: 0,
          isMortgaged: false
        };
        
        const description = generateLog('adminAcquiredProperty', { playerName: player.name, tileName: tile.name, price: cost });
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
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

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
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

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
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || tile.type !== 'STREET' || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property for building.');
    }

    // Don Hijack check
    if (newState.activeDonPower && newState.activeDonPower.targetTileIndex === tileIndex) {
      throw new Error('This property is currently hijacked by the Don. Upgrades are frozen.');
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
    newState.governmentBank.balance += cost;
    prop.houses = currentHouses + 1;

    const description = generateLog('upgradeHouse', { 
      playerName: player.name, 
      houseType: prop.houses === 5 ? 'hotel' : 'house', 
      tileName: tile.name, 
      cost 
    });

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
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || tile.type !== 'STREET' || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property for selling houses.');
    }

    // Don Hijack check
    if (newState.activeDonPower && newState.activeDonPower.targetTileIndex === tileIndex) {
      throw new Error('This property is currently hijacked by the Don. Downgrades are frozen.');
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
    newState.governmentBank.balance -= refund;
    prop.houses = currentHouses - 1;

    const description = generateLog('downgradeHouse', {
      playerName: player.name,
      houseType: currentHouses === 5 ? 'hotel' : 'house',
      tileName: tile.name,
      refund
    });

    if (player.balance >= 0 && newState.turnStatus === 'BANKRUPTCY_PENDING' && newState.currentTurnPlayerId === playerId) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }

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
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState;
    const tile = tiles.find(t => t.index === tileIndex);
    const prop = newState.properties[tileIndex];

    if (!tile || !prop || prop.ownerId !== playerId) {
      throw new Error('Invalid property to sell.');
    }

    const hijackCheck = canOwnerManageHijackedProperty(newState, playerId, tileIndex);
    if (!hijackCheck.valid) throw new Error(hijackCheck.error);

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
    newState.governmentBank.balance -= refundAmount;

    delete newState.properties[tileIndex];

    const description = generateLog('liquidateProperty', {
      playerName: player.name,
      tileName: tile.name,
      refundAmount
    });

    if (player.balance >= 0 && newState.turnStatus === 'BANKRUPTCY_PENDING' && newState.currentTurnPlayerId === playerId) {
      newState.turnStatus = 'MUST_ACT_OR_END';
    }

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
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }
    if (state.currentTurnPlayerId !== playerId) throw new Error('You can only perform this action during your turn.');

    const { tiles } = await this.roomService.loadBoardTemplate();
    const newState = JSON.parse(JSON.stringify(state)) as GameState & { activeAuction?: any, previousGameStatus?: string };
    const tile = tiles.find(t => t.index === tileIndex);
    const player = newState.players[playerId];

    if (!tile) throw new Error('Invalid property for auction.');
    
    const prop = newState.properties[tileIndex];
    let startPrice = tile.price || 0;
    let sellerId: string | null = null;

    if (prop && prop.ownerId === playerId) {
      const hijackCheck = canOwnerManageHijackedProperty(newState, playerId, tileIndex);
      if (!hijackCheck.valid) throw new Error(hijackCheck.error);
      if (prop.houses > 0) throw new Error('Cannot auction property with houses.');
      startPrice = prop.isMortgaged ? Math.floor(startPrice * 0.4) : Math.floor(startPrice * 0.7);
      sellerId = playerId;
    } else if (!prop || !prop.ownerId) {
      startPrice = tile.price || 0;
    } else {
      throw new Error('You cannot auction a property you do not own.');
    }

    newState.activeAuction = {
      propertyIndex: tileIndex,
      highestBidderId: null,
      currentBid: startPrice,
      endTime: Date.now() + 6000,
      sellerId: sellerId,
      initiatorId: playerId,
      bids: []
    };
    
    newState.previousGameStatus = newState.gameStatus;
    newState.gameStatus = 'AUCTION' as any;

    const description = generateLog('auctionInitiated', {
      playerName: player.name,
      tileName: tile.name,
      startPrice
    });

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'AUCTION_PROPERTY', { tileIndex }, description
    );
    return { state: savedState, log: description };
  }

  async placeBid(roomId: string, playerId: string, amountToAdd: number): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);
    if (state.settings.jailLoss && state.players[playerId]?.inJail) {
      throw new Error('Jail Loss: You cannot perform this action while in jail.');
    }

    const newState = JSON.parse(JSON.stringify(state)) as GameState & { activeAuction?: any };
    const auction = newState.activeAuction;
    if (!auction) throw new Error('No active auction.');

    if (Date.now() > auction.endTime) {
      throw new Error('Auction has already ended.');
    }
    if (auction.sellerId === playerId || auction.initiatorId === playerId) {
      throw new Error('You cannot bid on this property.');
    }
    if (amountToAdd !== 2 && amountToAdd !== 10 && amountToAdd !== 50) {
      throw new Error('Invalid bid amount.');
    }

    const player = newState.players[playerId];
    const newBid = auction.currentBid + amountToAdd;

    if (player.balance < newBid) {
      throw new Error(`Insufficient funds to bid ৳${newBid}.`);
    }

    auction.highestBidderId = playerId;
    auction.currentBid = newBid;
    auction.endTime = Date.now() + 6000; // Reset to 6 seconds
    
    auction.bids = auction.bids || [];
    auction.bids.push({
      playerId,
      amount: newBid,
      timestamp: Date.now()
    });

    const description = generateLog('auctionBid', {
      playerName: player.name,
      newBid
    });

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, playerId, 'PLACE_BID', { newBid }, description
    );
    return { state: savedState, log: description };
  }

  async resolveAuction(roomId: string): Promise<{ state: GameState; log: string }> {
    const state = await this.roomService.getRoomState(roomId);
    if (!state) throw new Error(`Game room ${roomId} not found.`);

    const newState = JSON.parse(JSON.stringify(state)) as GameState & { activeAuction?: any, previousGameStatus?: string };
    const auction = newState.activeAuction;
    if (!auction) throw new Error('No active auction to resolve.');

    const { propertyIndex, highestBidderId, currentBid, sellerId } = auction;
    const { tiles } = await this.roomService.loadBoardTemplate();
    const tile = tiles.find(t => t.index === propertyIndex);
    
    let description = '';

    if (highestBidderId) {
      const winner = newState.players[highestBidderId];
      winner.balance -= currentBid;
      
      if (sellerId) {
        const seller = newState.players[sellerId];
        seller.balance += currentBid;
        const prop = newState.properties[propertyIndex];
        if (prop) {
            prop.ownerId = highestBidderId;
        }
        description = generateLog('auctionSecuredWithSeller', {
          winnerName: winner.name,
          tileName: tile?.name,
          currentBid,
          sellerName: seller.name
        });
      } else {
        newState.properties[propertyIndex] = {
          tileIndex: propertyIndex,
          ownerId: highestBidderId,
          houses: 0,
          isMortgaged: false
        };
        description = generateLog('auctionSecured', {
          winnerName: winner.name,
          tileName: tile?.name,
          currentBid
        });
      }
    } else {
      description = generateLog('auctionTerminated', { tileName: tile?.name });
      if (!newState.properties[propertyIndex]) {
        newState.properties[propertyIndex] = {
          tileIndex: propertyIndex,
          ownerId: null as any,
          isMortgaged: false,
          houses: 0,
          auctionFailed: true
        } as any;
      }
    }

    newState.gameStatus = (newState.previousGameStatus as any) || 'ACTIVE';
    delete newState.activeAuction;
    delete newState.previousGameStatus;

    const savedState = await this.roomService.updateRoomState(
      roomId, newState, 'SYSTEM', 'RESOLVE_AUCTION', { propertyIndex }, description
    );
    return { state: savedState, log: description };
  }
}
