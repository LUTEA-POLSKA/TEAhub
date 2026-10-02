//! What a caller asks for, and what a model offers.
//!
//! Callers name a *requirement*, never a model id. A caller that knows which
//! vendor to use has already lost the ability to notice a better or cheaper
//! option, and a caller that hard-codes a model id breaks the moment that model
//! is retired.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Any,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostPreference {
    /// Cheapest model that satisfies the rest. What a background job wants.
    Minimal,
    Balanced,
    /// Most expensive that satisfies the rest. What a hard task wants.
    Best,
}

/// What the caller needs, not which model to use.
///
/// Every field defaults, because the obvious spelling of a requirement is
/// partial: `{"needs_tools": true}` must be a valid requirement, not a parse
/// error about the four keys nobody asked about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Requirement {
    pub effort: Effort,
    pub cost: CostPreference,
    pub needs_tools: bool,
    pub needs_vision: bool,
    pub needs_structured_output: bool,
    /// Lower bound on the usable context window, in tokens.
    pub min_context: u32,
}

impl Default for Requirement {
    fn default() -> Self {
        Self {
            effort: Effort::Any,
            cost: CostPreference::Balanced,
            needs_tools: false,
            needs_vision: false,
            needs_structured_output: false,
            min_context: 0,
        }
    }
}

impl Requirement {
    pub fn reasoning(mut self, effort: Effort) -> Self {
        self.effort = effort;
        self
    }

    pub fn cost(mut self, cost: CostPreference) -> Self {
        self.cost = cost;
        self
    }

    pub fn with_tools(mut self) -> Self {
        self.needs_tools = true;
        self
    }

    pub fn with_vision(mut self) -> Self {
        self.needs_vision = true;
        self
    }

    pub fn with_structured_output(mut self) -> Self {
        self.needs_structured_output = true;
        self
    }

    pub fn min_context(mut self, tokens: u32) -> Self {
        self.min_context = tokens;
        self
    }
}

/// What a concrete model can do. Recorded, never inferred at request time: a
/// capability discovered once and cached is a fact, and a capability guessed
/// per request is a coin toss.
///
/// `#[serde(default)]` per struct, so an omitted capability means `false`. A
/// partial block in a config file is the normal way to write one, and failing on
/// a missing `reasoning` key would make the obvious spelling the wrong one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ModelCapabilities {
    pub chat: bool,
    pub code: bool,
    pub reasoning: bool,
    pub vision: bool,
    pub tools: bool,
    pub structured_output: bool,
}

impl ModelCapabilities {
    pub const NONE: Self = Self {
        chat: false,
        code: false,
        reasoning: false,
        vision: false,
        tools: false,
        structured_output: false,
    };

    pub fn chat() -> Self {
        Self {
            chat: true,
            ..Self::NONE
        }
    }

    pub fn summary(self) -> String {
        let mut parts = Vec::new();
        for (on, name) in [
            (self.chat, "chat"),
            (self.code, "code"),
            (self.reasoning, "reasoning"),
            (self.vision, "vision"),
            (self.tools, "tools"),
            (self.structured_output, "structured"),
        ] {
            if on {
                parts.push(name);
            }
        }
        if parts.is_empty() {
            "none".into()
        } else {
            parts.join("+")
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub context_window: u32,
    pub capabilities: ModelCapabilities,
    /// Price per 1k input tokens. `None` means *unknown*, which is not the same
    /// as zero: an unknown price must never render as `$0.00`.
    pub cost_per_1k_input: Option<f64>,
    pub cost_per_1k_output: Option<f64>,
    pub enabled: bool,
}

impl ModelInfo {
    pub fn new(id: &str, provider: &str, context_window: u32) -> Self {
        Self {
            id: id.to_string(),
            provider: provider.to_string(),
            display_name: id.to_string(),
            context_window,
            capabilities: ModelCapabilities::chat(),
            cost_per_1k_input: None,
            cost_per_1k_output: None,
            enabled: true,
        }
    }

    pub fn with(mut self, capabilities: ModelCapabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    pub fn priced(mut self, input: f64, output: f64) -> Self {
        self.cost_per_1k_input = Some(input);
        self.cost_per_1k_output = Some(output);
        self
    }

    /// Cost of a call, or `None` if either price is unknown.
    pub fn cost_of(&self, input_tokens: u32, output_tokens: u32) -> Option<f64> {
        let i = self.cost_per_1k_input?;
        let o = self.cost_per_1k_output?;
        Some(
            i * (input_tokens as f64 / 1000.0) + o * (output_tokens as f64 / 1000.0),
        )
    }
}

/// A requirement this model fails, or the reasons it qualifies.
///
/// Both live in one type so a decision can be logged whole: a list of winners
/// without the losers is not explainable, and a list of losers without the
/// winners is a complaint.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub model: ModelInfo,
    pub score: i64,
    pub reasons: Vec<String>,
    pub blockers: Vec<String>,
}

impl Candidate {
    pub fn is_usable(&self) -> bool {
        self.blockers.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_price_is_not_zero() {
        let m = ModelInfo::new("m", "p", 8000);
        assert_eq!(m.cost_of(1000, 1000), None, "unknown must stay unknown");
    }

    #[test]
    fn a_known_price_multiplies_per_thousand_tokens() {
        let m = ModelInfo::new("m", "p", 8000).priced(0.001, 0.002);
        assert_eq!(m.cost_of(1000, 1000), Some(0.003));
        assert_eq!(m.cost_of(500, 250), Some(0.0010));
    }

    #[test]
    fn a_half_priced_model_is_also_unknown() {
        let mut m = ModelInfo::new("m", "p", 8000);
        m.cost_per_1k_input = Some(0.001);
        assert_eq!(m.cost_of(10, 10), None);
    }

    #[test]
    fn capability_summary_lists_only_what_is_present() {
        let c = ModelCapabilities {
            chat: true,
            reasoning: true,
            tools: true,
            ..ModelCapabilities::NONE
        };
        assert_eq!(c.summary(), "chat+reasoning+tools");
        assert_eq!(ModelCapabilities::NONE.summary(), "none");
    }

    #[test]
    fn the_requirement_builder_reads_as_sentences() {
        let r = Requirement::default()
            .reasoning(Effort::High)
            .cost(CostPreference::Minimal)
            .with_tools()
            .min_context(32_000);
        assert_eq!(r.effort, Effort::High);
        assert_eq!(r.cost, CostPreference::Minimal);
        assert!(r.needs_tools);
        assert_eq!(r.min_context, 32_000);
        assert!(!r.needs_vision, "unasked must stay unasked");
    }

    #[test]
    fn a_requirement_can_be_written_partially() {
        let r: Requirement =
            serde_json::from_str(r#"{"needs_tools":true}"#).expect("the obvious spelling");
        assert!(r.needs_tools);
        assert_eq!(r.effort, Effort::Any);
        assert_eq!(r.cost, CostPreference::Balanced);
        assert!(!r.needs_vision && r.min_context == 0);

        let empty: Requirement = serde_json::from_str("{}").expect("{} is a requirement");
        assert_eq!(empty, Requirement::default());
    }

    #[test]
    fn an_omitted_capability_means_false_rather_than_a_parse_error() {
        let c: ModelCapabilities =
            serde_json::from_str(r#"{"chat":true,"tools":true}"#).expect("a partial block");
        assert!(c.chat && c.tools);
        assert!(
            !c.reasoning && !c.vision && !c.structured_output && !c.code,
            "omitted means false"
        );
    }
}