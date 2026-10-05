import type { Db } from '@/server/db/task-store';
import { PgAuditSink } from '@/server/db/audit-sink';
import { PgTaskStore } from '@/server/db/task-store';
import { policyFromJson } from '@/server/policy/policy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, assertUsable, type Config } from '@/server/http/config';

let configCache: Config | null = null;
let dbCache: Db | null = null;

export function getConfig(): Config {
  if (!configCache) {
    const config = loadConfig();
    assertUsable(config);
    configCache = config;
  }
  return configCache;
}

export function getDb(): Db {
  if (!dbCache) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return dbCache;
}

export function initDatabase(db: Db): void {
  dbCache = db;
}

export function getAuditSink(db: Db): PgAuditSink {
  return new PgAuditSink(db);
}

export function getPolicy(): any {
  try {
    const policyPath = join(process.cwd(), getConfig().policyPath);
    const raw = readFileSync(policyPath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { default_tier: 'third_party', tiers: {} };
  }
}

export function buildDeps(db: Db) {
  const config = getConfig();
  return {
    db,
    audit: new PgAuditSink(db),
    config,
    policy: policyFromJson(JSON.stringify(getPolicy())),
    roots: config.workspaceRoots,
    allowedFetchHosts: config.allowedFetchHosts,
    maxBytes: 1024 * 1024,
    budgets: new Map(),
    systemPrompt: (a: any) => `${a.systemPrompt} (${a.systemPromptVersion})`,
    modelFor: async (agentId: string, model: string) => {
      throw new Error('Provider not configured');
    },
  };
}