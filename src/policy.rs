//! The step from *requested* to *granted*.
//!
//! A manifest can ask for anything. This is the only place that answers, and
//! three properties are load-bearing:
//!
//! * **Intersection, never union.** A grant is a subset of what was requested.
//!   A policy cannot add a permission the author did not ask for, and a manifest
//!   cannot widen one the policy did not allow.
//! * **Fail closed.** Anything that cannot be evaluated is denied. An unparsed
//!   rule, an unknown tier, a malformed pattern â€” all deny, because a policy that
//!   quietly allows what it does not understand is worse than no policy.
//! * **No model in the loop.** This is a pure function over the manifest and the
//!   policy. An LLM may *request* an action; it may never *authorise* one.
//!
//! The policy lives in an operator-owned file, separate from every manifest,
//! because a capability that can edit its own permissions is not a permission
//! system.

use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::capability::manifest::PermissionKind;
use crate::capability::manifest::{ClaimedTrust, Manifest, RequestedPermission};

pub const POLICY_FILE: &str = "policy.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustTier {
    Builtin,
    Local,
    ThirdParty,
    Untrusted,
}

impl TrustTier {
    pub fn as_str(self) -> &'static str {
        match self {
            TrustTier::Builtin => "builtin",
            TrustTier::Local => "local",
            TrustTier::ThirdParty => "third_party",
            TrustTier::Untrusted => "untrusted",
        }
    }

    /// Tiers are ordered most to least trusted, matching `ClaimedTrust`.
    pub fn from_claimed(claimed: Option<ClaimedTrust>) -> TrustTier {
        match claimed {
            Some(ClaimedTrust::Builtin) => TrustTier::Builtin,
            Some(ClaimedTrust::Local) => TrustTier::Local,
            Some(ClaimedTrust::ThirdParty) => TrustTier::ThirdParty,
            Some(ClaimedTrust::Untrusted) => TrustTier::Untrusted,
            None => TrustTier::ThirdParty,
        }
    }
}

impl fmt::Display for TrustTier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Allow,
    RequireHuman,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Judgement {
    pub permission: RequestedPermission,
    pub verdict: Verdict,
    pub rule: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    /// Exactly what will be granted. Always a subset of what was requested.
    pub granted: Vec<RequestedPermission>,
    pub judgements: Vec<Judgement>,
    /// The tier the decision was made under, after any lowering.
    pub tier: Option<TrustTier>,
}

impl Decision {
    pub fn is_empty(&self) -> bool {
        self.granted.is_empty()
    }

    pub fn verdict_for(&self, kind: PermissionKind, resource: &str) -> Option<Verdict> {
        self.judgements
            .iter()
            .find(|j| {
                j.permission.kind == kind
                    && j.permission.resource.as_deref().unwrap_or("") == resource
            })
            .map(|j| j.verdict)
    }

    pub fn needs_human(&self) -> bool {
        self.judgements.iter().any(|j| j.verdict == Verdict::RequireHuman)
    }

    /// Gated permissions, which are neither granted nor denied. What a human
    /// has to be asked about.
    pub fn pending(&self) -> Vec<&Judgement> {
        self.judgements
            .iter()
            .filter(|j| j.verdict == Verdict::RequireHuman)
            .collect()
    }

    pub fn explain(&self) -> String {
        if self.judgements.is_empty() {
            return "nothing was requested, so nothing is granted".into();
        }
        let tier = self
            .tier
            .map(|t| t.to_string())
            .unwrap_or_else(|| "none".into());
        self.judgements
            .iter()
.map(|j| {
                // Printed in the same `kind:resource` form the rules are written
                // in, so a reader can grep one for the other.
                format!(
                    "{}:{} {:?} ({} — {})",
                    j.permission.kind.as_str(),
                    j.permission.resource.as_deref().unwrap_or("*"),
                    j.verdict,
                    j.rule,
                    j.reason
                )
            })
            .chain(std::iter::once(format!("tier {tier}")))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TierPolicy {
    /// `kind:resource` globs. `**` spans path segments, `*` does not.
    pub allow: Vec<String>,
    /// Matched permissions are not denied, but a human must approve them.
    pub require_human: Vec<String>,
    /// Matched permissions are denied regardless of any other rule.
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    /// The tier assumed when a manifest declares none. `third_party`, never
    /// something more generous.
    pub default_tier: TrustTier,
    pub tiers: BTreeMap<TrustTier, TierPolicy>,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            default_tier: TrustTier::ThirdParty,
            tiers: BTreeMap::new(),
        }
    }
}

/// Nothing is granted until the operator writes a policy.
///
/// An absent policy is the dangerous case, so the default is a tier table with
/// no entries: every request lands in "no rule matched" and is denied.
impl Policy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    pub fn load(root: &Path) -> Result<Self, PolicyError> {
        let path = root.join(POLICY_FILE);
        let raw = std::fs::read_to_string(&path).map_err(|e| PolicyError::Read {
            path: path.display().to_string(),
            detail: e.to_string(),
        })?;
        crate::parse_json(&raw).map_err(|e| PolicyError::Parse {
            path: path.display().to_string(),
            detail: e.to_string(),
        })
    }

    pub fn from_json(raw: &str) -> Result<Self, PolicyError> {
        crate::parse_json(raw).map_err(|e| PolicyError::Parse {
            path: POLICY_FILE.into(),
            detail: e.to_string(),
        })
    }

    pub fn tier_policy(&self, tier: TrustTier) -> Option<&TierPolicy> {
        self.tiers.get(&tier)
    }
}

/// `detail` rather than `source`: thiserror treats a field named `source` as the
/// error source and then requires it to implement `Error`, which a string does
/// not.
#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("cannot read {path}: {detail}")]
    Read { path: String, detail: String },
    #[error("{path} is not valid policy JSON: {detail}")]
    Parse { path: String, detail: String },
}

/// Most-restrictive-wins, and `deny` beats everything.
///
/// Order matters: a permission that appears in both `allow` and `require_human`
/// is gated, not granted, because the more restrictive of two statements about
/// the same thing is the one that should hold.
fn judge(permission: &RequestedPermission, tier: &TierPolicy) -> Judgement {
    let pattern = format!(
        "{}:{}",
        permission.kind.as_str(),
        permission.resource.as_deref().unwrap_or("")
    );

    if let Some(rule) = tier.deny.iter().find(|p| matches(p, &pattern)) {
        return Judgement {
            permission: permission.clone(),
            verdict: Verdict::Deny,
            rule: rule.clone(),
            reason: "denied outright by policy".into(),
        };
    }
    if let Some(rule) = tier
        .require_human
        .iter()
        .find(|p| matches(p, &pattern))
    {
        return Judgement {
            permission: permission.clone(),
            verdict: Verdict::RequireHuman,
            rule: rule.clone(),
            reason: "allowed only after a human approves it".into(),
        };
    }
    if let Some(rule) = tier.allow.iter().find(|p| matches(p, &pattern)) {
        return Judgement {
            permission: permission.clone(),
            verdict: Verdict::Allow,
            rule: rule.clone(),
            reason: "within the tier's allowance".into(),
        };
    }

    Judgement {
        permission: permission.clone(),
        verdict: Verdict::Deny,
        rule: "no rule".into(),
        reason: "no rule in this tier covers it, and unmatched means denied".into(),
    }
}

/// `*` matches inside one path segment, `**` spans segments.
///
/// A trailing `**` matches any suffix, which is how `data/**` covers a whole
/// subtree without enumerating it.
fn matches(pattern: &str, value: &str) -> bool {
    if pattern == value {
        return true;
    }
    // A rule for a resource-less permission is written `proc.spawn`, while the
    // value it is matched against is `proc.spawn:`. Both sides are normalised to
    // kind plus resource so the missing colon is not a silent non-match.
    let (kind, resource) = match pattern.split_once(':') {
        Some((k, r)) => (k, r),
        None => (pattern, ""),
    };
    let (value_kind, value_resource) = match value.split_once(':') {
        Some((k, r)) => (k, r),
        None => (value, ""),
    };
    if kind != value_kind {
        return false;
    }
    glob(resource, value_resource)
}

fn glob(pattern: &str, value: &str) -> bool {
    // `*` is one segment and never spans `/`. Without this, `fs.read:*` would
    // match `fs.read:data/anything`, which hands a broad grant to a pattern that
    // reads like a narrow one.
    if !pattern.contains("**") {
        if !pattern.contains('/') && value.contains('/') {
            return false;
        }
        if pattern == "*" {
            return true;
        }
        return single_segment(pattern, value);
    }

    let (head, tail) = pattern.split_once("**").expect("checked above");
    let (head, tail) = (head.trim_end_matches('/'), tail.trim_start_matches('/'));

    let Some(rest) = value.strip_prefix(head) else {
        return false;
    };
    if tail.is_empty() {
        return true;
    }

    let segments: Vec<&str> = rest.split('/').collect();
    let parts: Vec<&str> = tail.split('/').collect();
    if parts.len() == 1 {
        return segments.iter().any(|s| single_segment(parts[0], s));
    }
    segments
        .windows(parts.len())
        .any(|w| w.iter().zip(&parts).all(|(s, p)| single_segment(p, s)))
}

fn single_segment(pattern: &str, value: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == value;
    }

    let mut cursor = 0usize;
    if let Some(first) = parts.first().filter(|p| !p.is_empty()) {
        if !value.starts_with(first) {
            return false;
        }
        cursor = first.len();
    }
    let last = parts.last().filter(|p| !p.is_empty()).copied();
    for part in &parts[1..parts.len().saturating_sub(1)] {
        if part.is_empty() {
            continue;
        }
        match value[cursor..].find(part) {
            Some(at) => cursor += at + part.len(),
            None => return false,
        }
    }
    match last {
        Some(suffix) => value[cursor..].ends_with(suffix) && value[cursor..].len() >= suffix.len(),
        None => true,
    }
}

/// Decide what a manifest may actually have.
///
/// The tier can only ever come from the registry's already-lowered value, so a
/// manifest that declares `trust: builtin` cannot promote itself here.
pub fn decide(manifest: &Manifest, effective_tier: TrustTier, policy: &Policy) -> Decision {
    let tier = policy
        .tier_policy(effective_tier)
        .cloned()
        .unwrap_or_default();

    let judgements: Vec<Judgement> = manifest
        .permissions
        .iter()
        .map(|p| judge(p, &tier))
        .collect();

    // Only `Allow` is granted. `RequireHuman` is deliberately absent: a gated
    // permission that appeared in the grant set would already be effective,
    // which is the exact failure the gate exists to prevent.
    let granted = judgements
        .iter()
        .filter(|j| j.verdict == Verdict::Allow)
        .map(|j| j.permission.clone())
        .collect();

    Decision {
        granted,
        judgements,
        tier: Some(effective_tier),
    }
}

/// The tier a capability runs under: the *less* trusted of what the registry
/// concluded and what the author claimed.
///
/// `TrustTier` orders most-trusted first, so taking the maximum is the
/// conservative choice. Taking the minimum would hand back the more generous of
/// the two, which is precisely the escalation this exists to prevent: an author
/// declaring `local` would keep `local` even after the registry lowered the
/// capability to `untrusted`.
pub fn tier_for(manifest: &Manifest, effective: TrustTier) -> TrustTier {
    match manifest.trust {
        Some(claimed) => std::cmp::max(effective, TrustTier::from_claimed(Some(claimed))),
        None => effective,
    }
}

/// Decide from the manifest alone, using the policy's own default tier when the
/// manifest declares none.
///
/// The policy decides that default, not the code: an operator who wants
/// "undeclared means untrusted" must be able to say so without a rebuild.
pub fn decide_from_claim(manifest: &Manifest, policy: &Policy) -> Decision {
    let tier = TrustTier::from_claimed(manifest.trust);
    let effective = if manifest.trust.is_none() {
        policy.default_tier
    } else {
        tier_for(manifest, tier)
    };
    decide(manifest, effective, policy)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(perms: &str, trust: Option<&str>) -> Manifest {
        manifest_from("local", perms, trust)
    }

    fn manifest_from(source: &str, perms: &str, trust: Option<&str>) -> Manifest {
        let trust_line = match trust {
            Some(t) => format!(r#","trust":"{t}""#),
            None => String::new(),
        };
        let permissions = if perms.trim().is_empty() {
            "[]".to_string()
        } else {
            format!("[{perms}]")
        };
        serde_json::from_str(&format!(
            r#"{{"api_version":"teahub.dev/v0.1","id":"acme.x","name":"X","version":"0.1.0",
                "kind":"tool","description":"d","runtime":{{"kind":"native","entry":"x.exe"}},
                "provenance":{{"source":"{source}"}},"permissions":{permissions}{trust_line}}}"#
        ))
        .expect("manifest")
    }

    fn fs(resource: &str) -> String {
        format!(r#"{{"kind":"fs.read","resource":"{resource}"}}"#)
    }

    fn policy_with(tier: &str, json: &str) -> Policy {
        Policy::from_json(&format!(
            r#"{{"default_tier":"third_party","tiers":{{"{tier}":{json}}}}}"#
        ))
        .expect("policy")
    }

    #[test]
    fn an_absent_policy_denies_everything() {
        let policy = Policy::deny_all();
        let d = decide_from_claim(&manifest(&fs("data/x"), None), &policy);
        assert!(d.is_empty(), "no rule must mean denied");
        assert_eq!(d.verdict_for(PermissionKind::FsRead, "data/x"), Some(Verdict::Deny));
    }

    #[test]
    fn a_grant_is_a_subset_of_what_was_requested() {
        let policy = policy_with("third_party", r#"{"allow":["fs.read:**","fs.write:**"]}"#);
        let d = decide_from_claim(&manifest(&fs("data/x"), None), &policy);
        assert_eq!(d.granted.len(), 1);
        assert_eq!(d.granted[0].kind, PermissionKind::FsRead);
    }

    #[test]
    fn policy_cannot_add_a_permission_the_manifest_never_asked_for() {
        let policy = policy_with("third_party", r#"{"allow":["fs.read:**","fs.write:**","secret.use:**"]}"#);
        let d = decide_from_claim(&manifest(&fs("data/x"), None), &policy);
        assert!(
            !d.granted.iter().any(|g| g.kind == PermissionKind::SecretUse),
            "an allowance is not a grant"
        );
    }

    #[test]
    fn a_permission_matched_by_human_gate_is_not_granted_outright() {
        let policy = policy_with("third_party", r#"{"require_human":["fs.write:**"]}"#);
        let d = decide_from_claim(
            &manifest(r#"{"kind":"fs.write","resource":"data/x"}"#, None),
            &policy,
        );
        assert!(d.is_empty(), "gated is not granted");
        assert!(d.needs_human());
        assert_eq!(
            d.verdict_for(PermissionKind::FsWrite, "data/x"),
            Some(Verdict::RequireHuman)
        );
    }

    #[test]
    fn deny_beats_allow_when_a_rule_says_both() {
        let policy = policy_with("third_party", r#"{"allow":["fs.write:**"],"deny":["fs.write:**"]}"#);
        let d = decide_from_claim(
            &manifest(r#"{"kind":"fs.write","resource":"data/x"}"#, None),
            &policy,
        );
        assert_eq!(
            d.verdict_for(PermissionKind::FsWrite, "data/x"),
            Some(Verdict::Deny),
            "the more restrictive statement must win"
        );
    }

    #[test]
    fn human_gate_beats_allow_when_a_rule_says_both() {
        let policy = policy_with("third_party", r#"{"allow":["fs.write:**"],"require_human":["fs.write:**"]}"#);
        let d = decide_from_claim(
            &manifest(r#"{"kind":"fs.write","resource":"data/x"}"#, None),
            &policy,
        );
        assert_eq!(
            d.verdict_for(PermissionKind::FsWrite, "data/x"),
            Some(Verdict::RequireHuman)
        );
    }

    #[test]
    fn tiers_separate_what_a_local_capability_may_from_an_untrusted_one() {
        let policy = Policy::from_json(
            r#"{"default_tier":"third_party","tiers":{
                "local":{"allow":["fs.write:data/**"]},
                "untrusted":{"allow":["fs.read:modules/**"]}}}"#,
        )
        .expect("policy");

        let permissive = decide_from_claim(
            &manifest(r#"{"kind":"fs.write","resource":"data/x"}"#, Some("local")),
            &policy,
        );
        assert_eq!(permissive.granted.len(), 1, "local may write under data");

        let restricted = decide_from_claim(
            &manifest(r#"{"kind":"fs.write","resource":"data/x"}"#, Some("untrusted")),
            &policy,
        );
        assert!(restricted.is_empty(), "untrusted may not");
        assert_eq!(restricted.verdict_for(PermissionKind::FsWrite, "data/x"), Some(Verdict::Deny));
    }

    #[test]
    fn an_author_cannot_promote_itself_past_the_registrys_tier() {
        let policy = Policy::from_json(
            r#"{"default_tier":"untrusted","tiers":{
                "builtin":{"allow":["fs.write:**"]},
                "untrusted":{"allow":[]}}}"#,
        )
        .expect("policy");

        let m = manifest_from(
            "registry:acme",
            r#"{"kind":"fs.write","resource":"data/x"}"#,
            Some("builtin"),
        );
        let effective = crate::registry::effective_trust(&m);
        let effective_tier = TrustTier::from_claimed(Some(effective));
        assert_eq!(effective_tier, TrustTier::ThirdParty, "registry already lowered it");

        let d = decide(&m, tier_for(&m, effective_tier), &policy);
        assert!(d.is_empty(), "a self-declared builtin grant must not survive");
    }

    #[test]
    fn a_manifest_with_no_trust_gets_the_policy_default_tier() {
        let policy = Policy::from_json(
            r#"{"default_tier":"untrusted","tiers":{"untrusted":{"allow":["fs.read:data/**"]}}}"#,
        )
        .expect("policy");
        let d = decide_from_claim(&manifest(&fs("data/x"), None), &policy);
        assert_eq!(d.tier, Some(TrustTier::Untrusted));
        assert_eq!(d.granted.len(), 1, "the default tier still applies its rules");
    }

    #[test]
    fn the_lower_of_two_tiers_always_wins_whichever_side_declares_it() {
        let local_claiming = manifest("", Some("local"));
        let builtin_claiming = manifest("", Some("builtin"));

        assert_eq!(
            tier_for(&local_claiming, TrustTier::Untrusted),
            TrustTier::Untrusted,
            "an author claiming local cannot lift a registry verdict of untrusted"
        );
        assert_eq!(
            tier_for(&builtin_claiming, TrustTier::ThirdParty),
            TrustTier::ThirdParty,
            "and neither can one claiming builtin"
        );
        assert_eq!(
            tier_for(&builtin_claiming, TrustTier::Builtin),
            TrustTier::Builtin,
            "agreement is the only case that keeps the higher tier"
        );
        assert_eq!(
            tier_for(&local_claiming, TrustTier::Untrusted),
            TrustTier::Untrusted,
            "a local author under an untrusted verdict is untrusted"
        );
    }

    #[test]
    fn an_unknown_tier_denies_rather_than_defaulting_to_permissive() {
        let policy = Policy::from_json(r#"{"default_tier":"builtin","tiers":{}}"#).expect("policy");
        let d = decide(&manifest(&fs("data/x"), None), TrustTier::Untrusted, &policy);
        assert!(d.is_empty());
        assert_eq!(d.verdict_for(PermissionKind::FsRead, "data/x"), Some(Verdict::Deny));
    }

    #[test]
    fn a_capability_requesting_nothing_gets_nothing() {
        let policy = policy_with("third_party", r#"{"allow":["fs.read:**"]}"#);
        let d = decide_from_claim(&manifest("", Some("third_party")), &policy);
        assert!(d.is_empty());
        assert!(!d.needs_human());
        assert_eq!(d.explain(), "nothing was requested, so nothing is granted");
    }

    #[test]
    fn proc_spawn_matches_a_pattern_without_a_resource() {
        let policy = policy_with("third_party", r#"{"require_human":["proc.spawn"]}"#);
        let d = decide_from_claim(
            &manifest(r#"{"kind":"proc.spawn"}"#, None),
            &policy,
        );
        assert_eq!(
            d.verdict_for(PermissionKind::ProcSpawn, ""),
            Some(Verdict::RequireHuman)
        );
    }

    #[test]
    fn glob_double_star_spans_path_segments_and_star_does_not() {
        assert!(matches("fs.read:data/**", "fs.read:data/a/b/c"));
        assert!(matches("fs.read:data/**", "fs.read:data/x"));
        assert!(matches("fs.read:*", "fs.read:data"));
        assert!(!matches("fs.read:*", "fs.read:data/a"));
        assert!(matches("fs.read:**", "fs.read:anything/at/all"));
        assert!(!matches("fs.read:data/**", "fs.write:data/a"));
        assert!(!matches("fs.read:data/**", "fs.read:other/a"));
    }

    #[test]
    fn a_star_inside_a_segment_matches_within_that_segment_only() {
        assert!(glob("*.log", "teahub.log"));
        assert!(!glob("*.log", "dir/teahub.log"));
        assert!(glob("a*c", "abc"));
        assert!(glob("a*c", "abbbbc"));
        assert!(!glob("a*c", "abbbd"));
    }

    #[test]
    fn the_decision_explains_itself() {
        let policy = policy_with("third_party", r#"{"allow":["fs.read:data/**"],"deny":["fs.write:**"]}"#);
        let d = decide_from_claim(
            &manifest(
                &format!(
                    "{},{}",
                    fs("data/x"),
                    r#"{"kind":"fs.write","resource":"data/x"}"#
                ),
                None,
            ),
            &policy,
        );
        let text = d.explain();
        assert!(text.contains("fs.read:data/x Allow"), "{text}");
        assert!(text.contains("fs.write:data/x Deny"), "{text}");
        assert!(text.contains("tier third_party"), "{text}");
    }

    #[test]
    fn a_byte_order_mark_in_the_policy_does_not_break_it() {
        let policy = Policy::from_json("\u{feff}{\"default_tier\":\"local\",\"tiers\":{}}")
            .expect("a BOM is not corruption");
        assert_eq!(policy.default_tier, TrustTier::Local);
    }

    #[test]
    fn trust_tiers_serialise_as_they_print() {
        for tier in [
            TrustTier::Builtin,
            TrustTier::Local,
            TrustTier::ThirdParty,
            TrustTier::Untrusted,
        ] {
            let json = serde_json::to_string(&tier).expect("serialise");
            assert_eq!(json, format!("\"{}\"", tier.as_str()));
            assert_eq!(serde_json::from_str::<TrustTier>(&json).unwrap(), tier);
        }
    }
}