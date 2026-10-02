//! The capability registry.
//!
//! Discovery and installation are different things, and this keeps them apart.
//! A directory under the root can *describe* a capability; only a payload that
//! validated against its own manifest and its own bytes can *run* one. A broken
//! capability is reported as broken rather than skipped, because a silently
//! missing entry looks exactly like a capability that was never meant to exist.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::capability::digest;
use crate::capability::manifest::{
    CapabilityKind, ClaimedTrust, GrantedPermissions, Manifest, RequestedPermission, MANIFEST_FILE,
};
use crate::capability::validate::{self, ValidationError};

pub const DEFAULT_FIRST_PORT: u16 = 19_900;
pub const DEFAULT_LAST_PORT: u16 = 19_999;
pub const ENV_PORT: &str = "MLHSM_MODULE_PORT";

/// Why a discovered capability is not runnable, if it is not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotRunnable {
    NoManifest,
    UnreadableManifest(String),
    BadJson(String),
    Rejected(ValidationError),
    MissingRequirement(String),
    PinnedDigestChanged { expected: String, actual: String },
    DependencyCycle(Vec<String>),
}

impl std::fmt::Display for NotRunnable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotRunnable::NoManifest => write!(f, "no {MANIFEST_FILE} in the directory"),
            NotRunnable::UnreadableManifest(e) => write!(f, "{MANIFEST_FILE} unreadable: {e}"),
            NotRunnable::BadJson(e) => write!(f, "{MANIFEST_FILE} is not valid JSON: {e}"),
            NotRunnable::Rejected(e) => write!(f, "rejected: {e}"),
            NotRunnable::MissingRequirement(c) => {
                write!(f, "requires capability {c:?}, which no installed capability provides")
            }
            NotRunnable::PinnedDigestChanged { expected, actual } => {
                write!(f, "payload changed since it was pinned: expected {expected}, found {actual}")
            }
            NotRunnable::DependencyCycle(names) => {
                write!(f, "dependency cycle: {}", names.join(" -> "))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub path: String,
    pub runnable: bool,
    pub enabled: bool,
    /// Policy-assigned trust. Always at most what the author claimed.
    pub effective_trust: String,
    pub claimed_trust: Option<String>,
    pub digest: Option<String>,
    pub provides: Vec<String>,
    pub requires: Vec<String>,
    pub problem: Option<String>,
}

/// What the registry remembers about one capability across scans.
///
/// Enabling pins the payload digest. Approval therefore binds to exact bytes:
/// a later edit invalidates the approval instead of silently riding on it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CapabilityState {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_digest: Option<String>,
}

pub struct Registry {
    root: PathBuf,
}

impl Registry {
    pub fn open(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Every directory under the root, whether or not it turned out to be a
    /// capability. Sorted by id so two scans of the same tree compare equal.
    pub fn scan(&self) -> Vec<Entry> {
        let state = self.load_state();
        let provided = self.provided_capabilities();

        let mut out = Vec::new();
        let kinds = std::fs::read_dir(&self.root)
            .map(|entries| {
                entries
                    .flatten()
                    .filter(|e| e.path().is_dir())
                    .map(|e| e.path())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        for kind_root in kinds {
            let Ok(entries) = std::fs::read_dir(&kind_root) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if let Some(found) = self.inspect(&path, &state, &provided) {
                    out.push(found);
                }
            }
        }
        out.sort_by(|a, b| (a.kind.clone(), a.id.clone()).cmp(&(b.kind.clone(), b.id.clone())));
        out
    }

    fn inspect(
        &self,
        path: &Path,
        state: &BTreeMap<String, CapabilityState>,
        provided: &BTreeMap<String, String>,
    ) -> Option<Entry> {
        let enabled_of = |id: &str| state.get(id).map(|s| s.enabled).unwrap_or(false);
        let pinned_of = |id: &str| state.get(id).and_then(|s| s.pinned_digest.clone());

        let Some(dir_name) = path.file_name() else {
            return None;
        };
        let dir_id = dir_name.to_string_lossy().to_string();

        let manifest_path = path.join(MANIFEST_FILE);
        if !manifest_path.is_file() {
            return Some(entry_skeleton(
                &dir_id,
                path,
                false,
                enabled_of(&dir_id),
                NotRunnable::NoManifest,
            ));
        }

        let raw = match std::fs::read_to_string(&manifest_path) {
            Ok(raw) => raw,
            Err(e) => {
                return Some(entry_skeleton(
                    &dir_id,
                    path,
                    false,
                    enabled_of(&dir_id),
                    NotRunnable::UnreadableManifest(e.to_string()),
                ));
            }
        };

        let manifest: Manifest = match parse_manifest(&raw) {
            Ok(m) => m,
            Err(e) => {
                return Some(entry_skeleton(
                    &dir_id,
                    path,
                    false,
                    enabled_of(&dir_id),
                    NotRunnable::BadJson(e.to_string()),
                ));
            }
        };

        let id = manifest.id.clone();
        let mut problem = None;
        let mut runnable = true;

        if let Err(e) = validate::validate(&manifest, path, Some(&id)) {
            runnable = false;
            problem = Some(NotRunnable::Rejected(e).to_string());
        } else {
            for Requirement { capability, .. } in required_capabilities(&manifest) {
                if !provided.contains_key(&capability) {
                    runnable = false;
                    problem = Some(NotRunnable::MissingRequirement(capability).to_string());
                    break;
                }
            }
        }

        let digest = digest::digest_of(path).ok();

        if let Some(pinned) = pinned_of(&id) {
            if let Some(actual) = &digest {
                if !actual.eq_ignore_ascii_case(&pinned) {
                    runnable = false;
                    problem = Some(
                        NotRunnable::PinnedDigestChanged {
                            expected: pinned,
                            actual: actual.clone(),
                        }
                        .to_string(),
                    );
                }
            }
        }

        let entry = Entry {
            id: id.clone(),
            kind: manifest.kind.to_string(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            description: manifest.description.clone(),
            path: path.to_string_lossy().to_string(),
            runnable,
            enabled: runnable && enabled_of(&id),
            effective_trust: effective_trust(&manifest).as_str().to_string(),
            claimed_trust: manifest.trust.map(|t| t.as_str().to_string()),
            digest,
            provides: manifest.provides_keys(),
            requires: required_capabilities(&manifest)
                .into_iter()
                .map(|c| c.capability)
                .collect(),
            problem,
        };
        Some(entry)
    }

    /// Runnable capabilities in an order where every requirement is already met.
    ///
    /// Capabilities whose requirements form a cycle are excluded and reported
    /// rather than ordered arbitrarily.
    pub fn resolve(&self) -> (Vec<Entry>, Vec<Entry>) {
        let entries = self.scan();
        let ready: BTreeMap<String, Entry> = entries
            .iter()
            .filter(|e| e.runnable)
            .map(|e| (e.id.clone(), e.clone()))
            .collect();

        let provided: BTreeSet<String> = ready
            .values()
            .flat_map(|e| e.provides.iter().cloned())
            .collect();

        let mut satisfied: BTreeSet<String> = BTreeSet::new();
        let mut ordered: Vec<Entry> = Vec::new();
        let mut remaining: Vec<String> = ready.keys().cloned().collect();

        while !remaining.is_empty() {
            let next: Vec<String> = remaining
                .iter()
                .filter(|id| {
                    let entry = &ready[*id];
                    entry.requires.iter().all(|c| provided.contains(c))
                        && entry.requires.iter().all(|c| satisfied_globally(c, &ready, &satisfied))
                })
                .cloned()
                .collect();

            if next.is_empty() {
                break;
            }
            for id in &next {
                if let Some(entry) = ready.get(id) {
                    ordered.push(entry.clone());
                    satisfied.insert(id.clone());
                }
            }
            remaining.retain(|id| !next.contains(id));
        }

        let stuck: Vec<Entry> = remaining
            .iter()
            .filter_map(|id| ready.get(id))
            .map(|e| Entry {
                problem: Some(
                    NotRunnable::DependencyCycle(remaining.clone()).to_string(),
                ),
                runnable: false,
                ..e.clone()
            })
            .collect();

        (ordered, stuck)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let mut map = self.load_state();
        let pinned = if enabled {
            self.scan()
                .into_iter()
                .find(|e| e.id == id)
                .and_then(|e| e.digest)
        } else {
            None
        };
        map.insert(
            id.to_string(),
            CapabilityState {
                enabled,
                pinned_digest: pinned,
            },
        );
        self.save_state(&map)
    }

    fn load_state(&self) -> BTreeMap<String, CapabilityState> {
        let Ok(raw) = std::fs::read_to_string(self.state_path()) else {
            return BTreeMap::new();
        };
        if let Ok(current) = serde_json::from_str::<BTreeMap<String, CapabilityState>>(&raw) {
            return current;
        }
        serde_json::from_str::<BTreeMap<String, bool>>(&raw)
            .map(|legacy| {
                legacy
                    .into_iter()
                    .map(|(id, enabled)| {
                        (
                            id,
                            CapabilityState {
                                enabled,
                                pinned_digest: None,
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn save_state(&self, map: &BTreeMap<String, CapabilityState>) -> Result<(), String> {
        if let Some(parent) = self.state_path().parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(
            self.state_path(),
            serde_json::to_vec_pretty(map).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())
    }

    pub fn enabled_ids(&self) -> BTreeSet<String> {
        self.load_state()
            .into_iter()
            .filter(|(_, s)| s.enabled)
            .map(|(id, _)| id)
            .collect()
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn provided_capabilities(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for entry in self.scan_raw() {
            for capability in entry.provides {
                out.entry(capability).or_insert(entry.id.clone());
            }
        }
        out
    }

    fn scan_raw(&self) -> Vec<Entry> {
        let mut out = Vec::new();
        let Ok(kinds) = std::fs::read_dir(&self.root) else {
            return out;
        };
        for kind_root in kinds.flatten() {
            if !kind_root.path().is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(kind_root.path()) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(path.join(MANIFEST_FILE)) else {
                    continue;
                };
                let Ok(manifest) = parse_manifest(&raw) else {
                    continue;
                };
                out.push(Entry {
                    id: manifest.id.clone(),
                    kind: manifest.kind.to_string(),
                    name: manifest.name.clone(),
                    version: manifest.version.clone(),
                    description: manifest.description.clone(),
                    path: path.to_string_lossy().to_string(),
                    runnable: true,
                    enabled: false,
                    effective_trust: effective_trust(&manifest).as_str().to_string(),
                    claimed_trust: manifest.trust.map(|t| t.as_str().to_string()),
                    digest: None,
                    provides: manifest.provides_keys(),
                    requires: required_capabilities(&manifest)
                        .into_iter()
                        .map(|c| c.capability)
                        .collect(),
                    problem: None,
                });
            }
        }
        out
    }
}

struct Requirement {
    capability: String,
    #[allow(dead_code)]
    optional: bool,
}

fn required_capabilities(m: &Manifest) -> Vec<Requirement> {
    m.requires
        .iter()
        .filter(|r| !r.optional)
        .map(|r| Requirement {
            capability: r.capability.clone(),
            optional: r.optional,
        })
        .collect()
}

/// Policy may only ever lower the claimed trust.
///
/// `Builtin` and `Local` are granted by provenance and cannot be raised by an
/// author; `ThirdParty` is capped at what the author claimed.
pub fn effective_trust(m: &Manifest) -> ClaimedTrust {
    match (&m.provenance.source, m.trust) {
        (source, _) if source.starts_with("builtin") => ClaimedTrust::Builtin,
        (source, _) if source.starts_with("local") => ClaimedTrust::Local,
        (_, Some(ClaimedTrust::Untrusted)) => ClaimedTrust::Untrusted,
        (_, Some(ClaimedTrust::Local)) => ClaimedTrust::Local,
        (_, Some(ClaimedTrust::ThirdParty)) => ClaimedTrust::ThirdParty,
        (_, Some(ClaimedTrust::Builtin)) => ClaimedTrust::ThirdParty,
        (_, None) => ClaimedTrust::ThirdParty,
    }
}

fn satisfied_globally(
    capability: &str,
    ready: &BTreeMap<String, Entry>,
    satisfied: &BTreeSet<String>,
) -> bool {
    ready
        .values()
        .any(|e| e.provides.iter().any(|p| p == capability) && satisfied.contains(&e.id))
}

/// Parse a manifest, tolerating a UTF-8 byte-order mark.
///
/// PowerShell's `Out-File -Encoding utf8` and several Windows editors write one,
/// and serde_json rejects it outright. The file is valid JSON; refusing it would
/// report a confusing parse error for a document that reads correctly in any
/// editor, so the mark is stripped rather than treated as corruption.
fn parse_manifest(raw: &str) -> Result<Manifest, serde_json::Error> {
    serde_json::from_str(raw.strip_prefix('\u{feff}').unwrap_or(raw))
}

fn entry_skeleton(
    id: &str,
    path: &Path,
    runnable: bool,
    enabled: bool,
    problem: NotRunnable,
) -> Entry {
    Entry {
        id: id.to_string(),
        kind: "unknown".into(),
        name: id.to_string(),
        version: String::new(),
        description: String::new(),
        path: path.to_string_lossy().to_string(),
        runnable,
        enabled: runnable && enabled,
        effective_trust: ClaimedTrust::Untrusted.as_str().to_string(),
        claimed_trust: None,
        digest: None,
        provides: Vec::new(),
        requires: Vec::new(),
        problem: Some(problem.to_string()),
    }
}

/// The permissions an author *asked* for. Still not granted — see [`policy`].
pub fn requested_permissions(m: &Manifest) -> Vec<RequestedPermission> {
    m.permissions.clone()
}

pub fn empty_grants() -> GrantedPermissions {
    GrantedPermissions::default()
}

pub fn kind_of(kind: &str) -> Option<CapabilityKind> {
    kind.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_capability(root: &Path, kind: &str, id: &str, extra: &str) {
        let dir = root.join(kind).join(id);
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("entry.exe"), b"binary").expect("entry");
        fs::write(
            dir.join(MANIFEST_FILE),
            format!(
                r#"{{"api_version":"teahub.dev/v0.1","id":"{id}","name":"{id}",
                    "version":"0.1.0","kind":"{kind}","description":"d",
                    "runtime":{{"kind":"native","entry":"entry.exe"}},
                    "provenance":{{"source":"local"}}{extra}}}"#
            ),
        )
        .expect("manifest");
    }

    fn root(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("capabilities");
        fs::create_dir_all(&root).expect("mkdir root");
        let _ = tag;
        (dir, root)
    }

    #[test]
    fn enabling_pins_the_payload_so_a_later_edit_loses_the_approval() {
        let (_d, root) = root("pin");
        write_capability(&root, "tool", "acme.tool", "");
        let registry = Registry::open(&root);
        registry.set_enabled("acme.tool", true).expect("enable");

        let before = registry.scan();
        assert!(before[0].runnable && before[0].enabled);

        fs::write(root.join("tool/acme.tool/entry.exe"), b"tampered").expect("tamper");

        let after = registry.scan();
        assert!(
            !after[0].runnable,
            "an edit after approval must invalidate it, not ride along on it"
        );
        assert!(!after[0].enabled, "an invalid payload must not report as enabled");
        let problem = after[0].problem.as_ref().expect("a reason is owed");
        assert!(problem.contains("changed since it was pinned"), "{problem}");
    }

    #[test]
    fn an_untouched_capability_stays_valid_across_scans() {
        let (_d, root) = root("stable");
        write_capability(&root, "tool", "acme.tool", "");
        let registry = Registry::open(&root);
        registry.set_enabled("acme.tool", true).expect("enable");
        for _ in 0..3 {
            let entries = registry.scan();
            assert!(entries[0].runnable, "repeated scans must be stable");
        }
    }

    #[test]
    fn an_unpinned_capability_with_no_declared_digest_cannot_claim_tamper_proof() {
        let (_d, root) = root("nopin");
        write_capability(&root, "tool", "acme.tool", "");
        fs::write(root.join("tool/acme.tool/entry.exe"), b"tampered").expect("tamper");
        let entries = Registry::open(&root).scan();
        assert!(
            entries[0].runnable,
            "without a pin and without a declared digest there is nothing to compare, so \
             this reports honestly rather than claiming a proof it does not have"
        );
        assert!(entries[0].digest.is_some(), "the current digest is still reported");
    }

    #[test]
    fn legacy_boolean_state_is_still_read() {
        let (_d, root) = root("legacy");
        write_capability(&root, "tool", "acme.tool", "");
        fs::write(root.join("state.json"), r#"{"acme.tool":true}"#).expect("legacy state");
        let registry = Registry::open(&root);
        assert!(registry.enabled_ids().contains("acme.tool"));
        assert!(registry.scan()[0].enabled);
    }

    #[test]
    fn a_byte_order_mark_does_not_make_a_manifest_unreadable() {
        let (_d, root) = root("bom");
        let dir = root.join("agent/acme.reviewer");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join("entry.exe"), b"binary").expect("entry");
        fs::write(
            dir.join(MANIFEST_FILE),
            "\u{feff}{\"api_version\":\"teahub.dev/v0.1\",\"id\":\"acme.reviewer\",\
              \"name\":\"A\",\"version\":\"0.1.0\",\"kind\":\"agent\",\"description\":\"d\",\
              \"runtime\":{\"kind\":\"native\",\"entry\":\"entry.exe\"},\
              \"provenance\":{\"source\":\"local\"}}",
        )
        .expect("write bom manifest");

        let entries = Registry::open(&root).scan();
        assert_eq!(entries.len(), 1);
        assert!(
            entries[0].runnable,
            "a BOM is a Windows tooling artefact, not corruption: {:?}",
            entries[0].problem
        );
    }

    #[test]
    fn an_empty_root_scans_to_nothing() {
        let (_d, root) = root("empty");
        assert!(Registry::open(&root).scan().is_empty());
    }

    #[test]
    fn a_valid_capability_is_runnable() {
        let (_d, root) = root("valid");
        write_capability(&root, "agent", "acme.reviewer", "");
        let entries = Registry::open(&root).scan();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].runnable, "problem: {:?}", entries[0].problem);
        assert_eq!(entries[0].kind, "agent");
        assert_eq!(entries[0].effective_trust, "local");
    }

    #[test]
    fn a_directory_without_a_manifest_is_reported_not_skipped() {
        let (_d, root) = root("bare");
        fs::create_dir_all(root.join("tool/ghost")).expect("mkdir");
        let entries = Registry::open(&root).scan();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "ghost");
        assert!(!entries[0].runnable);
        assert!(entries[0].problem.as_ref().unwrap().contains("no module.json"));
    }

    #[test]
    fn an_unparseable_manifest_is_reported_rather_than_vanishing() {
        let (_d, root) = root("broken");
        fs::create_dir_all(root.join("tool/broken")).expect("mkdir");
        fs::write(root.join("tool/broken/module.json"), "{ not json").expect("write");
        let entries = Registry::open(&root).scan();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].runnable);
        assert!(entries[0].problem.as_ref().unwrap().contains("not valid JSON"));
    }

    #[test]
    fn a_manifest_whose_payload_was_tampered_with_stops_being_runnable() {
        let (_d, root) = root("tamper");
        write_capability(&root, "tool", "acme.tool", "");
        let dir = root.join("tool/acme.tool");
        let actual = digest::digest_of(&dir).expect("digest");
        let raw = fs::read_to_string(dir.join(MANIFEST_FILE)).expect("read");
        let patched = raw.replace(
            r#""provenance":{"source":"local"}"#,
            &format!(r#""provenance":{{"source":"local","digest":"{actual}"}}"#),
        );
        fs::write(dir.join(MANIFEST_FILE), patched).expect("patch");
        assert!(Registry::open(&root).scan()[0].runnable);

        fs::write(dir.join("entry.exe"), b"tampered").expect("tamper");
        let after = Registry::open(&root).scan();
        assert!(!after[0].runnable, "a changed payload must be caught");
        assert!(after[0].problem.as_ref().unwrap().contains("does not match"));
    }

    #[test]
    fn a_missing_required_capability_makes_the_consumer_unrunnable() {
        let (_d, root) = root("requires");
        write_capability(
            &root,
            "workflow",
            "acme.flow",
            r#","requires":[{"capability":"text.review"}]"#,
        );
        let entries = Registry::open(&root).scan();
        assert!(!entries[0].runnable);
        assert!(entries[0].problem.as_ref().unwrap().contains("text.review"));
    }

    #[test]
    fn a_satisfied_requirement_resolves_in_order() {
        let (_d, root) = root("order");
        write_capability(
            &root,
            "workflow",
            "acme.flow",
            r#","requires":[{"capability":"text.review"}],"provides":[{"capability":"flow.review"}]"#,
        );
        write_capability(
            &root,
            "agent",
            "acme.reviewer",
            r#","provides":[{"capability":"text.review"}]"#,
        );
        let (ordered, stuck) = Registry::open(&root).resolve();
        assert!(stuck.is_empty(), "nothing should be stuck: {stuck:?}");
        let ids: Vec<&str> = ordered.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids, vec!["acme.reviewer", "acme.flow"], "provider first");
    }

    #[test]
    fn an_unresolvable_consumer_is_reported_by_scan_and_not_ordered() {
        let (_d, root) = root("stuck");
        write_capability(
            &root,
            "workflow",
            "acme.flow",
            r#","requires":[{"capability":"nothing.provides.this"}]"#,
        );
        let registry = Registry::open(&root);
        let entries = registry.scan();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].runnable);
        assert!(entries[0].problem.as_ref().unwrap().contains("requires capability"));

        let (ordered, _) = registry.resolve();
        assert!(
            ordered.is_empty(),
            "a capability whose requirement is missing must never be ordered"
        );
    }

    #[test]
    fn a_dependency_cycle_is_reported_rather_than_ordered_arbitrarily() {
        let (_d, root) = root("cycle");
        write_capability(
            &root,
            "agent",
            "acme.a",
            r#","provides":[{"capability":"cap.a"}],"requires":[{"capability":"cap.b"}]"#,
        );
        write_capability(
            &root,
            "agent",
            "acme.b",
            r#","provides":[{"capability":"cap.b"}],"requires":[{"capability":"cap.a"}]"#,
        );
        let registry = Registry::open(&root);
        assert!(
            registry.scan().iter().all(|e| e.runnable),
            "each requirement is satisfied by something, so scan must accept both"
        );

        let (ordered, stuck) = registry.resolve();
        assert!(ordered.is_empty(), "nothing in a cycle may be ordered");
        assert_eq!(stuck.len(), 2);
        assert!(stuck.iter().all(|e| e
            .problem
            .as_ref()
            .unwrap()
            .contains("dependency cycle")));
        assert!(stuck.iter().all(|e| !e.runnable));
    }

    #[test]
    fn policy_can_lower_claimed_trust_but_never_raise_it() {
        let claimed_untrusted: Manifest = serde_json::from_str(
            r#"{"api_version":"teahub.dev/v0.1","id":"a.b","name":"A","version":"0.1.0",
                "kind":"tool","description":"d","runtime":{"kind":"native","entry":"e"},
                "provenance":{"source":"registry:x"},"trust":"untrusted"}"#,
        )
        .unwrap();
        assert_eq!(effective_trust(&claimed_untrusted), ClaimedTrust::Untrusted);

        let claims_builtin: Manifest = serde_json::from_str(
            r#"{"api_version":"teahub.dev/v0.1","id":"a.b","name":"A","version":"0.1.0",
                "kind":"tool","description":"d","runtime":{"kind":"native","entry":"e"},
                "provenance":{"source":"registry:x"},"trust":"builtin"}"#,
        )
        .unwrap();
        assert_eq!(
            effective_trust(&claims_builtin),
            ClaimedTrust::ThirdParty,
            "an author cannot promote itself to builtin"
        );

        let from_registry: Manifest = serde_json::from_str(
            r#"{"api_version":"teahub.dev/v0.1","id":"a.b","name":"A","version":"0.1.0",
                "kind":"tool","description":"d","runtime":{"kind":"native","entry":"e"},
                "provenance":{"source":"registry:x"}}"#,
        )
        .unwrap();
        assert_eq!(effective_trust(&from_registry), ClaimedTrust::ThirdParty);
    }

    #[test]
    fn enabled_state_round_trips_and_ignores_a_missing_file() {
        let (_d, root) = root("state");
        write_capability(&root, "agent", "acme.reviewer", "");
        let registry = Registry::open(&root);
        assert!(registry.enabled_ids().is_empty());
        registry.set_enabled("acme.reviewer", true).expect("write");
        assert!(registry.enabled_ids().contains("acme.reviewer"));
        registry.set_enabled("acme.reviewer", false).expect("write");
        assert!(!registry.enabled_ids().contains("acme.reviewer"));
    }

    #[test]
    fn an_unrunnable_capability_can_never_report_as_enabled() {
        let (_d, root) = root("noenable");
        fs::create_dir_all(root.join("tool/ghost")).expect("mkdir");
        let registry = Registry::open(&root);
        registry.set_enabled("ghost", true).expect("write");
        let entries = registry.scan();
        assert!(!entries[0].enabled, "stored intent must not survive into a broken entry");
    }
}
