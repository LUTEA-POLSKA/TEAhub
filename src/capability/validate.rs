//! Manifest validation.
//!
//! Refusal is total: a capability with one broken rule does not become
//! partially visible. A half-installed capability that answers some requests is
//! worse than one that is absent, because the absence is obvious and the half
//! is not.

use std::path::Path;

use crate::capability::digest;
use crate::capability::manifest::{Manifest, PermissionKind};

pub const SUPPORTED_API_MAJOR: u64 = 0;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("manifest is malformed: {0}")]
    Malformed(String),
    #[error("api_version major {found} is not supported (this build speaks major {expected})")]
    ApiMajor { found: u64, expected: u64 },
    #[error("id {id:?} is not a lowercase dotted identifier")]
    Id { id: String },
    #[error("id {0:?} is already taken by another capability of the same kind")]
    DuplicateId(String),
    #[error("description is empty")]
    EmptyDescription,
    #[error("permission {kind} needs a resource: {detail}")]
    PermissionWithoutResource { kind: &'static str, detail: String },
    #[error("permission {0} is requested more than once with different resources")]
    DuplicatePermission(String),
    #[error("provenance.source is empty")]
    EmptySource,
    #[error("declared digest {declared} does not match the payload ({actual})")]
    DigestMismatch { declared: String, actual: String },
    #[error("native entry {entry} is missing from the capability directory")]
    MissingEntry { entry: String },
    #[error("native entry {entry} must be a bare file name inside the capability directory")]
    EntryEscapesDirectory { entry: String },
    #[error("http runtime url {url:?} is not an http(s) URL")]
    BadUrl { url: String },
    #[error("stdio command {command:?} must be a bare file name")]
    BadCommand { command: String },
    #[error("requires the capability it also provides: {0}")]
    RequiresOwnCapability(String),
}

pub fn validate(m: &Manifest, root: &Path, expected_id: Option<&str>) -> Result<(), ValidationError> {
    let major = m
        .api_major()
        .map_err(|e| ValidationError::Malformed(e.to_string()))?;
    if major != SUPPORTED_API_MAJOR {
        return Err(ValidationError::ApiMajor {
            found: major,
            expected: SUPPORTED_API_MAJOR,
        });
    }

    if !valid_id(&m.id) {
        return Err(ValidationError::Id { id: m.id.clone() });
    }
    if let Some(expected) = expected_id {
        if m.id != expected {
            return Err(ValidationError::Id {
                id: format!("{} (directory says {expected})", m.id),
            });
        }
    }

    let _ = m
        .semver()
        .map_err(|e| ValidationError::Malformed(e.to_string()))?;

    if m.description.trim().is_empty() {
        return Err(ValidationError::EmptyDescription);
    }
    if m.provenance.source.trim().is_empty() {
        return Err(ValidationError::EmptySource);
    }

    validate_runtime(m, root)?;
    validate_permissions(m)?;

    for provided in m.provides_keys() {
        if m.requires.iter().any(|r| r.capability == provided) {
            return Err(ValidationError::RequiresOwnCapability(provided));
        }
    }

    if let Some(declared) = &m.provenance.digest {
        let actual = digest::digest_of(root)
            .map_err(|e| ValidationError::Malformed(format!("payload unreadable: {e}")))?;
        if !declared.eq_ignore_ascii_case(&actual) {
            return Err(ValidationError::DigestMismatch {
                declared: declared.clone(),
                actual,
            });
        }
    }

    Ok(())
}

fn validate_runtime(m: &Manifest, root: &Path) -> Result<(), ValidationError> {
    use crate::capability::manifest::Runtime;
    match &m.runtime {
        Runtime::Native { entry } => {
            let raw = entry.to_string_lossy();
            if raw.contains('/') || raw.contains('\\') || raw.contains(':') {
                return Err(ValidationError::EntryEscapesDirectory { entry: raw.into() });
            }
            if !root.join(entry).is_file() {
                return Err(ValidationError::MissingEntry { entry: raw.into() });
            }
        }
        Runtime::Stdio { command, .. } => {
            if command.contains('/') || command.contains('\\') || command.contains(':') {
                return Err(ValidationError::BadCommand {
                    command: command.clone(),
                });
            }
        }
        Runtime::Http { url } => {
            if !(url.starts_with("http://") || url.starts_with("https://")) {
                return Err(ValidationError::BadUrl { url: url.clone() });
            }
        }
    }
    Ok(())
}

fn validate_permissions(m: &Manifest) -> Result<(), ValidationError> {
    use crate::capability::manifest::RequestedPermission;
    let mut seen = Vec::new();
    for RequestedPermission { kind, resource } in &m.permissions {
        if kind.requires_resource() {
            let empty = resource.as_deref().map(str::trim).unwrap_or("").is_empty();
            if empty {
                return Err(ValidationError::PermissionWithoutResource {
                    kind: kind.as_str(),
                    detail: format!("{} takes no resource", kind.as_str()),
                });
            }
        }
        if seen.iter().any(|(k, r): &(PermissionKind, Option<String>)| {
            k == kind && r.as_ref() != resource.as_ref()
        }) {
            return Err(ValidationError::DuplicatePermission(kind.as_str().into()));
        }
        seen.push((*kind, resource.clone()));
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 128 {
        return false;
    }
    if id.starts_with('.') || id.ends_with('.') || id.contains("..") {
        return false;
    }
    id.split('.')
        .all(|segment| !segment.is_empty() && segment.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::manifest::CapabilityKind;
    use std::fs;

    fn manifest() -> Manifest {
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
        .expect("manifest")
    }

    fn seeded(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("acme.reviewer");
        fs::create_dir_all(&root).expect("mkdir");
        fs::write(root.join("reviewer.exe"), b"binary").expect("write entry");
        let _ = tag;
        (dir, root)
    }

    #[test]
    fn a_well_formed_manifest_validates() {
        let (_d, root) = seeded("ok");
        assert!(validate(&manifest(), &root, Some("acme.reviewer")).is_ok());
    }

    #[test]
    fn a_foreign_api_major_is_refused() {
        let (_d, root) = seeded("major");
        let mut m = manifest();
        m.api_version = "teahub.dev/v1.0".into();
        assert!(matches!(
            validate(&m, &root, None),
            Err(ValidationError::ApiMajor { found: 1, expected: 0 })
        ));
    }

    #[test]
    fn a_malformed_id_is_refused() {
        let (_d, root) = seeded("id");
        for bad in ["Acme.Reviewer", "acme..reviewer", ".acme", "acme.", "", "acme/reviewer"] {
            let mut m = manifest();
            m.id = bad.into();
            assert!(
                matches!(validate(&m, &root, None), Err(ValidationError::Id { .. })),
                "id {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn a_missing_native_entry_is_refused() {
        let (_d, root) = seeded("entry");
        let _ = fs::remove_file(root.join("reviewer.exe"));
        assert!(matches!(
            validate(&manifest(), &root, None),
            Err(ValidationError::MissingEntry { .. })
        ));
    }

    #[test]
    fn an_entry_escaping_the_directory_is_refused() {
        let (_d, root) = seeded("escape");
        for bad in ["../evil.exe", "sub/evil.exe", "C:/evil.exe"] {
            let mut m = manifest();
            m.runtime = crate::capability::manifest::Runtime::Native {
                entry: bad.into(),
            };
            assert!(
                matches!(
                    validate(&m, &root, None),
                    Err(ValidationError::EntryEscapesDirectory { .. })
                ),
                "entry {bad:?} must be refused"
            );
        }
    }

    #[test]
    fn a_filesystem_permission_without_a_resource_is_refused() {
        let (_d, root) = seeded("perm");
        let mut m = manifest();
        m.permissions = vec![crate::capability::manifest::RequestedPermission {
            kind: PermissionKind::FsRead,
            resource: None,
        }];
        assert!(matches!(
            validate(&m, &root, None),
            Err(ValidationError::PermissionWithoutResource { .. })
        ));
    }

    #[test]
    fn proc_spawn_needs_no_resource() {
        let (_d, root) = seeded("proc");
        let mut m = manifest();
        m.permissions = vec![crate::capability::manifest::RequestedPermission {
            kind: PermissionKind::ProcSpawn,
            resource: None,
        }];
        assert!(validate(&m, &root, None).is_ok());
    }

    #[test]
    fn the_same_permission_on_two_resources_is_refused_as_ambiguous() {
        let (_d, root) = seeded("dup");
        let mut m = manifest();
        m.permissions = vec![
            crate::capability::manifest::RequestedPermission {
                kind: PermissionKind::FsRead,
                resource: Some("data/a".into()),
            },
            crate::capability::manifest::RequestedPermission {
                kind: PermissionKind::FsRead,
                resource: Some("data/b".into()),
            },
        ];
        assert!(matches!(
            validate(&m, &root, None),
            Err(ValidationError::DuplicatePermission(_))
        ));
    }

    #[test]
    fn a_declared_digest_that_does_not_match_the_payload_is_refused() {
        let (_d, root) = seeded("digest");
        let mut m = manifest();
        m.provenance.digest = Some("sha256:".to_string() + &"0".repeat(64));
        assert!(matches!(
            validate(&m, &root, None),
            Err(ValidationError::DigestMismatch { .. })
        ));
    }

    #[test]
    fn a_declared_digest_that_matches_the_payload_is_accepted() {
        let (_d, root) = seeded("digest-ok");
        let actual = digest::digest_of(&root).expect("digest");
        let mut m = manifest();
        m.provenance.digest = Some(actual);
        assert!(validate(&m, &root, None).is_ok());
    }

    #[test]
    fn a_capability_may_not_require_what_it_provides() {
        let (_d, root) = seeded("selfreq");
        let mut m = manifest();
        m.provides = vec![crate::capability::manifest::Provides {
            capability: "text.review".into(),
            version: 1,
        }];
        m.requires = vec![crate::capability::manifest::Requirement {
            capability: "text.review".into(),
            optional: false,
        }];
        assert!(matches!(
            validate(&m, &root, None),
            Err(ValidationError::RequiresOwnCapability(_))
        ));
    }

    #[test]
    fn every_capability_kind_has_a_directory_name() {
        for kind in CapabilityKind::ALL {
            assert!(!kind.dir_name().is_empty());
        }
    }
}
