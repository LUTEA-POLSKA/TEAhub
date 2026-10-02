//! An OpenAI-compatible provider.
//!
//! One wire format covers a lot of ground â€” Ollama, LM Studio, vLLM,
//! OpenRouter, Groq, Together and OpenAI itself all speak `/v1/chat/completions`
//! with the same body. That is why this is a single client rather than a
//! hand-rolled adapter per vendor: a vendor that speaks the dialect costs one
//! configuration line, not a module.
//!
//! A vendor that does not speak it needs its own client, and that is the seam
//! `ModelClient` exists for.

use std::time::Duration;

use serde_json::json;

use crate::model::capability::{ModelCapabilities, ModelInfo};
use crate::model::{
    ChatRequest, ChatResponse, Health, Message, ModelClient, ModelError, Role, ToolCall,
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

pub struct OpenAiCompatible {
    name: String,
    base_url: String,
    api_key: Option<String>,
    models: Vec<ModelInfo>,
    http: reqwest::Client,
    health: Health,
}

impl OpenAiCompatible {
    /// `api_key` is optional on purpose: a local Ollama needs none, and forcing
    /// a dummy secret into a local endpoint teaches the operator to paste
    /// credentials where they do not belong.
    pub fn new(
        name: &str,
        base_url: &str,
        api_key: Option<String>,
        models: Vec<ModelInfo>,
    ) -> Self {
        Self {
            name: name.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key,
            models,
            http: reqwest::Client::builder()
                .timeout(DEFAULT_TIMEOUT)
                .build()
                .expect("a client with a valid timeout"),
            health: Health::Ok,
        }
    }

    pub fn with_capability(mut self, capability: ModelCapabilities) -> Self {
        for model in &mut self.models {
            model.capabilities = capability;
        }
        self
    }

    pub fn mark_down(&mut self) {
        self.health = Health::Down;
    }

    fn auth_headers(&self, headers: &mut reqwest::header::HeaderMap) {
        if let Some(key) = &self.api_key {
            if let Ok(value) = format!("Bearer {key}").parse() {
                headers.insert(reqwest::header::AUTHORIZATION, value);
            }
        }
    }

    fn wire_messages(messages: &[Message]) -> Vec<serde_json::Value> {
        messages
            .iter()
            .map(|m| {
                let mut out = json!({ "role": role_wire(m.role), "content": m.content });
                if let Some(name) = &m.name {
                    out["name"] = json!(name);
                }
                out
            })
            .collect()
    }
}

/// Tool arguments arrive as a JSON-encoded *string*, not as an object.
///
/// Parse them when they parse. When they do not, keep the string: a model that
/// emitted malformed JSON should cost the caller a runtime error on their side
/// with the original text still in hand, not a silent loss of the arguments.
fn parse_arguments(raw: Option<&serde_json::Value>) -> serde_json::Value {
    match raw {
        Some(serde_json::Value::String(text)) => serde_json::from_str(text)
            .unwrap_or_else(|_| serde_json::Value::String(text.clone())),
        Some(other) => other.clone(),
        None => serde_json::Value::Null,
    }
}

fn role_wire(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

#[async_trait::async_trait]
impl ModelClient for OpenAiCompatible {
    fn name(&self) -> &str {
        &self.name
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }

    fn health(&self) -> Health {
        self.health
    }

    async fn complete(
        &self,
        model: &ModelInfo,
        request: &ChatRequest,
    ) -> Result<ChatResponse, ModelError> {
        let mut body = json!({
            "model": model.id,
            "messages": Self::wire_messages(&request.messages),
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
        if let Some(format) = &request.response_format {
            body["response_format"] = format.clone();
        }

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            "application/json".parse().expect("static header"),
        );
        self.auth_headers(&mut headers);

        let url = format!("{}/chat/completions", self.base_url);
        let sent = self
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await
            .map_err(|e| ModelError::Transport {
                provider: self.name.clone(),
                detail: e.to_string(),
            })?;

        let status = sent.status();
        let text = sent.text().await.map_err(|e| ModelError::Transport {
            provider: self.name.clone(),
            detail: e.to_string(),
        })?;

        if !status.is_success() {
            return Err(ModelError::Provider {
                provider: self.name.clone(),
                status: status.as_u16(),
                body: text.chars().take(400).collect(),
            });
        }

        let parsed: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| ModelError::Malformed {
                provider: self.name.clone(),
                detail: e.to_string(),
            })?;

        let choice = parsed["choices"][0]
            .get("message")
            .cloned()
            .ok_or_else(|| ModelError::Malformed {
                provider: self.name.clone(),
                detail: "response has no choices[0].message".into(),
            })?;

        let content = choice["content"].as_str().unwrap_or_default().to_string();
        let mut tool_calls = Vec::new();
        if let Some(calls) = choice["tool_calls"].as_array() {
for call in calls {
                    tool_calls.push(ToolCall {
                        id: call["id"].as_str().unwrap_or_default().to_string(),
                        name: call["function"]["name"].as_str().unwrap_or_default().to_string(),
                        arguments: parse_arguments(call["function"].get("arguments")),
                    });
                }
        }

        if content.trim().is_empty() && tool_calls.is_empty() {
            return Err(ModelError::EmptyAnswer {
                provider: self.name.clone(),
            });
        }

        Ok(ChatResponse {
            content,
            tool_calls,
            input_tokens: parsed["usage"]["prompt_tokens"].as_u64().unwrap_or(0) as u32,
            output_tokens: parsed["usage"]["completion_tokens"].as_u64().unwrap_or(0) as u32,
            model: model.id.clone(),
        })
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;
    use crate::model::ModelClient;
    use axum::routing::post;
    use axum::Router;

    async fn spawn(body: serde_json::Value, status: u16) -> (String, tokio::task::JoinHandle<()>) {
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let body = body.clone();
                let status = status;
                async move {
                    (
                        axum::http::StatusCode::from_u16(status).unwrap(),
                        axum::Json(body),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("ephemeral port");
        let addr = listener.local_addr().expect("addr");
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}/v1"), handle)
    }

    fn client_for(base_url: &str) -> OpenAiCompatible {
        OpenAiCompatible::new(
            "wire",
            base_url,
            Some("test-key".into()),
            vec![ModelInfo::new("test-model", "wire", 8192).with(ModelCapabilities::chat())],
        )
    }

    #[tokio::test]
    async fn a_well_formed_answer_is_parsed_into_content_and_usage() {
        let (base, _server) = spawn(
            json!({
                "choices": [{"message": {"role": "assistant", "content": "hello there"}}],
                "usage": {"prompt_tokens": 42, "completion_tokens": 7}
            }),
            200,
        )
        .await;

        let client = client_for(&base);
        let model = client.models().remove(0);
        let response = client
            .complete(&model, &ChatRequest::new(vec![Message::user("hi")]))
            .await
            .expect("completes");

        assert_eq!(response.content, "hello there");
        assert_eq!(response.input_tokens, 42);
        assert_eq!(response.output_tokens, 7);
        assert_eq!(response.model, "test-model");
    }

    #[tokio::test]
    async fn tool_calls_are_parsed_even_when_there_is_no_text() {
        let (base, _server) = spawn(
            json!({
                "choices": [{"message": {"role": "assistant", "content": null,
                    "tool_calls": [{"id": "call_1", "function": {
                        "name": "search", "arguments": "{\"q\":\"rust\"}"}}]}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3}
            }),
            200,
        )
        .await;

        let client = client_for(&base);
        let model = client.models().remove(0);
        let response = client
            .complete(&model, &ChatRequest::new(vec![Message::user("search")]))
            .await
            .expect("a tool call is an answer");

        assert_eq!(response.tool_calls.len(), 1);
        assert_eq!(response.tool_calls[0].name, "search");
        assert_eq!(response.tool_calls[0].arguments["q"], "rust");
    }

    #[tokio::test]
    async fn an_http_error_is_surfaced_with_its_status() {
        let (base, _server) = spawn(json!({"error": "invalid api key"}), 401).await;
        let client = client_for(&base);
        let model = client.models().remove(0);
        let err = client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect_err("401 is not a success");
        match err {
            ModelError::Provider { status, body, .. } => {
                assert_eq!(status, 401);
                assert!(body.contains("invalid api key"), "{body}");
            }
            other => panic!("expected a provider error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_json_body_without_a_message_is_reported_as_malformed() {
        let (base, _server) = spawn(json!({"choices": []}), 200).await;
        let client = client_for(&base);
        let model = client.models().remove(0);
        let err = client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect_err("no message is not an answer");
        assert!(
            matches!(err, ModelError::Malformed { .. }),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn an_answer_with_neither_text_nor_tools_is_not_an_answer() {
        let (base, _server) = spawn(
            json!({"choices": [{"message": {"role": "assistant", "content": "   "}}]}),
            200,
        )
        .await;
        let client = client_for(&base);
        let model = client.models().remove(0);
        let err = client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect_err("whitespace is not an answer");
        assert!(matches!(err, ModelError::EmptyAnswer { .. }), "got {err:?}");
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_a_transport_error_not_a_panic() {
        let client = OpenAiCompatible::new(
            "dead",
            "http://127.0.0.1:1/v1",
            None,
            vec![ModelInfo::new("m", "dead", 4096)],
        );
        let model = client.models().remove(0);
        let err = client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect_err("nothing is listening on port 1");
        assert!(matches!(err, ModelError::Transport { .. }), "got {err:?}");
    }

    #[tokio::test]
    async fn a_request_reaches_the_server_with_the_bearer_token_attached() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: axum::http::HeaderMap, body: axum::Json<serde_json::Value>| {
                let tx = tx.clone();
                async move {
                    let _ = tx.send((headers, body));
                    (
                        axum::http::StatusCode::OK,
                        axum::Json(json!({"choices": [{"message": {"content": "ok"}}]})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let client = client_for(&format!("http://{addr}/v1"));
        let model = client.models().remove(0);
        client
            .complete(
                &model,
                &ChatRequest::new(vec![Message::user("hi")]).temperature(0.2),
            )
            .await
            .expect("completes");

        let (headers, body) = rx.recv().await.expect("request observed");
        assert_eq!(
            headers["authorization"],
            "Bearer test-key",
            "the credential must be sent to the provider"
        );
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["messages"][0]["content"], "hi");
        assert_eq!(body["temperature"], 0.2);
        server.abort();
    }

    #[tokio::test]
    async fn a_local_provider_without_a_credential_sends_no_authorization_header() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: axum::http::HeaderMap, _body: axum::Json<serde_json::Value>| {
                let tx = tx.clone();
                async move {
                    let _ = tx.send(headers);
                    (
                        axum::http::StatusCode::OK,
                        axum::Json(json!({"choices": [{"message": {"content": "ok"}}]})),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await });

        let client = OpenAiCompatible::new(
            "local",
            &format!("http://{addr}/v1"),
            None,
            vec![ModelInfo::new("llama3", "local", 8192)],
        );
        let model = client.models().remove(0);
        client
            .complete(&model, &ChatRequest::new(vec![]))
            .await
            .expect("completes");

        let headers = rx.recv().await.expect("request observed");
        assert!(
            !headers.contains_key("authorization"),
            "a local endpoint must not be handed a credential it did not ask for"
        );
        server.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ToolDef;

    fn client() -> OpenAiCompatible {
        OpenAiCompatible::new(
            "local",
            "http://127.0.0.1:1/v1",
            None,
            vec![ModelInfo::new("llama3", "local", 8192)],
        )
    }

    #[test]
    fn tool_arguments_are_parsed_when_they_parse_and_kept_when_they_do_not() {
        let good = json!({"q": "rust"});
        assert_eq!(
            parse_arguments(Some(&json!("{\"q\":\"rust\"}"))),
            good,
            "a well-formed argument string is parsed"
        );

        let broken = parse_arguments(Some(&json!("{not json")));
        assert_eq!(
            broken,
            json!("{not json"),
            "malformed arguments must survive as text, not be dropped"
        );

        assert_eq!(parse_arguments(Some(&good)), good, "an object passes through");
        assert_eq!(parse_arguments(None), json!(null));
    }

    #[test]
    fn a_trailing_slash_on_the_base_url_is_normalised() {
        let c = OpenAiCompatible::new("p", "http://x/v1/", None, vec![]);
        assert_eq!(c.base_url, "http://x/v1");
    }

    #[test]
    fn a_local_provider_needs_no_credential() {
        let c = client();
        assert!(c.api_key.is_none());
        assert_eq!(c.health(), Health::Ok);
    }

    #[test]
    fn wire_messages_render_every_role() {
        let messages = vec![
            Message::system("s"),
            Message::user("u"),
            Message::assistant("a"),
        ];
        let wire = OpenAiCompatible::wire_messages(&messages);
        assert_eq!(wire[0]["role"], "system");
        assert_eq!(wire[1]["role"], "user");
        assert_eq!(wire[2]["role"], "assistant");
    }

    #[test]
    fn a_tool_definition_is_sent_as_an_openai_function_tool() {
        let tool = ToolDef {
            name: "search".into(),
            description: "search the web".into(),
            parameters: json!({"type": "object"}),
        };
        let rendered = json!({"type": "function", "function": {
            "name": tool.name, "description": tool.description, "parameters": tool.parameters
        }});
        assert_eq!(rendered["type"], "function");
        assert_eq!(rendered["function"]["name"], "search");
    }
}