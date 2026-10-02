//! MLHSM's ModelMesh, reached as any other provider.
//!
//! TEAhub is not an MLHSM module and does not intend to be. This client exists
//! because ModelMesh already holds provider keys, model discovery and cost
//! accounting for this machine, and duplicating those would create two sources
//! of truth for the same secrets. It is a *consumer* of a documented HTTP API,
//! nothing more â€” if MLHSM were not running, TEAhub loses this one provider and
//! keeps every other one.
//!
//! Two details of the live API that a guess would get wrong, both read from the
//! host source rather than assumed:
//!
//! * `/chat` selects a model by `name` or `display_name`, never by the internal
//!   `id`, so the wire name is what gets sent.
//! * A failed completion is a non-200 status with the reason as a **plain text**
//!   body, not a JSON envelope. The host deliberately rejected `200` plus
//!   `{"error": ...}` because that is indistinguishable from a real answer.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::json;

use crate::model::capability::{ModelCapabilities, ModelInfo};
use crate::model::{ChatRequest, ChatResponse, Health, Message, ModelClient, ModelError, ToolCall};

pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:19090";
const TIMEOUT: Duration = Duration::from_secs(120);

/// MLHSM's own field name for tool support. It has no structured-output flag, so
/// that capability is always reported false rather than guessed.
fn map_capabilities(raw: &serde_json::Value) -> ModelCapabilities {
    let flag = |key: &str| raw.get(key).and_then(serde_json::Value::as_bool).unwrap_or(false);
    ModelCapabilities {
        chat: flag("chat"),
        code: flag("code"),
        reasoning: flag("reasoning"),
        vision: flag("vision"),
        tools: flag("function_calling"),
        structured_output: false,
    }
}

fn map_model(raw: &serde_json::Value) -> Option<ModelInfo> {
    let id = raw.get("id")?.as_str()?;
    let name = raw.get("name").and_then(|v| v.as_str()).unwrap_or(id);
    let context = raw
        .get("context_window")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as u32;
    let input = raw.get("cost_per_1k_input").and_then(|v| v.as_f64());
    let output = raw.get("cost_per_1k_output").and_then(|v| v.as_f64());

    let mut info = ModelInfo::new(id, "mlhsm", context);
    info.display_name = raw
        .get("display_name")
        .and_then(|v| v.as_str())
        .unwrap_or(name)
        .to_string();
    info.enabled = raw
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    info.capabilities = raw
        .get("capabilities")
        .map(map_capabilities)
        .unwrap_or_else(ModelCapabilities::chat);
    if let (Some(i), Some(o)) = (input, output) {
        info = info.priced(i, o);
    }
    // The wire name is what `/chat` accepts, so it travels alongside the id.
    info.display_name = name.to_string();
    Some(info)
}

fn map_message(role: &str, content: &str) -> serde_json::Value {
    json!({ "role": role, "content": content })
}

fn role_wire(role: crate::model::Role) -> &'static str {
    use crate::model::Role;
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

pub struct MlhsmClient {
    base_url: String,
    token: String,
    models: Vec<ModelInfo>,
    http: reqwest::Client,
}

impl MlhsmClient {
    pub fn new(base_url: &str, token: &str, models: Vec<ModelInfo>) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            token: token.to_string(),
            models,
            http: reqwest::Client::builder()
                .timeout(TIMEOUT)
                .build()
                .expect("a client with a valid timeout"),
        }
    }

    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        if let Ok(value) = format!("Bearer {}", self.token).parse() {
            headers.insert(AUTHORIZATION, value);
        }
        headers
    }

    /// Read the host's model registry.
    ///
    /// A snapshot taken once, which is what the mesh expects: a capability
    /// rediscovered per request is a guess, and a rediscovered *price* is worse.
    pub async fn fetch_models(base_url: &str, token: &str) -> Result<Vec<ModelInfo>, ModelError> {
        let url = format!("{}/api/v1/modelmesh/models", base_url.trim_end_matches('/'));
        let text = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .map_err(|e| ModelError::Transport {
                provider: "mlhsm".into(),
                detail: e.to_string(),
            })?
            .get(&url)
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| ModelError::Transport {
                provider: "mlhsm".into(),
                detail: e.to_string(),
            })?
            .text()
            .await
            .map_err(|e| ModelError::Transport {
                provider: "mlhsm".into(),
                detail: e.to_string(),
            })?;

        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| ModelError::Malformed {
            provider: "mlhsm".into(),
            detail: e.to_string(),
        })?;

        Ok(parsed.as_array().map(|items| items.iter().filter_map(map_model).collect()).unwrap_or_default())
    }
}

#[async_trait::async_trait]
impl ModelClient for MlhsmClient {
    fn name(&self) -> &str {
        "mlhsm"
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }

    fn health(&self) -> Health {
        if self.models.is_empty() {
            Health::Down
        } else {
            Health::Ok
        }
    }

    async fn complete(
        &self,
        model: &ModelInfo,
        request: &ChatRequest,
    ) -> Result<ChatResponse, ModelError> {
        let messages: Vec<serde_json::Value> = request
            .messages
            .iter()
            .map(|m: &Message| map_message(role_wire(m.role), &m.content))
            .collect();

        let mut body = json!({
            "model": model.display_name,
            "messages": messages,
        });
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        if let Some(m) = request.max_tokens {
            body["max_tokens"] = json!(m);
        }
        if let Some(tools) = &request.tools {
            body["tools"] = json!(tools
                .iter()
                .map(|t| json!({"type": "function", "function": {
                    "name": t.name, "description": t.description, "parameters": t.parameters
                }}))
                .collect::<Vec<_>>());
        }

        let url = format!("{}/api/v1/modelmesh/chat", self.base_url);
        let sent = self
            .http
            .post(&url)
            .headers(self.headers())
            .json(&body)
            .send()
            .await
            .map_err(|e| ModelError::Transport {
                provider: "mlhsm".into(),
                detail: e.to_string(),
            })?;

        let status = sent.status();
        let text = sent.text().await.map_err(|e| ModelError::Transport {
            provider: "mlhsm".into(),
            detail: e.to_string(),
        })?;

        if !status.is_success() {
            // The host sends the reason as plain text here, not as JSON.
            return Err(ModelError::Provider {
                provider: "mlhsm".into(),
                status: status.as_u16(),
                body: text.trim().chars().take(400).collect(),
            });
        }

        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| ModelError::Malformed {
            provider: "mlhsm".into(),
            detail: e.to_string(),
        })?;

        let content = parsed["content"].as_str().unwrap_or_default().to_string();
        let mut tool_calls = Vec::new();
        if let Some(calls) = parsed["tool_calls"].as_array() {
            for call in calls {
                tool_calls.push(ToolCall {
                    id: call["id"].as_str().unwrap_or_default().to_string(),
                    name: call["function"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    arguments: call["function"]["arguments"].clone(),
                });
            }
        }

        if content.trim().is_empty() && tool_calls.is_empty() {
            return Err(ModelError::EmptyAnswer {
                provider: "mlhsm".into(),
            });
        }

        Ok(ChatResponse {
            content,
            tool_calls,
            input_tokens: parsed["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32,
            output_tokens: parsed["usage"]["output_tokens"].as_u64().unwrap_or(0) as u32,
            model: parsed["model"].as_str().unwrap_or(&model.display_name).to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use axum::Router;

    #[test]
    fn function_calling_maps_onto_tools_and_structured_output_stays_false() {
        let caps = map_capabilities(&json!({
            "chat": true, "code": true, "reasoning": true,
            "vision": false, "function_calling": true
        }));
        assert!(caps.tools, "MLHSM calls it function_calling");
        assert!(caps.chat && caps.code && caps.reasoning);
        assert!(!caps.vision);
        assert!(
            !caps.structured_output,
            "the host has no such flag, so it must not be invented"
        );
    }

    #[test]
    fn a_missing_capability_flag_is_false_rather_than_missing() {
        let caps = map_capabilities(&json!({ "chat": true }));
        assert!(caps.chat);
        assert!(!caps.tools && !caps.vision && !caps.code);
    }

    #[test]
    fn the_wire_name_is_carried_so_chat_can_address_the_model() {
        let model = map_model(&json!({
            "id": "uuid-1234",
            "name": "llama3.1:8b",
            "display_name": "Llama 3.1 8B",
            "enabled": true,
            "context_window": 128000,
            "cost_per_1k_input": 0.0,
            "cost_per_1k_output": 0.0,
            "capabilities": {"chat": true}
        }))
        .expect("model");

        assert_eq!(model.id, "uuid-1234", "identity stays the internal id");
        assert_eq!(
            model.display_name, "llama3.1:8b",
            "/chat selects by name or display_name, so the wire name must travel"
        );
        assert_eq!(model.context_window, 128000);
        assert_eq!(model.cost_of(1000, 1000), Some(0.0), "an explicit zero is a price");
    }

    #[test]
    fn a_model_without_an_id_is_skipped_rather_than_half_parsed() {
        assert!(map_model(&json!({"name": "nameless"})).is_none());
    }

    #[test]
    fn a_half_priced_host_model_stays_unknown() {
        let model = map_model(&json!({
            "id": "a", "name": "a", "context_window": 1000,
            "cost_per_1k_input": 0.001
        }))
        .expect("model");
        assert_eq!(model.cost_of(10, 10), None);
    }

    async fn spawn(models: serde_json::Value, chat: serde_json::Value) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new()
            .route("/api/v1/modelmesh/models", get(move || async move { axum::Json(models.clone()) }))
            .route("/api/v1/modelmesh/chat", post(move || async move { axum::Json(chat.clone()) }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), handle)
    }

    #[tokio::test]
    async fn the_host_model_list_is_read_into_the_local_catalog() {
        let (base, _s) = spawn(
            json!([{
                "id": "u1", "name": "free-model", "display_name": "Free",
                "enabled": true, "context_window": 32768,
                "cost_per_1k_input": 0.0, "cost_per_1k_output": 0.0,
                "capabilities": {"chat": true, "function_calling": true}
            }]),
            json!({}),
        )
        .await;

        let models = MlhsmClient::fetch_models(&base, "tok").await.expect("reads");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].display_name, "free-model");
        assert!(models[0].capabilities.tools);
    }

    #[tokio::test]
    async fn a_completion_returns_content_and_usage() {
        let (base, _s) = spawn(
            json!([]),
            json!({
                "content": "hallo von mlhsm",
                "model": "free-model",
                "usage": {"input_tokens": 20, "output_tokens": 8, "latency_ms": 340},
                "routing": {"task_category": "Chat", "complexity": 0.5, "reason": "jev"}
            }),
        )
        .await;

        let client = MlhsmClient::new(&base, "tok", Vec::new());
        let model = ModelInfo::new("u1", "mlhsm", 32768);
        let response = client
            .complete(&model, &ChatRequest::new(vec![Message::user("hi")]))
            .await
            .expect("completes");

        assert_eq!(response.content, "hallo von mlhsm");
        assert_eq!(response.model, "free-model");
        assert_eq!(response.input_tokens, 20);
        assert_eq!(response.output_tokens, 8);
    }

    #[tokio::test]
    async fn a_non_200_carries_a_plain_text_reason() {
        let app = Router::new().route(
            "/api/v1/modelmesh/chat",
            post(|| async {
                (
                    axum::http::StatusCode::BAD_GATEWAY,
                    "Modell 'x' ist nicht verfuegbar. Verfuegbar: keine",
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let _server = tokio::spawn(async move { axum::serve(listener, app).await });

        let client = MlhsmClient::new(&format!("http://{addr}"), "tok", Vec::new());
        let model = ModelInfo::new("u1", "mlhsm", 32768);
        let err = client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect_err("502 is not an answer");

        match err {
            ModelError::Provider { status, body, .. } => {
                assert_eq!(status, 502);
                assert!(body.contains("nicht verfuegbar"), "the reason must survive: {body}");
            }
            other => panic!("expected a provider error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_empty_model_list_means_down_rather_than_a_healthy_empty_provider() {
        let client = MlhsmClient::new("http://127.0.0.1:1", "tok", Vec::new());
        assert_eq!(client.health(), Health::Down);
        let with_models = MlhsmClient::new(
            "http://127.0.0.1:1",
            "tok",
            vec![ModelInfo::new("m", "mlhsm", 1000)],
        );
        assert_eq!(with_models.health(), Health::Ok);
    }

    #[test]
    fn the_token_is_sent_as_a_bearer_header() {
        let client = MlhsmClient::new("http://x", "secret-token", Vec::new());
        assert_eq!(client.headers()[AUTHORIZATION], "Bearer secret-token");
    }
}