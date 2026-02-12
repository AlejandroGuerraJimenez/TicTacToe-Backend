require('dotenv/config');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const sql = fs.readFileSync(
  path.join(__dirname, '../drizzle/0004_chat_last_read.sql'),
  'utf8'
);

const statements = sql
  .split(/;\s*\n/)
  .map((s) => s.replace(/--.*/g, '').trim())
  .filter((s) => s.length > 0);

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    for (const statement of statements) {
      if (!statement) continue;
      console.log('Running:', statement.slice(0, 70) + '...');
      await client.query(statement);
    }
    console.log('Migration 0004 applied.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
