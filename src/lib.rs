//! TEAhub â€” private, embedded-first AI capability platform.
//!
//! Core is deliberately independent of any host. The MLHSM integration lives in
//! the binary, not here: this library knows nothing about modules, ports or
//! HTTP, so it stays testable and the host stays replaceable.

pub mod capability;
pub mod config;
pub mod model;
pub mod policy;
pub mod registry;

pub use model::{ChatRequest, ChatResponse, Mesh, ModelClient, ModelError, Requirement};
pub use registry::{Entry, NotRunnable, Registry};

/// Drop a UTF-8 byte-order mark before parsing.
///
/// PowerShell's `Out-File -Encoding utf8` and several Windows editors write
/// one, and `serde_json` rejects it outright. The document is valid JSON;
/// refusing it would report a parse error for a file that reads correctly in
/// every editor. Applied at every entry point that reads operator-authored
/// JSON, so the rule has one home instead of being remembered per file.
pub fn strip_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{feff}').unwrap_or(raw)
}

/// Parse operator-authored JSON.
///
/// Every `serde_json::from_str` on a file or config a human can touch goes
/// through here. Stripping the mark at each call site kept being forgotten — it
/// was missed in three separate loaders — so the rule now lives in one function
/// rather than in the discipline of whoever adds the next reader.
pub fn parse_json<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, serde_json::Error> {
    serde_json::from_str(strip_bom(raw))
}
