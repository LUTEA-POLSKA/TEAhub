//! Requirement-based selection with fallback.
//!
//! The mesh does not pick a model; it produces an *ordered list with reasons* and
//! tries them in turn. Two consequences matter more than the ranking quality:
//! a decision can be explained after the fact, and a provider that is down costs
//! one failed attempt rather than the whole request.

use std::cmp::Ordering;
use std::sync::Arc;

use crate::model::capability::{Candidate, CostPreference, Effort, ModelInfo, Requirement};
use crate::model::{ChatRequest, ChatResponse, Health, ModelClient, ModelError};

/// Why a model was chosen, and what was tried first.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolution {
    pub candidates: Vec<Candidate>,
}

impl Resolution {
    pub fn chosen(&self) -> Option<&ModelInfo> {
        self.candidates
            .iter()
            .find(|c| c.is_usable())
            .map(|c| &c.model)
    }

    pub fn blocked(&self) -> Vec<&Candidate> {
        self.candidates.iter().filter(|c| !c.is_usable()).collect()
    }

    pub fn explain(&self) -> String {
        if self.candidates.is_empty() {
            return "no models are registered".into();
        }
        let mut out = String::new();
        for (rank, c) in self.candidates.iter().filter(|c| c.is_usable()).enumerate() {
            out.push_str(&format!(
                "#{rank} {} (score {})",
                c.model.id, c.score
            ));
            if !c.reasons.is_empty() {
                out.push_str(&format!(" â€” {}", c.reasons.join(", ")));
            }
            out.push('\n');
        }
        for c in self.blocked() {
            out.push_str(&format!(
                "blocked {} â€” {}\n",
                c.model.id,
                c.blockers.join("; ")
            ));
        }
        out.trim_end().to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    /// `None` when the chosen model's price is unknown. Never `Some(0.0)` for
    /// "free": unknown must not render as free.
    pub cost_usd: Option<f64>,
}

pub struct Mesh {
    clients: Vec<Arc<dyn ModelClient>>,
}

impl Mesh {
    pub fn new(clients: Vec<Arc<dyn ModelClient>>) -> Self {
        Self { clients }
    }

    pub fn with_client(mut self, client: Arc<dyn ModelClient>) -> Self {
        self.clients.push(client);
        self
    }

    /// Every model every client currently serves, with the client that serves it.
    pub fn catalog(&self) -> Vec<(Arc<dyn ModelClient>, ModelInfo)> {
        let mut out = Vec::new();
        for client in &self.clients {
            for model in client.models() {
                out.push((Arc::clone(client), model));
            }
        }
        out
    }

    pub fn resolve(&self, requirement: &Requirement) -> Resolution {
        let mut candidates: Vec<Candidate> = self
            .catalog()
            .into_iter()
            .map(|(_, model)| score(model, requirement))
            .collect();

        candidates.sort_by(|a, b| rank(a, b, requirement));
        Resolution { candidates }
    }

    /// Try the resolved order until one answers.
    ///
    /// The failure of an earlier candidate is reported even when a later one
    /// succeeds: a run that quietly lost its preferred provider is a run whose
    /// evidence is wrong.
    pub async fn complete(
        &self,
        requirement: &Requirement,
        request: &ChatRequest,
    ) -> Result<(ChatResponse, Resolution, Usage), ModelError> {
        let resolution = self.resolve(requirement);
        if resolution.chosen().is_none() {
            return Err(ModelError::NoCandidate);
        }

        let by_id: Vec<(Arc<dyn ModelClient>, ModelInfo)> = self.catalog();
        let mut last: Option<ModelError> = None;

        for candidate in resolution.candidates.iter().filter(|c| c.is_usable()) {
            let Some((client, model)) = by_id
                .iter()
                .find(|(_, m)| m.id == candidate.model.id && m.provider == candidate.model.provider)
            else {
                continue;
            };
            if client.health() == Health::Down {
                last = Some(ModelError::Transport {
                    provider: client.name().to_string(),
                    detail: "client is marked down".into(),
                });
                continue;
            }

            match client.complete(model, request).await {
                Ok(response) => {
                    let usage = Usage {
                        input_tokens: response.input_tokens,
                        output_tokens: response.output_tokens,
                        cost_usd: model.cost_of(response.input_tokens, response.output_tokens),
                    };
                    return Ok((response, resolution, usage));
                }
                Err(e) => last = Some(e),
            }
        }

        Err(last.unwrap_or(ModelError::NoCandidate))
    }
}

/// Order two candidates against one requirement.
///
/// Cost is a *comparison* between candidates, not a property of one model, so it
/// is applied here rather than baked into [`score`]. Baking it in cannot work:
/// real prices span `0.0001` to `0.05` per 1k tokens, and any linear scale wide
/// enough for that range rounds every realistic pair to the same number.
///
/// A model whose price is unknown is neither promoted nor demoted by price
/// alone. Under a cost preference it sorts last among equal candidates, because
/// "unpriced" cannot be shown to satisfy "cheapest" — but it is never excluded,
/// because excluding it would hide a possibly-free model instead of admitting we
/// cannot tell.
fn rank(a: &Candidate, b: &Candidate, requirement: &Requirement) -> Ordering {
    b.score.cmp(&a.score).then_with(|| {
        let (ca, cb) = (
            a.model.cost_of(1000, 1000),
            b.model.cost_of(1000, 1000),
        );
        match requirement.cost {
            CostPreference::Minimal => match (ca, cb) {
                (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            },
            CostPreference::Best => match (ca, cb) {
                (Some(x), Some(y)) => y.partial_cmp(&x).unwrap_or(Ordering::Equal),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            },
            CostPreference::Balanced => Ordering::Equal,
        }
    })
    .then_with(|| a.model.id.cmp(&b.model.id))
    .then_with(|| a.model.provider.cmp(&b.model.provider))
}

/// Score one model against one requirement.
///
/// Integer points on capability and effort only. Deliberately free of price, so
/// the same score means the same thing regardless of what a provider charges
/// this month.
pub fn score(model: ModelInfo, requirement: &Requirement) -> Candidate {
    let mut reasons = Vec::new();
    let mut blockers = Vec::new();
    let mut points: i64 = 0;

    if !model.enabled {
        blockers.push("disabled in the local registry".into());
    }
    if !model.capabilities.chat {
        blockers.push("not a chat model".into());
    }
    if requirement.needs_tools && !model.capabilities.tools {
        blockers.push("no tool calling".into());
    }
    if requirement.needs_vision && !model.capabilities.vision {
        blockers.push("no vision".into());
    }
    if requirement.needs_structured_output && !model.capabilities.structured_output {
        blockers.push("no structured output".into());
    }
    if requirement.min_context > 0 && model.context_window < requirement.min_context {
        blockers.push(format!(
            "context {} is below the required {}",
            model.context_window, requirement.min_context
        ));
    }
    if requirement.effort == Effort::High && !model.capabilities.reasoning {
        blockers.push("high reasoning requested but the model does not reason".into());
    }

    match requirement.effort {
        Effort::Any => {}
        Effort::Low => {
            if model.capabilities.reasoning {
                points -= 10;
                reasons.push("reasoning model for a low-effort request".into());
            }
        }
        Effort::Medium => {
            if model.capabilities.reasoning {
                points += 20;
                reasons.push("reasoning".into());
            }
        }
        Effort::High => {
            if model.capabilities.reasoning {
                points += 60;
                reasons.push("reasoning".into());
            }
        }
    }
    match model.cost_of(1000, 1000) {
        None => reasons.push("price unknown, ranked on capability alone".into()),
        Some(_) => reasons.push(
            match requirement.cost {
                CostPreference::Minimal => "cheap",
                CostPreference::Balanced => "priced",
                CostPreference::Best => "premium",
            }
            .into(),
        ),
    }

    if model.capabilities.code {
        points += 5;
        reasons.push("code".into());
    }
    if model.capabilities.structured_output {
        points += 5;
        reasons.push("structured output".into());
    }

    let headroom = model.context_window.saturating_sub(requirement.min_context);
    points += (headroom / 4096) as i64;

    Candidate {
        model,
        score: points,
        reasons,
        blockers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::capability::ModelCapabilities;
    use std::sync::Mutex;

    fn model(id: &str, caps: ModelCapabilities, ctx: u32, price: Option<f64>) -> ModelInfo {
        let mut m = ModelInfo::new(id, "test", ctx).with(caps);
        if let Some(p) = price {
            m = m.priced(p, p);
        }
        m
    }

    fn full() -> ModelCapabilities {
        ModelCapabilities {
            chat: true,
            code: true,
            reasoning: true,
            vision: true,
            tools: true,
            structured_output: true,
        }
    }

    struct Stub {
        name: String,
        models: Vec<ModelInfo>,
        behaviour: Mutex<Vec<Result<ChatResponse, ModelError>>>,
        seen: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ModelClient for Stub {
        fn name(&self) -> &str {
            &self.name
        }
        fn models(&self) -> Vec<ModelInfo> {
            self.models.clone()
        }
        async fn complete(
            &self,
            model: &ModelInfo,
            _request: &ChatRequest,
        ) -> Result<ChatResponse, ModelError> {
            self.seen.lock().unwrap().push(model.id.clone());
            let mut queue = self.behaviour.lock().unwrap();
            if queue.is_empty() {
                return Err(ModelError::EmptyAnswer {
                    provider: self.name.clone(),
                });
            }
            queue.remove(0)
        }
    }

    fn stub(name: &str, models: Vec<ModelInfo>) -> Arc<Stub> {
        Arc::new(Stub {
            name: name.to_string(),
            models,
            behaviour: Mutex::new(Vec::new()),
            seen: Mutex::new(Vec::new()),
        })
    }

    fn answer(id: &str) -> ChatResponse {
        ChatResponse {
            content: "ok".into(),
            tool_calls: vec![],
            input_tokens: 100,
            output_tokens: 50,
            model: id.into(),
        }
    }

    #[test]
    fn a_tool_requirement_eliminates_a_model_without_tools() {
        let caps = ModelCapabilities {
            chat: true,
            tools: false,
            ..ModelCapabilities::NONE
        };
        let c = score(model("plain", caps, 8000, Some(0.001)), &Requirement::default().with_tools());
        assert!(!c.is_usable());
        assert!(c.blockers.iter().any(|b| b.contains("tool calling")));
    }

    #[test]
    fn a_context_requirement_eliminates_a_model_that_is_too_small() {
        let c = score(
            model("small", full(), 4096, Some(0.001)),
            &Requirement::default().min_context(100_000),
        );
        assert!(!c.is_usable());
        assert!(c.blockers.iter().any(|b| b.contains("below the required")));
    }

    #[test]
    fn cheapest_wins_under_minimal_cost_and_priciest_under_best() {
        let cheap = model("cheap", full(), 8000, Some(0.0001));
        let dear = model("dear", full(), 8000, Some(0.05));

        let minimal = Requirement::default().cost(CostPreference::Minimal);
        assert_eq!(rank(&score(cheap.clone(), &minimal), &score(dear.clone(), &minimal), &minimal), Ordering::Less);
        assert_eq!(rank(&score(dear, &minimal), &score(cheap, &minimal), &minimal), Ordering::Greater);

        let best = Requirement::default().cost(CostPreference::Best);
        let dear_b = model("dear", full(), 8000, Some(0.05));
        let cheap_b = model("cheap", full(), 8000, Some(0.0001));
        assert_eq!(rank(&score(dear_b, &best), &score(cheap_b, &best), &best), Ordering::Less);
    }

    #[test]
    fn an_unpriced_model_sorts_last_under_a_cost_preference_without_being_excluded() {
        let priced = model("priced", full(), 8000, Some(0.001));
        let mystery = model("mystery", full(), 8000, None);
        let minimal = Requirement::default().cost(CostPreference::Minimal);

        let mystery_scored = score(mystery.clone(), &minimal);
        assert_eq!(
            rank(&score(priced, &minimal), &mystery_scored, &minimal),
            Ordering::Less,
            "an unpriced model cannot be shown to be cheapest"
        );
        assert!(
            mystery_scored.is_usable(),
            "but it must still be offered, not silently dropped"
        );
    }

    #[test]
    fn an_unpriced_model_is_never_reported_as_free() {
        let c = score(
            model("mystery", full(), 8000, None),
            &Requirement::default().cost(CostPreference::Minimal),
        );
        assert!(c
            .reasons
            .iter()
            .any(|r| r.contains("price unknown")));
        assert!(c.model.cost_of(1000, 1000).is_none());
    }

    #[test]
    fn a_resolution_explains_itself_including_the_blocked_ones() {
        let no_tools = ModelCapabilities {
            chat: true,
            ..ModelCapabilities::NONE
        };
        let mesh = Mesh::new(vec![Arc::new(Stub {
            name: "p".into(),
            models: vec![
                model("good", full(), 8000, Some(0.001)),
                model("blind", no_tools, 8000, Some(0.001)),
            ],
            behaviour: Mutex::new(Vec::new()),
            seen: Mutex::new(Vec::new()),
        }) as Arc<dyn ModelClient>]);

        let resolution = mesh.resolve(&Requirement::default().with_tools());
        assert_eq!(resolution.chosen().unwrap().id, "good");
        let text = resolution.explain();
        assert!(text.contains("#0 good"), "{text}");
        assert!(text.contains("blocked blind"), "{text}");
        assert!(text.contains("no tool calling"), "{text}");
    }

    #[test]
    fn an_empty_mesh_resolves_to_nothing_rather_than_panicking() {
        let mesh = Mesh::new(vec![]);
        let resolution = mesh.resolve(&Requirement::default());
        assert!(resolution.chosen().is_none());
        assert_eq!(resolution.explain(), "no models are registered");
    }

    #[tokio::test]
    async fn a_satisfied_request_returns_its_usage_and_its_cost() {
        let stub = stub("p", vec![model("m", full(), 8000, Some(0.001))]);
        stub.behaviour.lock().unwrap().push(Ok(answer("m")));
        let mesh = Mesh::new(vec![stub as Arc<dyn ModelClient>]);

        let (response, resolution, usage) = mesh
            .complete(&Requirement::default(), &ChatRequest::new(vec![]))
            .await
            .expect("completes");
        assert_eq!(response.model, "m");
        assert_eq!(resolution.chosen().unwrap().id, "m");
        assert_eq!(usage.input_tokens, 100);
        assert_eq!(usage.output_tokens, 50);
        let cost = usage.cost_usd.expect("a priced model yields a cost");
        assert!(
            (cost - 0.000_15).abs() < 1e-12,
            "cost was {cost}, expected 0.00015"
        );
    }

    #[tokio::test]
    async fn a_failing_provider_falls_through_to_the_next_candidate() {
        let first = stub("first", vec![model("dear", full(), 8000, Some(0.05))]);
        first
            .behaviour
            .lock()
            .unwrap()
            .push(Err(ModelError::Transport {
                provider: "first".into(),
                detail: "connection refused".into(),
            }));
        let second = stub("second", vec![model("cheap", full(), 8000, Some(0.001))]);
        second.behaviour.lock().unwrap().push(Ok(answer("cheap")));

        let mesh = Mesh::new(vec![
            Arc::clone(&first) as Arc<dyn ModelClient>,
            second as Arc<dyn ModelClient>,
        ]);
        let (response, _, _) = mesh
            .complete(
                &Requirement::default().cost(CostPreference::Best),
                &ChatRequest::new(vec![]),
            )
            .await
            .expect("falls through");

        assert_eq!(
            response.model, "cheap",
            "the dear model was preferred but was down"
        );
        assert_eq!(first.seen.lock().unwrap().len(), 1, "the first was tried");
    }

    #[tokio::test]
    async fn an_unreachable_requirement_fails_before_any_call_is_made() {
        let stub = stub("p", vec![model("m", ModelCapabilities::chat(), 8000, Some(0.001))]);
        let mesh = Mesh::new(vec![stub.clone() as Arc<dyn ModelClient>]);
        let err = mesh
            .complete(&Requirement::default().with_vision(), &ChatRequest::new(vec![]))
            .await
            .expect_err("no model has vision");
        assert!(matches!(err, ModelError::NoCandidate));
        assert!(stub.seen.lock().unwrap().is_empty(), "nothing may be called");
    }

    #[test]
    fn ordering_is_reproducible_for_equal_scores() {
        let mesh = Mesh::new(vec![Arc::new(Stub {
            name: "p".into(),
            models: vec![
                model("b", full(), 8000, Some(0.001)),
                model("a", full(), 8000, Some(0.001)),
            ],
            behaviour: Mutex::new(Vec::new()),
            seen: Mutex::new(Vec::new()),
        }) as Arc<dyn ModelClient>]);

        let first = mesh.resolve(&Requirement::default()).chosen().unwrap().id.clone();
        let second = mesh.resolve(&Requirement::default()).chosen().unwrap().id.clone();
        assert_eq!(first, second);
        assert_eq!(first, "a", "ties break by id, not by scan order");
    }
}
