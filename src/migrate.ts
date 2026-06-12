import { Client } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('Error: DATABASE_URL is not set in environment configurations.');
  process.exit(1);
}

async function runMigration() {
  console.log('Connecting to PostgreSQL database node...');
  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('Connection established.');

    // Resolve path to schema.sql relative to dist/src/migrate.js or src/migrate.ts
    const schemaPath = path.resolve(__dirname, '../schema.sql');
    console.log(`Loading schema queries from: ${schemaPath}`);
    
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found at ${schemaPath}`);
    }

    const sql = fs.readFileSync(schemaPath, 'utf8');

    console.log('Executing database schema.sql seeds...');
    await client.query(sql);
    console.log('Database layout initialized and standard board templates seeded successfully!');
  } catch (error) {
    console.error('Migration process failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
