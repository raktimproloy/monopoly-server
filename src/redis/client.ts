import Redis from 'ioredis';
import { logger } from '../utils/logger';

export type RedisMode = 'redis' | 'memory' | 'uninitialized';

let primaryClient: Redis | null = null;
let subscriberClient: Redis | null = null;
/**
 * Connection state. Starts 'uninitialized' so the first getRedisClient() call
 * actually attempts a connection. It only drops to 'memory' after Redis is
 * confirmed unavailable (no REDIS_URL, or a connection/ping failure).
 */
let mode: RedisMode = 'uninitialized';

/** True once we've resolved whether Redis is usable (success or fallback). */
function isConfigured(): boolean {
  return !!(process.env.REDIS_URL && process.env.REDIS_URL.trim());
}

export function getRedisMode(): RedisMode {
  return mode;
}

export function isRedisAvailable(): boolean {
  return mode === 'redis' && primaryClient !== null;
}

function redisUrl(): string {
  return process.env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379';
}

/** Primary Redis client for reads/writes (singleton). */
export async function getRedisClient(): Promise<Redis | null> {
  if (mode === 'memory') return null;
  if (primaryClient) return primaryClient;

  // No REDIS_URL configured → deliberately run on the in-memory store.
  if (!isConfigured()) {
    mode = 'memory';
    logger.info('[Redis] REDIS_URL not set — using in-memory GameStateStore');
    return null;
  }

  const client = new Redis(redisUrl(), {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
  });

  client.on('error', (err) => {
    // After a successful connect, transient errors shouldn't silently disable
    // Redis; ioredis auto-reconnects. Only log here.
    logger.error('[Redis] connection error', err);
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
  if (mode === 'memory' || !isConfigured()) return null;
  if (subscriberClient) return subscriberClient;

  const client = new Redis(redisUrl(), {
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
