import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as dotenv from 'dotenv';
import { logger } from './utils/logger';
import { pool } from './config/database';
import { GameController } from './controllers/game.controller';
import { socketConnectionGuard } from './middleware/socketValidation';
import { roomManager } from './managers/RoomManager';
import { RoomBroadcaster } from './broadcast/RoomBroadcaster';
import { postgresPersistence } from './persistence/PostgresPersistence';
import { shutdownRedis, getRedisClient } from './redis/client';
import cors from 'cors';

dotenv.config();

function parseCorsOrigins(): string | string[] {
  const raw = process.env.CLIENT_ORIGIN?.trim();
  if (!raw || raw === '*') return '*';
  const origins = raw.split(',').map((o) => o.trim()).filter(Boolean);
  return origins.length === 1 ? origins[0] : origins;
}

const corsOrigin = parseCorsOrigins();

const app = express();
app.use(cors({
  origin: corsOrigin
}));
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
    credentials: true
  },
  // Detect dead connections faster than the default (25s/60s) for snappier UX.
  pingInterval: 20000,
  pingTimeout: 25000,
  // Prefer a direct WebSocket upgrade; polling stays available as a fallback.
  transports: ['websocket', 'polling'],
  // Game deltas are small JSON — per-message compression adds CPU latency with
  // little bandwidth benefit, so only compress payloads above a threshold.
  perMessageDeflate: {
    threshold: 1024,
  },
  httpCompression: {
    threshold: 1024,
  },
  // Small, bounded payloads — reject anything abnormally large early.
  maxHttpBufferSize: 1e6,
});

io.use(socketConnectionGuard);

/** Real-time fan-out: RoomManager commits → RoomBroadcaster emits deltas. */
const roomBroadcaster = new RoomBroadcaster(io);
roomManager.on('stateUpdated', (event) => {
  void roomBroadcaster.broadcast(event);
});

const gameController = new GameController(io, roomBroadcaster);

void getRedisClient();

// Orchestrate socket connections
io.on('connection', (socket) => {
  gameController.registerConnection(socket);
});

// Basic Express HTTP endpoints
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Clear DB endpoint
app.post('/api/clear-db', async (req, res) => {
  try {
    const { memoryRooms, memoryLogs } = await import('./services/room.service');
    const { gameStateStore } = await import('./state/GameStateStore');
    const roomIds = await gameStateStore.listActiveRoomIds();
    for (const id of roomIds) {
      await gameStateStore.delete(id);
    }
    memoryLogs.length = 0;

    // Truncate database tables if connected
    try {
      await pool.query('TRUNCATE TABLE game_logs, game_rooms RESTART IDENTITY CASCADE');
      logger.info('Database tables truncated successfully.');
    } catch (dbErr) {
      logger.warn('Failed to truncate DB (may be using memory fallback):', dbErr);
    }

    // Broadcast server reset to all clients
    io.emit('server_reset');

    res.status(200).json({ status: 'OK', message: 'Database cleared and game servers closed.' });
  } catch (error) {
    logger.error('Error clearing database:', error);
    res.status(500).json({ status: 'ERROR', message: 'Failed to clear database' });
  }
});

// Start HTTP Server
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});

// Graceful teardown listeners
const gracefulShutdown = () => {
  logger.info('Shutting down server. Closing database client pool...');
  postgresPersistence.shutdown();
  void shutdownRedis();
  pool.end(() => {
    logger.info('Database pool closed. Exiting process.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
export { app, httpServer, io };
