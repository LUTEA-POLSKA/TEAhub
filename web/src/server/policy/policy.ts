import { z } from 'zod';

/**
 * The step from *requested* to *granted*.
 *
 * Ported from src/policy.rs. The 18 Rust tests are the contract; the semantics
 * are preserved exactly, including the ordering trick in `tierFor` and the
 * glob asymmetry between `*` and `**`.
 *
 * Three properties carry the whole design:
 *
 *  * **Intersection, never union.** A grant is a subset of what was requested.
 *    A policy cannot add a permission the author did not ask for, and a
 *    manifest cannot widen one the policy did not allow.
 *  * **Fail closed.** Anything that cannot be evaluated is denied. An unparsed
 *    rule, an unknown tier, a malformed pattern — all deny, because a policy
 *    that quietly allows what it does not understand is worse than no policy.
 *  * **No model in the loop.** A pure function over the request and the policy.
 *    An LLM may *request* an action; it may never *authorise* one.
 */

export const PERMISSION_KINDS = [
  'fs.read',
  'fs.write',
  'net.egress',
  'proc.spawn',
  'secret.use',
] as const;

export type PermissionKind = (typeof PERMISSION_KINDS)[number];

export const permissionKindSchema = z.enum(PERMISSION_KINDS);

/** Permissions that are meaningless without a resource to act on. */
export function requiresResource(kind: PermissionKind): boolean {
  return kind === 'fs.read' || kind === 'fs.write' || kind === 'net.egress';
}

export const requestedPermissionSchema = z.object({
  kind: permissionKindSchema,
  /** A path, a host, a secret name. Absent only for `proc.spawn`. */
  resource: z.string().min(1).optional(),
});

export type RequestedPermission = z.infer<typeof requestedPermissionSchema>;

/**
 * Ordered most-trusted first. The Rust original derives `Ord` from declaration
 * order and then takes `max` of two tiers, which lands on the *less* trusted of
 * the pair. `TIER_RANK` makes that explicit instead of leaving it to enum
 * declaration order, which is a property a refactor can silently destroy.
 */
export const TRUST_TIERS = ['builtin', 'local', 'third_party', 'untrusted'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Higher number = less trusted. */
const TIER_RANK: Record<TrustTier, number> = {
  builtin: 0,
  local: 1,
  third_party: 2,
  untrusted: 3,
};

const lessTrusted = (a: TrustTier, b: TrustTier): TrustTier =>
  TIER_RANK[a] >= TIER_RANK[b] ? a : b;

/**
 * Never more generous than `third_party`. A manifest that declares no trust is
 * third-party code until proven otherwise.
 */
export function tierFromClaim(claimed: TrustTier | undefined): TrustTier {
  return claimed ?? 'third_party';
}

export type Verdict = 'allow' | 'require_human' | 'deny';

export interface Judgement {
  permission: RequestedPermission;
  verdict: Verdict;
  /** The pattern that decided it, for the audit trail. */
  rule: string;
  reason: string;
}

export interface Decision {
  /** Exactly what will be granted. Always a subset of what was requested. */
  granted: RequestedPermission[];
  judgements: Judgement[];
  /** The tier the decision was made under, after any lowering. */
  tier: TrustTier | null;
}

export const tierPolicySchema = z
  .object({
    /** `kind:resource` globs. `**` spans path segments, `*` does not. */
    allow: z.array(z.string()).default([]),
    /** Matched permissions are not denied, but a human must approve them. */
    requireHuman: z.array(z.string()).default([]),
    /** Matched permissions are denied regardless of any other rule. */
    deny: z.array(z.string()).default([]),
  })
  .prefault({});

export type TierPolicy = z.infer<typeof tierPolicySchema>;

/**
 * Built explicitly rather than via `.default({})`.
 *
 * Zod v4 short-circuits an object-level default and does not run the inner
 * field defaults, so `tierPolicySchema.parse({})` yields `{}` — and `judge` then
 * reads `.find` off undefined. An explicit empty tier removes the dependency on
 * that behaviour, which is the kind of thing a Zod upgrade would otherwise move
 * under us.
 */
function emptyTier(): TierPolicy {
  return { allow: [], requireHuman: [], deny: [] };
}

export const policySchema = z
  .object({
    /** The tier assumed when a request declares none. Never something generous. */
    defaultTier: z.enum(TRUST_TIERS).default('third_party'),
    // partialRecord, not record: an operator writes two of the four tiers. Plain
    // z.record with an enum key types as Record<TrustTier, V>, which would claim
    // every tier must be present and reject a perfectly valid partial policy.
    tiers: z.partialRecord(z.enum(TRUST_TIERS), tierPolicySchema).default({}),
  })
  .prefault({});

export type Policy = z.infer<typeof policySchema>;

/**
 * Nothing is granted until the operator writes a policy.
 *
 * An absent policy is the dangerous case, so the default is an empty tier table:
 * every request lands in "no rule matched" and is denied.
 */
export function denyAll(): Policy {
  return { defaultTier: 'third_party', tiers: {} };
}

function parseWithBom(raw: string): unknown {
  // A BOM is not corruption. It happens when a policy file is edited on Windows,
  // and refusing to load it would push an operator toward deleting their rules.
  return JSON.parse(raw.replace(/^﻿/, ''));
}

export function policyFromJson(raw: string): Policy {
  return policySchema.parse(parseWithBom(raw));
}

function singleSegment(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;

  let cursor = 0;
  const first = parts[0]!;
  if (first !== '') {
    if (!value.startsWith(first)) return false;
    cursor = first.length;
  }

  const last = parts[parts.length - 1]!;
  const tail = last === '' ? undefined : last;
  const middles = parts.slice(1, Math.max(1, parts.length - 1));

  for (const part of middles) {
    if (part === '') continue;
    const at = value.slice(cursor).indexOf(part);
    if (at < 0) return false;
    cursor += at + part.length;
  }

  if (tail === undefined) return true;
  const rest = value.slice(cursor);
  return rest.endsWith(tail) && rest.length >= tail.length;
}

function glob(pattern: string, value: string): boolean {
  // `*` is one segment and never spans `/`. Without this, `fs.read:*` would match
  // `fs.read:data/anything`, handing a broad grant to a pattern that reads narrow.
  if (!pattern.includes('**')) {
    if (!pattern.includes('/') && value.includes('/')) return false;
    if (pattern === '*') return true;
    return singleSegment(pattern, value);
  }

  const split = pattern.indexOf('**');
  const rawHead = pattern.slice(0, split);
  const rawTail = pattern.slice(split + 2);
  const head = rawHead.replace(/\/+$/, '');
  const tail = rawTail.replace(/^\/+/, '');

  if (!value.startsWith(head)) return false;
  if (tail === '') return true;

  const rest = value.slice(head.length);
  const segments = rest.split('/');
  const parts = tail.split('/');

  if (parts.length === 1) {
    return segments.some((s) => singleSegment(parts[0]!, s));
  }
  for (let i = 0; i + parts.length <= segments.length; i++) {
    const window = segments.slice(i, i + parts.length);
    if (window.every((s, idx) => singleSegment(parts[idx]!, s))) return true;
  }
  return false;
}

/**
 * `*` matches inside one path segment, `**` spans segments.
 *
 * A rule for a resource-less permission is written `proc.spawn`, while the value
 * it is matched against is `proc.spawn:`. Both sides are normalised to kind plus
 * resource so the missing colon is not a silent non-match.
 */
export function matches(pattern: string, value: string): boolean {
  if (pattern === value) return true;

  const pColon = pattern.indexOf(':');
  const kind = pColon < 0 ? pattern : pattern.slice(0, pColon);
  const resource = pColon < 0 ? '' : pattern.slice(pColon + 1);

  const vColon = value.indexOf(':');
  const valueKind = vColon < 0 ? value : value.slice(0, vColon);
  const valueResource = vColon < 0 ? '' : value.slice(vColon + 1);

  if (kind !== valueKind) return false;
  return glob(resource, valueResource);
}

/** Most-restrictive-wins, and `deny` beats everything. */
function judge(permission: RequestedPermission, tier: TierPolicy): Judgement {
  const pattern = `${permission.kind}:${permission.resource ?? ''}`;

  for (const list of [
    [tier.deny, 'deny', 'denied outright by policy'],
    [tier.requireHuman, 'require_human', 'allowed only after a human approves it'],
    [tier.allow, 'allow', "within the tier's allowance"],
  ] as const) {
    const [rules, verdict, reason] = list;
    const rule = rules.find((p) => matches(p, pattern));
    if (rule !== undefined) {
      return { permission, verdict, rule, reason };
    }
  }

  return {
    permission,
    verdict: 'deny',
    rule: 'no rule',
    reason: 'no rule in this tier covers it, and unmatched means denied',
  };
}

/**
 * The tier a capability runs under: the *less* trusted of what the registry
 * concluded and what the author claimed.
 *
 * An author declaring `local` must not keep `local` after the registry lowered
 * the capability to `untrusted`.
 */
export function tierFor(
  claimed: TrustTier | undefined,
  effective: TrustTier,
): TrustTier {
  return claimed === undefined ? effective : lessTrusted(effective, tierFromClaim(claimed));
}

/**
 * Decide what a requester may actually have.
 *
 * `effectiveTier` must come from the already-lowered registry value, so a
 * manifest declaring `trust: builtin` cannot promote itself here.
 */
export function decide(
  permissions: RequestedPermission[],
  effectiveTier: TrustTier,
  policy: Policy,
): Decision {
  const tier = policy.tiers[effectiveTier] ?? emptyTier();

  const judgements = permissions.map((p) => judge(p, tier));

  // Only `allow` is granted. `require_human` is deliberately absent: a gated
  // permission that appeared in the grant set would already be effective, which
  // is the exact failure the gate exists to prevent.
  const granted = judgements
    .filter((j) => j.verdict === 'allow')
    .map((j) => j.permission);

  return { granted, judgements, tier: effectiveTier };
}

/**
 * Decide from a declared trust claim, using the policy's own default tier when
 * none is declared.
 *
 * The policy decides that default, not the code: an operator who wants "undeclared
 * means untrusted" must be able to say so without a rebuild.
 */
export function decideFromClaim(
  permissions: RequestedPermission[],
  claimed: TrustTier | undefined,
  policy: Policy,
): Decision {
  if (claimed === undefined) return decide(permissions, policy.defaultTier, policy);
  return decide(permissions, tierFor(claimed, tierFromClaim(claimed)), policy);
}

export function isEmpty(d: Decision): boolean {
  return d.granted.length === 0;
}

export function verdictFor(
  d: Decision,
  kind: PermissionKind,
  resource: string,
): Verdict | undefined {
  return d.judgements.find(
    (j) => j.permission.kind === kind && (j.permission.resource ?? '') === resource,
  )?.verdict;
}

export function needsHuman(d: Decision): boolean {
  return d.judgements.some((j) => j.verdict === 'require_human');
}

/** Gated permissions, which are neither granted nor denied. */
export function pending(d: Decision): Judgement[] {
  return d.judgements.filter((j) => j.verdict === 'require_human');
}

/**
 * The decision explains itself in the same `kind:resource` form the rules are
 * written in, so a reader can grep one for the other.
 */
export function explain(d: Decision): string {
  if (d.judgements.length === 0) {
    return 'nothing was requested, so nothing is granted';
  }
  const tier = d.tier ?? 'none';
  const lines = d.judgements.map(
    (j) =>
      `${j.permission.kind}:${j.permission.resource ?? '*'} ${j.verdict} (${j.rule} — ${j.reason})`,
  );
  lines.push(`tier ${tier}`);
  return lines.join('\n');
}