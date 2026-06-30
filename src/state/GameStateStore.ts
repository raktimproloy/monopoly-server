import { getRedisClient, isRedisAvailable } from '../redis/client';
import { RedisKeys } from '../redis/keys';
import { GameState } from '../types';
import { cloneState } from './delta';
import { logger } from '../utils/logger';

export interface StoredRoom {
  state: GameState;
  version: number;
  templateId: number;
}

/** In-process fallback when Redis is unavailable (local dev / outage). */
const memoryStore = new Map<string, StoredRoom>();

/**
 * Low-level persistence for active room snapshots.
 * Hot path reads/writes hit Redis (or memory fallback) — never PostgreSQL.
 */
export class GameStateStore {
  async get(roomId: string): Promise<StoredRoom | null> {
    const redis = await getRedisClient();
    if (redis && isRedisAvailable()) {
      const raw = await redis.get(RedisKeys.roomState(roomId));
      if (!raw) return memoryStore.get(roomId) ?? null;
      try {
        return JSON.parse(raw) as StoredRoom;
      } catch {
        logger.error(`[GameStateStore] corrupt JSON for room ${roomId}`);
        return null;
      }
    }
    return memoryStore.get(roomId) ?? null;
  }

  async getState(roomId: string): Promise<GameState | null> {
    const record = await this.get(roomId);
    return record ? cloneState(record.state) : null;
  }

  /**
   * Optimistic concurrency write.
   * @throws Error when version mismatch (another worker won the race).
   */
  async save(roomId: string, state: GameState, expectedVersion: number, templateId: number): Promise<number> {
    const nextVersion = expectedVersion + 1;
    const payload: StoredRoom = {
      state: cloneState(state),
      version: nextVersion,
      templateId,
    };

    const redis = await getRedisClient();
    if (redis && isRedisAvailable()) {
      const key = RedisKeys.roomState(roomId);
      const versionKey = RedisKeys.roomVersion(roomId);

      const result = await redis.eval(
        SAVE_SCRIPT,
        2,
        key,
        versionKey,
        String(expectedVersion),
        JSON.stringify(payload),
        RedisKeys.activeRooms(),
        roomId
      );

      if (result === 0) {
        throw new Error(`Concurrency check failed for room ${roomId} (expected v${expectedVersion}).`);
      }

      memoryStore.set(roomId, payload);
      return nextVersion;
    }

    const current = memoryStore.get(roomId);
    if (current && current.version !== expectedVersion) {
      throw new Error(`Concurrency check failed for room ${roomId} (expected v${expectedVersion}).`);
    }

    memoryStore.set(roomId, payload);
    return nextVersion;
  }

  async create(roomId: string, state: GameState, templateId: number): Promise<StoredRoom> {
    const payload: StoredRoom = { state: cloneState(state), version: 1, templateId };
    const redis = await getRedisClient();

    if (redis && isRedisAvailable()) {
      await redis.set(RedisKeys.roomState(roomId), JSON.stringify(payload));
      await redis.set(RedisKeys.roomVersion(roomId), '1');
      await redis.sadd(RedisKeys.activeRooms(), roomId);
    }

    memoryStore.set(roomId, payload);
    return payload;
  }

  async delete(roomId: string): Promise<StoredRoom | null> {
    const existing = await this.get(roomId);
    const redis = await getRedisClient();

    if (redis && isRedisAvailable()) {
      await redis.del(RedisKeys.roomState(roomId), RedisKeys.roomVersion(roomId));
      await redis.srem(RedisKeys.activeRooms(), roomId);
    }

    memoryStore.delete(roomId);
    return existing;
  }

  async listActiveRoomIds(): Promise<string[]> {
    const redis = await getRedisClient();
    if (redis && isRedisAvailable()) {
      return redis.smembers(RedisKeys.activeRooms());
    }
    return Array.from(memoryStore.keys());
  }
}

/** Atomic compare-and-swap for versioned room state. */
const SAVE_SCRIPT = `
local versionKey = KEYS[2]
local expected = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', versionKey) or '0')
if current ~= expected then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', versionKey, tostring(expected + 1))
redis.call('SADD', ARGV[3], ARGV[4])
return 1
`;

export const gameStateStore = new GameStateStore();
