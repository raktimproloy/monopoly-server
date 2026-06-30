import { db } from '../config/database';
import { GameState } from '../types';
import { logger } from '../utils/logger';
import { runtimeFlags } from '../config/runtime';

export interface PersistedLogEntry {
  room_id: string;
  player_id: string;
  action_type: string;
  action_payload: unknown;
  state_snapshot: GameState;
}

/**
 * Cold-path PostgreSQL persistence.
 * Active games NEVER block on these writes — everything is fire-and-forget.
 */
export class PostgresPersistence {
  private logQueue: PersistedLogEntry[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  /** Rooms known to exist in game_rooms (avoids repeated INSERT checks). */
  private ensuredRooms = new Set<string>();

  constructor() {
    // Batch insert logs every 2s to reduce PG pressure under burst traffic.
    this.flushTimer = setInterval(() => this.flushLogs(), 2000);
  }

  /** Queue an audit log entry (non-blocking). */
  queueLog(entry: PersistedLogEntry): void {
    if (runtimeFlags.useMemoryFallback) return;
    this.logQueue.push(entry);
    if (this.logQueue.length >= 50) {
      void this.flushLogs();
    }
  }

  /**
   * Ensures a game_rooms row exists so game_logs FK inserts succeed.
   * Called once per room when the room is created or on first state update.
   */
  async ensureRoomRecord(roomId: string, state: GameState, templateId: number): Promise<void> {
    if (runtimeFlags.useMemoryFallback || this.ensuredRooms.has(roomId)) return;

    try {
      await db.query(
        `INSERT INTO game_rooms (room_id, board_template_id, state, version)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (room_id) DO NOTHING`,
        [roomId, templateId, JSON.stringify(state)]
      );
      this.ensuredRooms.add(roomId);
    } catch (err) {
      logger.warn(`[PostgresPersistence] ensure room ${roomId} failed`, err);
    }
  }

  private async flushLogs(): Promise<void> {
    if (runtimeFlags.useMemoryFallback || this.logQueue.length === 0) return;

    const batch = this.logQueue.splice(0, this.logQueue.length);
    try {
      await this.insertLogBatch(batch);
    } catch (err) {
      if (this.isRoomFkViolation(err)) {
        for (const roomId of new Set(batch.map((e) => e.room_id))) {
          const sample = batch.find((e) => e.room_id === roomId);
          if (sample) {
            await this.ensureRoomRecord(roomId, sample.state_snapshot, 1);
          }
        }
        try {
          await this.insertLogBatch(batch);
          return;
        } catch (retryErr) {
          logger.warn('[PostgresPersistence] log batch retry failed — re-queuing', retryErr);
          this.logQueue.unshift(...batch);
          return;
        }
      }
      logger.warn('[PostgresPersistence] log batch flush failed — re-queuing', err);
      this.logQueue.unshift(...batch);
    }
  }

  private isRoomFkViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'message' in err &&
      String((err as { message: string }).message).includes('game_logs_room_id_fkey')
    );
  }

  private async insertLogBatch(batch: PersistedLogEntry[]): Promise<void> {
    await db.transaction(async (client) => {
      for (const entry of batch) {
        await client.query(
          `INSERT INTO game_logs (room_id, player_id, action_type, action_payload, state_snapshot)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            entry.room_id,
            entry.player_id,
            entry.action_type,
            JSON.stringify(entry.action_payload),
            JSON.stringify(entry.state_snapshot),
          ]
        );
      }
    });
  }

  /**
   * Persist final room snapshot when a match ends or room is torn down.
   * Active rooms are NOT updated on every move anymore.
   */
  async persistFinalRoomState(roomId: string, state: GameState, templateId: number): Promise<void> {
    if (runtimeFlags.useMemoryFallback) return;

    try {
      await db.query(
        `INSERT INTO game_rooms (room_id, board_template_id, state, version)
         VALUES ($1, $2, $3, 1)
         ON CONFLICT (room_id) DO UPDATE
           SET state = EXCLUDED.state,
               version = game_rooms.version + 1,
               updated_at = NOW()`,
        [roomId, templateId, JSON.stringify(state)]
      );
      this.ensuredRooms.add(roomId);
      logger.info(`[PostgresPersistence] final state archived for room ${roomId}`);
    } catch (err) {
      logger.error(`[PostgresPersistence] failed to archive room ${roomId}`, err);
    }
  }

  async deleteRoomRecord(roomId: string): Promise<void> {
    if (runtimeFlags.useMemoryFallback) return;
    this.ensuredRooms.delete(roomId);
    try {
      await db.query('DELETE FROM game_rooms WHERE room_id = $1', [roomId]);
    } catch (err) {
      logger.warn(`[PostgresPersistence] delete room ${roomId} failed`, err);
    }
  }

  shutdown(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    void this.flushLogs();
  }
}

export const postgresPersistence = new PostgresPersistence();
