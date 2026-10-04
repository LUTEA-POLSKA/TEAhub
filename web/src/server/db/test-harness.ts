import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from './schema';

const MIGRATION_FILE = join(process.cwd(), 'drizzle', '0000_vertical_slice.sql');

/**
 * A fresh in-memory PostgreSQL per test file.
 *
 * PGlite is PostgreSQL compiled to WebAssembly — same parser, same planner,
 * same DDL. That is the point: it is not a second database dialect like SQLite
 * would be, so a passing test here means the same SQL runs on a real server.
 * What it does not give us is a network socket or representative performance,
 * so the load test in §16 still runs against a real PostgreSQL.
 */
export async function createTestDb() {
  const client = new PGlite();
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  await client.exec(sql);
  const db = drizzle(client, { schema });
  return { client, db, close: () => client.close() };
}

export { schema };