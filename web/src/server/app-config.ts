import type { Config } from '@/server/http/config';

export function createAppConfig(config: Config) {
  return {
    port: config.port,
    publicOrigin: config.publicOrigin,
    databaseUrl: config.databaseUrl,
    workspaceRoots: config.workspaceRoots,
    allowedFetchHosts: config.allowedFetchHosts,
    providers: config.providers,
    policyPath: config.policyPath,
    sessionTtlMs: config.sessionTtlMs,
  };
}