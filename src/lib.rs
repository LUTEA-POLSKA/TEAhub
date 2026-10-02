//! TEAhub — private, embedded-first AI capability platform.
//!
//! Core is deliberately independent of any host. The MLHSM integration lives in
//! the binary, not here: this library knows nothing about modules, ports or
//! HTTP, so it stays testable and the host stays replaceable.

pub mod capability;
pub mod config;
pub mod model;
pub mod registry;

pub use model::{ChatRequest, ChatResponse, Mesh, ModelClient, ModelError, Requirement};
pub use registry::{Entry, NotRunnable, Registry};
