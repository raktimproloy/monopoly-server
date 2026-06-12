import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import * as dotenv from 'dotenv';
import { logger } from './utils/logger';
import { pool } from './config/database';
import { GameController } from './controllers/game.controller';
import { socketConnectionGuard } from './middleware/socketValidation';

dotenv.config();

const app = express();
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
