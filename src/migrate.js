const fs = require('fs');
const path = require('path');
const db = require('./config/database');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

/**
 * Run all SQL migration files in sorted order.
 * Each file is executed in a single transaction.
 * Safe to re-run because migrations use IF NOT EXISTS / idempotent DDL.
 */
async function runMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found.');
    return;
  }

  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const sql = fs.readFileSync(filePath, 'utf-8').trim();
    if (!sql) continue;

    try {
      await db.query(sql);
      console.log(`Migration applied: ${file}`);
    } catch (err) {
      console.error(`Migration failed: ${file} — ${err.message}`);
      throw err;
    }
  }

  console.log(`All ${files.length} migrations applied successfully.`);
}

module.exports = { runMigrations };
