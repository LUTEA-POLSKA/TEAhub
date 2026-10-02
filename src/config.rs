//! Provider configuration.
//!
//! Secrets never live in the config file. A capability manifest may ask for
//! `secret.use`, but a provider credential is the operator's own and is read
//! from the environment under `TEAHUB_KEY_<NAME>`. A config file that can be
//! committed is a config file that eventually is.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::model::capability::{ModelCapabilities, ModelInfo};
use crate::model::openai::OpenAiCompatible;
use crate::model::{Health, Mesh, ModelClient};

pub const CONFIG_FILE: &str = "providers.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    pub id: String,
    #[serde(default = "default_context")]
    pub context_window: u32,
    #[serde(default)]
    pub capabilities: Option<ModelCapabilities>,
    #[serde(default)]
    pub cost_per_1k_input: Option<f64>,
    #[serde(default)]
    pub cost_per_1k_output: Option<f64>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn default_context() -> u32 {
    8192
}
fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("cannot read {path}: {source}")]
    Read {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{path} is not valid JSON: {source}")]
    Parse {
        path: String,
        #[source]
        source: serde_json::Error,
    },
    #[error("provider {0:?} has no models, so it serves nothing")]
    NoModels(String),
}

impl Config {
    pub fn load(root: &Path) -> Result<Self, ConfigError> {
        let path = root.join(CONFIG_FILE);
        let raw = std::fs::read_to_string(&path).map_err(|e| ConfigError::Read {
            path: path.display().to_string(),
            source: e,
        })?;
        serde_json::from_str(&raw).map_err(|e| ConfigError::Parse {
            path: path.display().to_string(),
            source: e,
        })
    }

    pub fn from_json(raw: &str) -> Result<Self, ConfigError> {
        serde_json::from_str(raw).map_err(|e| ConfigError::Parse {
            path: CONFIG_FILE.into(),
            source: e,
        })
    }

    /// Build the mesh. A provider whose key is missing is skipped with a
    /// reason rather than added in a broken state: a client that cannot
    /// authenticate should not appear in the catalog as usable.
    pub fn mesh(&self) -> (Mesh, Vec<String>) {
        let mut clients: Vec<Arc<dyn ModelClient>> = Vec::new();
        let mut notes = Vec::new();

        for provider in &self.providers {
            if provider.models.is_empty() {
                notes.push(format!(
                    "provider {:?} has no models configured, so it was skipped",
                    provider.name
                ));
                continue;
            }

            let key = provider
                .api_key_env
                .as_ref()
                .and_then(|name| std::env::var(name).ok())
                .filter(|value| !value.trim().is_empty());

            if let Some(env_name) = &provider.api_key_env {
                if key.is_none() {
                    notes.push(format!(
                        "provider {:?} needs ${env_name}, which is not set, so it was skipped",
                        provider.name
                    ));
                    continue;
                }
            }

            let models: Vec<ModelInfo> = provider
                .models
                .iter()
                .map(|m| {
                    let mut info = ModelInfo::new(&m.id, &provider.name, m.context_window);
                    info.enabled = m.enabled;
                    info.capabilities = m
                        .capabilities
                        .or(provider.capabilities)
                        .unwrap_or_else(ModelCapabilities::chat);
                    if m.cost_per_1k_input.is_some() && m.cost_per_1k_output.is_some() {
                        info = info.priced(
                            m.cost_per_1k_input.unwrap_or(0.0),
                            m.cost_per_1k_output.unwrap_or(0.0),
                        );
                    }
                    info
                })
                .collect();

            clients.push(Arc::new(OpenAiCompatible::new(
                &provider.name,
                &provider.base_url,
                key,
                models,
            )));
        }

        (Mesh::new(clients), notes)
    }
}

/// What the mesh currently serves, for display.
pub fn catalog(mesh: &Mesh) -> Vec<(String, ModelInfo, Health)> {
    mesh.catalog()
        .into_iter()
        .map(|(client, model)| (client.name().to_string(), model, client.health()))
        .collect()
}

pub fn provider_names(mesh: &Mesh) -> BTreeMap<String, String> {
    mesh.catalog()
        .into_iter()
        .map(|(client, model)| (model.id, client.name().to_string()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(providers: &str) -> Config {
        Config::from_json(&format!(r#"{{"providers":[{{{providers}}}]}}"#)).expect("config")
    }

    #[test]
    fn a_provider_without_models_is_skipped_with_a_reason() {
        let config = raw(r#""name":"empty","base_url":"http://x/v1","models":[]"#);
        let (mesh, notes) = config.mesh();
        assert_eq!(mesh.catalog().len(), 0);
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("no models"), "{notes:?}");
    }

    #[test]
    fn a_provider_whose_key_is_missing_is_skipped_rather_than_broken() {
        let config = raw(
            r#""name":"remote","base_url":"http://x/v1","api_key_env":"TEAHUB_TEST_ABSENT",
               "models":[{"id":"m"}]"#,
        );
        let (mesh, notes) = config.mesh();
        assert_eq!(mesh.catalog().len(), 0, "a client that cannot authenticate is not usable");
        assert!(notes[0].contains("TEAHUB_TEST_ABSENT"), "{notes:?}");
    }

    #[test]
    fn a_local_provider_needs_no_key_and_is_not_skipped() {
        let config = raw(r#""name":"ollama","base_url":"http://127.0.0.1:11434/v1","models":[{"id":"llama3"}]"#);
        let (mesh, notes) = config.mesh();
        assert!(notes.is_empty(), "{notes:?}");
        assert_eq!(mesh.catalog().len(), 1);
        assert_eq!(mesh.catalog()[0].1.provider, "ollama");
    }

    #[test]
    fn a_partially_priced_model_stays_unknown_rather_than_half_free() {
        let config = raw(
            r#""name":"p","base_url":"http://x/v1",
               "models":[{"id":"m","cost_per_1k_input":0.001}]"#,
        );
        let (_, notes) = config.mesh();
        let (_, model, _) = catalog(&config.mesh().0).remove(0);
        assert!(model.cost_of(100, 100).is_none(), "half a price is no price");
        let _ = notes;
    }

    #[test]
    fn provider_capabilities_are_the_default_and_model_capabilities_override() {
        let config = raw(
            r#""name":"p","base_url":"http://x/v1",
               "capabilities":{"chat":true,"code":true,"tools":true},
               "models":[{"id":"plain"},{"id":"sharp","capabilities":{"chat":true,"vision":true}}]"#,
        );
        let (_, notes) = config.mesh();
        let (_, plain, _) = catalog(&config.mesh().0)
            .into_iter()
            .find(|(_, m, _)| m.id == "plain")
            .expect("plain");
        let (_, sharp, _) = catalog(&config.mesh().0)
            .into_iter()
            .find(|(_, m, _)| m.id == "sharp")
            .expect("sharp");
        assert!(plain.capabilities.code, "inherits the provider default");
        assert!(!plain.capabilities.vision);
        assert!(sharp.capabilities.vision, "overrides the provider default");
        assert!(!sharp.capabilities.code);
        let _ = notes;
    }

    #[test]
    fn a_disabled_model_stays_in_the_catalog_but_is_not_selected() {
        let config = raw(
            r#""name":"p","base_url":"http://x/v1",
               "models":[{"id":"on"},{"id":"off","enabled":false}]"#,
        );
        let mesh = config.mesh().0;
        assert_eq!(mesh.catalog().len(), 2, "it is visible");
        let resolution = mesh.resolve(&crate::model::Requirement::default());
        assert_eq!(resolution.chosen().unwrap().id, "on");
        assert!(resolution
            .blocked()
            .iter()
            .any(|c| c.model.id == "off" && c.blockers.iter().any(|b| b.contains("disabled"))));
    }

    #[test]
    fn an_empty_config_yields_an_empty_mesh_without_erroring() {
        let config = Config::from_json(r#"{"providers":[]}"#).expect("config");
        let (mesh, notes) = config.mesh();
        assert!(mesh.catalog().is_empty());
        assert!(notes.is_empty());
    }
}