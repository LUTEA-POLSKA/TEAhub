//! Content digest over a capability payload.
//!
//! Covers every file under a capability directory except the manifest itself,
//! because the manifest carries the expected digest and hashing it would be
//! circular. Paths are sorted and length-prefixed so no pair of files can be
//! rearranged into a different tree with the same digest.

use std::io;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// `sha256:<64 hex chars>` over a directory tree, or a single file.
pub fn digest_of(root: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut files = Vec::new();
    collect(root, root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));

    for (relative, absolute) in files {
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        let bytes = std::fs::read(&absolute)?;
        hasher.update((bytes.len() as u64).to_le_bytes());
        hasher.update(&bytes);
    }
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) -> io::Result<()> {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == super::manifest::MANIFEST_FILE {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect(root, &path, out)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, path));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().to_path_buf();
        fs::create_dir_all(root.join("nested")).expect("mkdir");
        fs::write(root.join("a.txt"), b"alpha").expect("write a");
        fs::write(root.join("nested/b.txt"), b"beta").expect("write b");
        fs::write(
            root.join(super::super::manifest::MANIFEST_FILE),
            br#"{"ignored":true}"#,
        )
        .expect("write manifest");
        let _ = tag;
        (dir, root)
    }

    #[test]
    fn the_digest_is_stable_across_runs() {
        let (_d, a) = tree("a");
        let (_e, b) = tree("b");
        assert_eq!(digest_of(&a).unwrap(), digest_of(&b).unwrap());
    }

    #[test]
    fn changing_content_changes_the_digest() {
        let (dir, root) = tree("a");
        let before = digest_of(&root).unwrap();
        fs::write(root.join("a.txt"), b"alphb").expect("rewrite");
        assert_ne!(before, digest_of(&root).unwrap());
        drop(dir);
    }

    #[test]
    fn renaming_a_file_changes_the_digest() {
        let (dir, root) = tree("a");
        let before = digest_of(&root).unwrap();
        fs::rename(root.join("a.txt"), root.join("c.txt")).expect("rename");
        assert_ne!(before, digest_of(&root).unwrap());
        drop(dir);
    }

    #[test]
    fn the_manifest_is_not_part_of_the_digest() {
        let (dir, root) = tree("a");
        let before = digest_of(&root).unwrap();
        fs::write(root.join("module.json"), br#"{"changed":true}"#).expect("rewrite");
        assert_eq!(before, digest_of(&root).unwrap());
        drop(dir);
    }

    #[test]
    fn swapping_two_files_across_paths_changes_the_digest() {
        let (dir, root) = tree("a");
        fs::write(root.join("a.txt"), b"beta").expect("write a");
        fs::write(root.join("nested/b.txt"), b"alpha").expect("write b");
        let swapped = digest_of(&root).unwrap();
        fs::write(root.join("a.txt"), b"alpha").expect("restore a");
        fs::write(root.join("nested/b.txt"), b"beta").expect("restore b");
        assert_ne!(swapped, digest_of(&root).unwrap());
        drop(dir);
    }

    #[test]
    fn an_absent_directory_is_empty_not_an_error() {
        let dir = tempfile::tempdir().expect("tempdir");
        let digest = digest_of(&dir.path().join("nope")).expect("absent is fine");
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), 7 + 64);
    }
}
