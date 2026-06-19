import { Pool, PoolClient } from 'pg';
import * as dotenv from 'dotenv';
import { logger } from '../utils/logger';
import { parse } from 'pg-connection-string';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

const isProductionOrCloud = connectionString && (connectionString.includes('supabase') || connectionString.includes('pooler') || connectionString.includes('render'));

const poolConfig = connectionString ? (parse(connectionString) as any) : {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'monopoly',
} as any;

// Override SSL for production/cloud providers
if (isProductionOrCloud && poolConfig) {
  poolConfig.ssl = { rejectUnauthorized: false };
}

// Configure PostgreSQL connection pool
export const pool = new Pool({
  ...poolConfig,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', err);
});

export const db = {
  /**
   * Execute a query against the pool.
   */
  async query<T = any>(text: string, params?: any[]): Promise<T[]> {
    const start = Date.now();
    try {
      const res = await pool.query(text, params);
      const duration = Date.now() - start;
      logger.info(`Executed query: ${text.slice(0, 80)}... in ${duration}ms (rows: ${res.rowCount})`);
      return res.rows;
    } catch (error) {
      logger.error(`Database query failed: ${text}`, { error, params });
      throw error;
    }
  },

  /**
   * Run operations inside a PostgreSQL transaction.
   */
  async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Transaction rolled back due to error', error);
      throw error;
    } finally {
      client.release();
    }
  }
};
