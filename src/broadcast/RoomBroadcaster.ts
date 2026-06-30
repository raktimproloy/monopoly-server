import { Server } from 'socket.io';
import { getRedisClient, getRedisSubscriber } from '../redis/client';
import { RedisKeys } from '../redis/keys';
import { buildDeltaPayload, DeltaPayload } from '../state/delta';
import { StateUpdateEvent } from '../managers/RoomManager';
import { logger } from '../utils/logger';

/**
 * Fan-out layer for room state changes.
 * - Emits jsondiffpatch deltas over Socket.IO (`state_delta`)
 * - Publishes the same payload on Redis Pub/Sub for horizontal scaling
 * - Falls back to legacy `state_updated` full snapshots when `full: true`
 */
export class RoomBroadcaster {
  private readonly instanceId: string;
  private subscribedRooms = new Set<string>();

  constructor(private readonly io: Server) {
    this.instanceId = `node-${process.pid}-${Date.now()}`;
  }

  /** Subscribe this node to cross-server fan-out for a room channel. */
  async subscribeRoom(roomId: string): Promise<void> {
    if (this.subscribedRooms.has(roomId)) return;
    const sub = await getRedisSubscriber();
    if (!sub) return;

    const channel = RedisKeys.roomChannel(roomId);
    await sub.subscribe(channel);
    sub.on('message', (ch, message) => {
      if (ch !== channel) return;
      try {
        const payload = JSON.parse(message) as DeltaPayload & { origin?: string };
        if (payload.origin === this.instanceId) return;
        this.io.to(roomId).emit('state_delta', payload);
      } catch (err) {
        logger.warn('[RoomBroadcaster] invalid pub/sub payload', err);
      }
    });

    this.subscribedRooms.add(roomId);
  }

  /** Primary entry: broadcast a committed state mutation to all room clients. */
  async broadcast(event: StateUpdateEvent, extra?: Record<string, unknown>): Promise<DeltaPayload> {
    const payload = buildDeltaPayload(
      event.previousState,
      event.state,
      event.version,
      event.log
    );

    const outbound = { ...payload, ...extra, origin: this.instanceId };

    this.io.to(event.roomId).emit('state_delta', outbound);

    if (payload.full) {
      this.io.to(event.roomId).emit('state_updated', {
        state: event.state,
        log: event.log,
        version: event.version,
        ...extra,
      });
    }

    await this.publishToRedis(event.roomId, outbound);
    return payload;
  }

  /** Full snapshot for join / reconnect (no delta). */
  emitFullState(roomId: string, state: import('../types').GameState, log: string, version = 1): void {
    const payload: DeltaPayload = {
      full: true,
      version,
      seq: Date.now(),
      log,
      state,
    };
    this.io.to(roomId).emit('state_delta', payload);
    this.io.to(roomId).emit('state_updated', { state, log, version });
  }

  private async publishToRedis(roomId: string, payload: DeltaPayload & { origin?: string }): Promise<void> {
    const redis = await getRedisClient();
    if (!redis) return;
    try {
      await redis.publish(RedisKeys.roomChannel(roomId), JSON.stringify(payload));
    } catch (err) {
      logger.warn(`[RoomBroadcaster] Redis publish failed for ${roomId}`, err);
    }
  }
}
