//! The model layer.
//!
//! TEAhub talks to providers directly so it does not depend on a host being
//! present. The `ModelClient` seam is where a host adapter would later slot in;
//! nothing in this module knows that a host exists.

pub mod capability;
pub mod mesh;
pub mod openai;

use serde::{Deserialize, Serialize};

pub use capability::{
    Candidate, CostPreference, Effort, ModelCapabilities, ModelInfo, Requirement,
};
pub use mesh::{Mesh, Resolution, Usage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Message {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: content.into(),
            name: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: content.into(),
            name: None,
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            name: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub tools: Option<Vec<ToolDef>>,
    #[serde(default)]
    pub response_format: Option<serde_json::Value>,
}

impl ChatRequest {
    pub fn new(messages: Vec<Message>) -> Self {
        Self {
            messages,
            temperature: None,
            max_tokens: None,
            tools: None,
            response_format: None,
        }
    }

    pub fn asking(mut self, prompt: impl Into<String>) -> Self {
        self.messages.push(Message::user(prompt));
        self
    }

    pub fn temperature(mut self, value: f64) -> Self {
        self.temperature = Some(value);
        self
    }

    pub fn max_tokens(mut self, value: u32) -> Self {
        self.max_tokens = Some(value);
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default)]
    pub input_tokens: u32,
    #[serde(default)]
    pub output_tokens: u32,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Ok,
    Degraded,
    Down,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("no model satisfies this requirement")]
    NoCandidate,
    #[error("provider {provider:?} returned {status}: {body}")]
    Provider { provider: String, status: u16, body: String },
    #[error("provider {provider:?} could not be reached: {detail}")]
    Transport { provider: String, detail: String },
    #[error("provider {provider:?} sent a response that is not valid JSON: {detail}")]
    Malformed { provider: String, detail: String },
    #[error("provider {provider:?} has no credential configured")]
    NoCredential { provider: String },
    #[error("provider {provider:?} answered, but the answer is empty")]
    EmptyAnswer { provider: String },
}

/// One way of reaching models.
#[async_trait::async_trait]
pub trait ModelClient: Send + Sync {
    fn name(&self) -> &str;

    /// Models this client can currently serve.
    fn models(&self) -> Vec<ModelInfo>;

    /// Perform one completion. `model` was already chosen by the mesh, so the
    /// client does not get to substitute a different one.
    async fn complete(
        &self,
        model: &ModelInfo,
        request: &ChatRequest,
    ) -> Result<ChatResponse, ModelError>;

    fn health(&self) -> Health {
        Health::Ok
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_builds_from_a_prompt() {
        let r = ChatRequest::new(vec![Message::system("be terse")]).asking("hello");
        assert_eq!(r.messages.len(), 2);
        assert_eq!(r.messages[0].role, Role::System);
        assert_eq!(r.messages[1].content, "hello");
        assert!(r.tools.is_none(), "tools must stay absent, not empty");
    }
}