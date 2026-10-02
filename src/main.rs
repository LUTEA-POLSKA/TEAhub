//! The TEAhub module process.
//!
//! Binds loopback, answers `/health`, and serves the capability registry under
//! `/api/v1/teahub`. The port comes from `MLHSM_MODULE_PORT` when a host
//! injected one, so the same binary runs standalone and as an MLHSM external
//! module without a build difference.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use teahub::registry::{ENV_PORT, Registry};

struct App {
    registry: Registry,
    port: u16,
}

#[tokio::main]
async fn main() {
    let port = resolve_port();
    let root = resolve_capabilities_root();

    let app_state = Arc::new(App {
        registry: Registry::open(root),
        port,
    });

    let router = Router::new()
        .route("/health", get(health))
        .route("/api/v1/teahub/health", get(health))
        .route("/api/v1/teahub/registry", get(registry_view))
        .route("/api/v1/teahub/registry/enable/{id}", post(enable))
        .route("/api/v1/teahub/registry/disable/{id}", post(disable))
        .with_state(app_state);

    let addr = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("teahub: cannot bind {addr}: {e}");
            std::process::exit(1);
        }
    };

    println!("teahub: listening on http://{addr}");

    if let Err(e) = axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        eprintln!("teahub: server failed: {e}");
        std::process::exit(1);
    }
}

/// The port the host injected always wins.
///
/// It is not range-checked against a constant of ours: the host allocated it and
/// its proxy is already pointed at it, so binding anywhere else would put the
/// process somewhere nobody looks and look merely "up" to a health probe.
fn resolve_port() -> u16 {
    if let Ok(raw) = std::env::var(ENV_PORT) {
        if let Ok(port) = raw.trim().parse::<u16>() {
            return port;
        }
    }
    for key in ["TEAHUB_PORT", "PORT"] {
        if let Ok(raw) = std::env::var(key) {
            if let Ok(port) = raw.trim().parse::<u16>() {
                return port;
            }
        }
    }
    19_900
}

fn resolve_capabilities_root() -> PathBuf {
    if let Ok(raw) = std::env::var("TEAHUB_CAPABILITIES") {
        return PathBuf::from(raw);
    }
    PathBuf::from("capabilities")
}

async fn health(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let entries = app.registry.scan();
    Json(serde_json::json!({
        "status": "ok",
        "module": "teahub",
        "version": env!("CARGO_PKG_VERSION"),
        "port": app.port,
        "capabilities": entries.len(),
        "runnable": entries.iter().filter(|e| e.runnable).count(),
        "enabled": entries.iter().filter(|e| e.enabled).count(),
    }))
}

async fn registry_view(State(app): State<Arc<App>>) -> Json<serde_json::Value> {
    let entries = app.registry.scan();
    Json(serde_json::json!({
        "root": app.registry.root().to_string_lossy(),
        "count": entries.len(),
        "capabilities": entries,
    }))
}

async fn enable(State(app): State<Arc<App>>, axum::extract::Path(id): axum::extract::Path<String>) -> impl axum::response::IntoResponse {
    match app.registry.set_enabled(&id, true) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "id": id, "enabled": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn disable(State(app): State<Arc<App>>, axum::extract::Path(id): axum::extract::Path<String>) -> impl axum::response::IntoResponse {
    match app.registry.set_enabled(&id, false) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "id": id, "enabled": false }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": e })),
        ),
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}
