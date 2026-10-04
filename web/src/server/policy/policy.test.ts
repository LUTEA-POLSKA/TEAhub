import { describe, expect, it } from 'vitest';
import {
  type Decision,
  type Policy,
  type RequestedPermission,
  type TrustTier,
  decide,
  decideFromClaim,
  denyAll,
  explain,
  isEmpty,
  matches,
  needsHuman,
  policyFromJson,
  tierFor,
  verdictFor,
} from './policy';

/**
 * A direct port of the 18 tests in src/policy.rs.
 *
 * They are the contract: the Rust implementation is frozen but still correct,
 * and these assertions are what a change to the TypeScript engine has to keep
 * passing. Test names are kept verbatim so a failure points at the original.
 */

const fs = (resource: string): RequestedPermission => ({ kind: 'fs.read', resource });
const write = (resource: string): RequestedPermission => ({ kind: 'fs.write', resource });
const spawn: RequestedPermission = { kind: 'proc.spawn' };

function policyWith(tier: TrustTier, json: Record<string, string[]>): Policy {
  return policyFromJson(
    JSON.stringify({ defaultTier: 'third_party', tiers: { [tier]: json } }),
  );
}

describe('policy', () => {
  it('an absent policy denies everything', () => {
    const d = decideFromClaim([fs('data/x')], undefined, denyAll());
    expect(isEmpty(d)).toBe(true);
    expect(verdictFor(d, 'fs.read', 'data/x')).toBe('deny');
  });

  it('a grant is a subset of what was requested', () => {
    const policy = policyWith('third_party', { allow: ['fs.read:**', 'fs.write:**'] });
    const d = decideFromClaim([fs('data/x')], undefined, policy);
    expect(d.granted).toHaveLength(1);
    expect(d.granted[0]!.kind).toBe('fs.read');
  });

  it('policy cannot add a permission the requester never asked for', () => {
    const policy = policyWith('third_party', {
      allow: ['fs.read:**', 'fs.write:**', 'secret.use:**'],
    });
    const d = decideFromClaim([fs('data/x')], undefined, policy);
    expect(d.granted.some((g) => g.kind === 'secret.use')).toBe(false);
  });

  it('a permission matched by human_gate is not granted outright', () => {
    const policy = policyWith('third_party', { requireHuman: ['fs.write:**'] });
    const d = decideFromClaim([write('data/x')], undefined, policy);
    expect(isEmpty(d)).toBe(true);
    expect(needsHuman(d)).toBe(true);
    expect(verdictFor(d, 'fs.write', 'data/x')).toBe('require_human');
  });

  it('deny beats allow when a rule says both', () => {
    const policy = policyWith('third_party', { allow: ['fs.write:**'], deny: ['fs.write:**'] });
    const d = decideFromClaim([write('data/x')], undefined, policy);
    expect(verdictFor(d, 'fs.write', 'data/x')).toBe('deny');
  });

  it('human_gate beats allow when a rule says both', () => {
    const policy = policyWith('third_party', {
      allow: ['fs.write:**'],
      requireHuman: ['fs.write:**'],
    });
    const d = decideFromClaim([write('data/x')], undefined, policy);
    expect(verdictFor(d, 'fs.write', 'data/x')).toBe('require_human');
  });

  it('tiers separate what a local capability may from an untrusted one', () => {
    const policy = policyFromJson(
      JSON.stringify({
        defaultTier: 'third_party',
        tiers: {
          local: { allow: ['fs.write:data/**'] },
          untrusted: { allow: ['fs.read:modules/**'] },
        },
      }),
    );

    const permissive = decideFromClaim([write('data/x')], 'local', policy);
    expect(permissive.granted).toHaveLength(1);

    const restricted = decideFromClaim([write('data/x')], 'untrusted', policy);
    expect(isEmpty(restricted)).toBe(true);
    expect(verdictFor(restricted, 'fs.write', 'data/x')).toBe('deny');
  });

  it('an author cannot promote itself past the registry tier', () => {
    const policy = policyFromJson(
      JSON.stringify({
        defaultTier: 'untrusted',
        tiers: { builtin: { allow: ['fs.write:**'] }, untrusted: { allow: [] } },
      }),
    );

    // The registry already lowered it from the claimed `builtin` to third_party.
    const effective: TrustTier = 'third_party';
    const d = decide(
      [write('data/x')],
      tierFor('builtin', effective),
      policy,
    );
    expect(isEmpty(d)).toBe(true);
  });

  it('a requester with no trust claim gets the policy default tier', () => {
    const policy = policyFromJson(
      JSON.stringify({
        defaultTier: 'untrusted',
        tiers: { untrusted: { allow: ['fs.read:data/**'] } },
      }),
    );
    const d = decideFromClaim([fs('data/x')], undefined, policy);
    expect(d.tier).toBe('untrusted');
    expect(d.granted).toHaveLength(1);
  });

  it('the lower of two tiers always wins whichever side declares it', () => {
    expect(tierFor('local', 'untrusted')).toBe('untrusted');
    expect(tierFor('builtin', 'third_party')).toBe('third_party');
    expect(tierFor('builtin', 'builtin')).toBe('builtin');
    expect(tierFor(undefined, 'untrusted')).toBe('untrusted');
  });

  it('an unknown tier denies rather than defaulting to permissive', () => {
    const policy = policyFromJson(
      JSON.stringify({ defaultTier: 'builtin', tiers: {} }),
    );
    const d = decide([fs('data/x')], 'untrusted', policy);
    expect(isEmpty(d)).toBe(true);
    expect(verdictFor(d, 'fs.read', 'data/x')).toBe('deny');
  });

  it('a capability requesting nothing gets nothing', () => {
    const policy = policyWith('third_party', { allow: ['fs.read:**'] });
    const d = decideFromClaim([], 'third_party', policy);
    expect(isEmpty(d)).toBe(true);
    expect(needsHuman(d)).toBe(false);
    expect(explain(d)).toBe('nothing was requested, so nothing is granted');
  });

  it('proc_spawn matches a pattern without a resource', () => {
    const policy = policyWith('third_party', { requireHuman: ['proc.spawn'] });
    const d = decideFromClaim([spawn], undefined, policy);
    expect(verdictFor(d, 'proc.spawn', '')).toBe('require_human');
  });

  it('glob_double_star spans path segments and star does not', () => {
    expect(matches('fs.read:data/**', 'fs.read:data/a/b/c')).toBe(true);
    expect(matches('fs.read:data/**', 'fs.read:data/x')).toBe(true);
    expect(matches('fs.read:*', 'fs.read:data')).toBe(true);
    expect(matches('fs.read:*', 'fs.read:data/a')).toBe(false);
    expect(matches('fs.read:**', 'fs.read:anything/at/all')).toBe(true);
    expect(matches('fs.read:data/**', 'fs.write:data/a')).toBe(false);
    expect(matches('fs.read:data/**', 'fs.read:other/a')).toBe(false);
  });

  it('a star inside a segment matches within that segment only', () => {
    // Asserted through `matches` so the kind:resource normalisation is exercised
    // on the way in, which is how the policy actually reaches the glob.
    expect(matches('fs.read:*.log', 'fs.read:teahub.log')).toBe(true);
    expect(matches('fs.read:*.log', 'fs.read:dir/teahub.log')).toBe(false);
    expect(matches('fs.read:a*c', 'fs.read:abc')).toBe(true);
    expect(matches('fs.read:a*c', 'fs.read:abbbbc')).toBe(true);
    expect(matches('fs.read:a*c', 'fs.read:abbbd')).toBe(false);
  });

  it('the decision explains itself', () => {
    const policy = policyWith('third_party', {
      allow: ['fs.read:data/**'],
      deny: ['fs.write:**'],
    });
    const d = decideFromClaim([fs('data/x'), write('data/x')], undefined, policy);
    const text = explain(d);
    expect(text).toContain('fs.read:data/x allow');
    expect(text).toContain('fs.write:data/x deny');
    expect(text).toContain('tier third_party');
  });

  it('a byte order mark in the policy does not break it', () => {
    const policy = policyFromJson(
      `﻿${JSON.stringify({ defaultTier: 'local', tiers: {} })}`,
    );
    expect(policy.defaultTier).toBe('local');
  });

  it('trust tiers are the strings the rules are written in', () => {
    for (const tier of ['builtin', 'local', 'third_party', 'untrusted'] as const) {
      const policy = policyFromJson(JSON.stringify({ defaultTier: tier, tiers: {} }));
      expect(policy.defaultTier).toBe(tier);
    }
  });

  it('rejects a policy that names an unknown tier', () => {
    expect(() =>
      policyFromJson(JSON.stringify({ defaultTier: 'semi_trusted', tiers: {} })),
    ).toThrow();
  });
});

describe('policy: one extra case the Rust original does not cover', () => {
  it('a require_human rule and a deny rule on the same permission resolve to deny', () => {
    // Not covered upstream. Both statements are restrictive, and the question is
    // which one the audit log should name as the reason.
    const policy = policyWith('third_party', {
      requireHuman: ['fs.write:data/**'],
      deny: ['fs.write:data/secrets/**'],
    });
    const d: Decision = decideFromClaim(
      [{ kind: 'fs.write', resource: 'data/secrets/key' }],
      undefined,
      policy,
    );
    expect(verdictFor(d, 'fs.write', 'data/secrets/key')).toBe('deny');
    expect(needsHuman(d)).toBe(false);
  });
});