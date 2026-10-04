import type { PermissionKind, RequestedPermission } from '../policy/policy';

/**
 * A tool is a value, not a function that can be called directly.
 *
 * Nothing in the codebase holds a reference to a tool implementation. The only
 * way to reach one is through `ToolRunner`, which consults the policy first.
 * That is what makes "there is no bypass path" a structural property instead of
 * a promise: there is nothing to bypass *to*.
 */
export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  /** The permission this tool needs. One tool, one permission. */
  permission: (args: I) => RequestedPermission;
  /** Zod-free by design: validation is a function so a tool can be tested without a schema registry. */
  validate: (args: unknown) => I;
  execute: (args: I, signal?: AbortSignal) => Promise<ToolOutput<O>>;
  /**
   * The only capability that leaves the process. `web.fetch` is the one tool
   * that touches the network, and it is the one that needs a per-argument
   * allowlist rather than a tier-wide one.
   */
  egress?: (args: I) => boolean;
}

export interface ToolOutput<O = unknown> {
  ok: boolean;
  /**
   * A failure is a value, never a thrown exception (the `simonw/llm` pattern).
   * A tool that fails must give the model something it can react to, not end the
   * turn.
   */
  data?: O;
  error?: string;
  /** Bytes or characters returned, for the size-limit accounting. */
  size?: number;
  /** Content type where one exists — checked, not assumed. */
  contentType?: string;
}

export type VerdictName = 'allow' | 'require_human' | 'deny';

/**
 * What the runner did. `gated` means the tool did **not** run and the task must
 * pause; `blocked` means it will never run; `executed` means it ran.
 */
export type ToolOutcome =
  | { kind: 'executed'; output: ToolOutput; permission: RequestedPermission }
  | {
      kind: 'gated';
      permission: RequestedPermission;
      rule: string;
      reason: string;
    }
  | { kind: 'blocked'; permission: RequestedPermission; rule: string; reason: string }
  | { kind: 'unknown_tool'; name: string };

export function failed(error: string): ToolOutput<never> {
  return { ok: false, error };
}

export function succeeded<O>(
  data: O,
  extra: { size?: number; contentType?: string } = {},
): ToolOutput<O> {
  return { ok: true, data, ...extra };
}

/** Permissions every tool of a given name needs, for the policy lookup. */
export function permissionFor(kind: PermissionKind, resource: string): RequestedPermission {
  return { kind, resource };
}