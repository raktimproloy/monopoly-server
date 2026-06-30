import Redis from 'ioredis';
import { logger } from '../utils/logger';

export type RedisMode = 'redis' | 'memory';

let primaryClient: Redis | null = null;
let subscriberClient: Redis | null = null;
let mode: RedisMode = 'memory';

/**
 * Returns true when a live Redis connection is available.
 * Falls back to in-process memory when REDIS_URL is unset or connection fails.
 */
export function getRedisMode(): RedisMode {
  return mode;
}

export function isRedisAvailable(): boolean {
  return mode === 'redis' && primaryClient !== null;
}

function buildRedisOptions() {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  return {
    url,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  };
}

/** Primary Redis client for reads/writes (singleton). */
export async function getRedisClient(): Promise<Redis | null> {
  if (mode === 'memory') return null;
  if (primaryClient) return primaryClient;

  const client = new Redis(buildRedisOptions().url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    logger.error('[Redis] connection error — falling back to memory store', err);
    mode = 'memory';
    primaryClient = null;
  });

  try {
    await client.connect();
    await client.ping();
    primaryClient = client;
    mode = 'redis';
    logger.info('[Redis] connected — active game state will use Redis');
    return primaryClient;
  } catch (err) {
    logger.warn('[Redis] unavailable — using in-memory GameStateStore fallback', err);
    mode = 'memory';
    await client.quit().catch(() => undefined);
    return null;
  }
}

/**
 * Dedicated subscriber connection (Socket.IO horizontal scaling).
 * ioredis requires a separate connection for SUBSCRIBE mode.
 */
export async function getRedisSubscriber(): Promise<Redis | null> {
  if (mode === 'memory') return null;
  if (subscriberClient) return subscriberClient;

  const client = new Redis(buildRedisOptions().url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  try {
    await client.connect();
    subscriberClient = client;
    return subscriberClient;
  } catch (err) {
    logger.warn('[Redis] subscriber unavailable', err);
    return null;
  }
}

export async function shutdownRedis(): Promise<void> {
  await primaryClient?.quit().catch(() => undefined);
  await subscriberClient?.quit().catch(() => undefined);
  primaryClient = null;
  subscriberClient = null;
}
