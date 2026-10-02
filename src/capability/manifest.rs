//! Capability manifest v0.1.
//!
//! Every field here is enforced somewhere. A field that is only documentation
//! is a field that will one day be trusted and found empty, so the set is kept
//! to what the registry actually reads.

use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

pub const MANIFEST_FILE: &str = "module.json";

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CapabilityKind {
    Agent,
    Skill,
    Tool,
    Mcp,
    Workflow,
    Connector,
}

impl CapabilityKind {
    pub const ALL: [CapabilityKind; 6] = [
        CapabilityKind::Agent,
        CapabilityKind::Skill,
        CapabilityKind::Tool,
        CapabilityKind::Mcp,
        CapabilityKind::Workflow,
        CapabilityKind::Connector,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CapabilityKind::Agent => "agent",
            CapabilityKind::Skill => "skill",
            CapabilityKind::Tool => "tool",
            CapabilityKind::Mcp => "mcp",
            CapabilityKind::Workflow => "workflow",
            CapabilityKind::Connector => "connector",
        }
    }

    /// A directory name used to group capabilities on disk.
    pub fn dir_name(self) -> &'static str {
        self.as_str()
    }
}

/// The runtime a capability executes on.
///
/// Three variants and no more: adding a fourth is a breaking manifest change on
/// purpose, because each runtime is a different sandbox story.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Runtime {
    Native {
        entry: PathBuf,
    },
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Http {
        url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provides {
    pub capability: String,
    #[serde(default = "one")]
    pub version: u32,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Requirement {
    pub capability: String,
    #[serde(default)]
    pub optional: bool,
}

/// Renamed explicitly rather than via `rename_all`, because the wire form is
/// dotted (`fs.read`) and must match [`PermissionKind::as_str`]. Letting serde
/// derive `fs_read` while `as_str` printed `fs.read` produced manifests that
/// read correctly and would not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PermissionKind {
    #[serde(rename = "fs.read")]
    FsRead,
    #[serde(rename = "fs.write")]
    FsWrite,
    #[serde(rename = "net.egress")]
    NetEgress,
    #[serde(rename = "proc.spawn")]
    ProcSpawn,
    #[serde(rename = "secret.use")]
    SecretUse,
}

impl PermissionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PermissionKind::FsRead => "fs.read",
            PermissionKind::FsWrite => "fs.write",
            PermissionKind::NetEgress => "net.egress",
            PermissionKind::ProcSpawn => "proc.spawn",
            PermissionKind::SecretUse => "secret.use",
        }
    }

    /// Permissions that are meaningless without a resource to act on.
    pub fn requires_resource(self) -> bool {
        matches!(
            self,
            PermissionKind::FsRead | PermissionKind::FsWrite | PermissionKind::NetEgress
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestedPermission {
    pub kind: PermissionKind,
    /// A path for filesystem permissions, a host for network ones, a name for a
    /// secret. Required for everything except `proc.spawn`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

/// Trust as the *author* claims it.
///
/// This is data, never a decision. `Registry::effective_trust` is what policy
/// assigns, and it is allowed to answer lower than this.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimedTrust {
    Builtin,
    Local,
    ThirdParty,
    Untrusted,
}

impl ClaimedTrust {
    pub fn as_str(self) -> &'static str {
        match self {
            ClaimedTrust::Builtin => "builtin",
            ClaimedTrust::Local => "local",
            ClaimedTrust::ThirdParty => "third_party",
            ClaimedTrust::Untrusted => "untrusted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Provenance {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    /// `sha256:<hex>` over the capability payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_memory_mb")]
    pub memory_mb: u64,
    #[serde(default = "default_egress_calls")]
    pub egress_calls_per_run: u32,
}

fn default_timeout_ms() -> u64 {
    60_000
}
fn default_memory_mb() -> u64 {
    512
}
fn default_egress_calls() -> u32 {
    50
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout_ms: default_timeout_ms(),
            memory_mb: default_memory_mb(),
            egress_calls_per_run: default_egress_calls(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// `teahub.dev/v0.1`. The major component is the compatibility contract.
    pub api_version: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: CapabilityKind,
    pub description: String,
    #[serde(default)]
    pub provides: Vec<Provides>,
    #[serde(default)]
    pub requires: Vec<Requirement>,
    pub runtime: Runtime,
    /// Requested, never granted. See [`GrantedPermissions`].
    #[serde(default)]
    pub permissions: Vec<RequestedPermission>,
    #[serde(default)]
    pub limits: Limits,
    pub provenance: Provenance,
    #[serde(default)]
    pub trust: Option<ClaimedTrust>,
}

impl Manifest {
    /// The compatibility contract is the major component of the version after
    /// the `/`, without its `v` prefix.
    ///
    /// `teahub.dev/v0.1` yields 0. Splitting the whole string on `.` would
    /// yield `teahub`, which is the name and not the version; keeping the `v`
    /// would yield `v0`, which is not a number.
    pub fn api_major(&self) -> Result<u64, ManifestError> {
        let version = self.api_version.rsplit('/').next().unwrap_or(&self.api_version);
        let major = version
            .split('.')
            .next()
            .unwrap_or(version)
            .trim_start_matches(['v', 'V']);
        major.parse().map_err(|_| {
            ManifestError::Invalid(format!(
                "api_version {:?} has no numeric major",
                self.api_version
            ))
        })
    }

    pub fn semver(&self) -> Result<semver::Version, ManifestError> {
        semver::Version::parse(&self.version)
            .map_err(|e| ManifestError::Invalid(format!("version {:?}: {e}", self.version)))
    }

    /// Capabilities this manifest offers, as `name@version` strings.
    pub fn provides_keys(&self) -> Vec<String> {
        let mut keys: Vec<String> = self.provides.iter().map(|p| p.capability.clone()).collect();
        keys.sort();
        keys.dedup();
        keys
    }
}

/// The set of permissions policy actually granted to a running capability.
///
/// A manifest can only ever produce a [`RequestedPermissions`]. The step from
/// requested to granted is [`crate::policy`]'s, and it is the only step where
/// the two are allowed to differ.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GrantedPermissions {
    entries: BTreeMap<(PermissionKind, String), ()>,
}

impl GrantedPermissions {
    pub fn grant(&mut self, kind: PermissionKind, resource: Option<&str>) {
        let key = (kind, resource.unwrap_or("").to_string());
        self.entries.insert(key, ());
    }

    pub fn holds(&self, kind: PermissionKind, resource: &str) -> bool {
        self.entries.contains_key(&(kind, resource.to_string()))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

impl fmt::Display for CapabilityKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CapabilityKind {
    type Err = ManifestError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        CapabilityKind::ALL
            .into_iter()
            .find(|k| k.as_str() == s)
            .ok_or_else(|| ManifestError::Invalid(format!("unknown capability kind {s:?}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal() -> Manifest {
        serde_json::from_str(
            r#"{
                "api_version": "teahub.dev/v0.1",
                "id": "acme.reviewer",
                "name": "Acme Reviewer",
                "version": "0.1.0",
                "kind": "agent",
                "description": "Reviews text.",
                "runtime": { "kind": "native", "entry": "reviewer.exe" },
                "provenance": { "source": "local" }
            }"#,
        )
        .expect("minimal manifest")
    }

    #[test]
    fn every_enum_prints_the_same_string_it_parses_from() {
        for kind in [
            PermissionKind::FsRead,
            PermissionKind::FsWrite,
            PermissionKind::NetEgress,
            PermissionKind::ProcSpawn,
            PermissionKind::SecretUse,
        ] {
            let json = serde_json::to_string(&kind).expect("serialise");
            assert_eq!(
                json,
                format!("\"{}\"", kind.as_str()),
                "{kind:?} prints {} but serialises as {json}",
                kind.as_str()
            );
            assert_eq!(serde_json::from_str::<PermissionKind>(&json).unwrap(), kind);
        }

        for kind in CapabilityKind::ALL {
            let json = serde_json::to_string(&kind).expect("serialise");
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
            assert_eq!(serde_json::from_str::<CapabilityKind>(&json).unwrap(), kind);
        }

        for trust in [
            ClaimedTrust::Builtin,
            ClaimedTrust::Local,
            ClaimedTrust::ThirdParty,
            ClaimedTrust::Untrusted,
        ] {
            let json = serde_json::to_string(&trust).expect("serialise");
            assert_eq!(json, format!("\"{}\"", trust.as_str()));
            assert_eq!(serde_json::from_str::<ClaimedTrust>(&json).unwrap(), trust);
        }
    }

    #[test]
    fn a_minimal_manifest_parses_and_defaults() {
        let m = minimal();
        assert_eq!(m.kind, CapabilityKind::Agent);
        assert_eq!(m.limits, Limits::default());
        assert!(m.permissions.is_empty());
        assert!(m.trust.is_none());
        assert_eq!(m.api_major().unwrap(), 0);
    }

    #[test]
    fn an_unknown_kind_is_rejected_rather_than_defaulted() {
        let e = serde_json::from_str::<Manifest>(
            r#"{"api_version":"teahub.dev/v0.1","id":"a.b","name":"A","version":"0.1.0",
                "kind":"daemon","description":"d","runtime":{"kind":"http","url":"http://x"},
                "provenance":{"source":"local"}}"#,
        );
        assert!(e.is_err(), "an unknown kind must fail, not fall through");
    }

    #[test]
    fn a_missing_runtime_kind_is_rejected() {
        let e = serde_json::from_str::<Manifest>(
            r#"{"api_version":"teahub.dev/v0.1","id":"a.b","name":"A","version":"0.1.0",
                "kind":"tool","description":"d","runtime":{"entry":"x"},
                "provenance":{"source":"local"}}"#,
        );
        assert!(e.is_err(), "runtime.kind is required, not defaulted");
    }

    #[test]
    fn filesystem_and_network_permissions_are_the_ones_that_need_a_resource() {
        assert!(PermissionKind::FsRead.requires_resource());
        assert!(PermissionKind::NetEgress.requires_resource());
        assert!(!PermissionKind::ProcSpawn.requires_resource());
        assert!(!PermissionKind::SecretUse.requires_resource());
    }

    #[test]
    fn claimed_trust_orders_from_most_to_least_trusted() {
        assert!(ClaimedTrust::Builtin < ClaimedTrust::Local);
        assert!(ClaimedTrust::Local < ClaimedTrust::ThirdParty);
        assert!(ClaimedTrust::ThirdParty < ClaimedTrust::Untrusted);
    }

    #[test]
    fn granted_permissions_are_keyed_by_kind_and_resource() {
        let mut g = GrantedPermissions::default();
        assert!(g.is_empty());
        g.grant(PermissionKind::FsRead, Some("data/teahub"));
        assert!(g.holds(PermissionKind::FsRead, "data/teahub"));
        assert!(!g.holds(PermissionKind::FsRead, "data/other"));
        assert!(!g.holds(PermissionKind::FsWrite, "data/teahub"));
        assert_eq!(g.len(), 1);
    }
}
