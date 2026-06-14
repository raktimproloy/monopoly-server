import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as dotenv from 'dotenv';
import { logger } from './utils/logger';
import { pool } from './config/database';
import { GameController } from './controllers/game.controller';
import { socketConnectionGuard } from './middleware/socketValidation';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || '*'
}));
const httpServer = createServer(app);

// Initialize Socket.io with CORS parameters
const io = new Server(httpServer, {
  cors: {
    origin: process.env.CLIENT_ORIGIN || '*',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Register connection-level validation middleware (Anti-Cheat / Authentication layer)
io.use(socketConnectionGuard);

const gameController = new GameController(io);

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
    // Clear memory states
    for (const key of Object.keys(memoryRooms)) {
      delete memoryRooms[key];
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
  pool.end(() => {
    logger.info('Database pool closed. Exiting process.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
export { app, httpServer, io };
