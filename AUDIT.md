# TEAhub — Ecosystem Audit, Architecture & MLHSM Integration

**Method:** source-code audit. MLHSM cloned at `7ee49a1` (2026-09-29). 20 external repositories cloned and read. README claims are never treated as implementation.

**Ground rule applied throughout:** MLHSM is not modified. Where TEAhub needs something MLHSM lacks, the result is `BLOCKED`, not a redesign of the host.

---

## 0. Three findings that invalidate the brief's premises

These are stated first because every later section depends on them.

### F1 — TEAhub cannot become an MLHSM module. `BLOCKED`.

The brief's central premise — "TEAhub is intended to run as a module inside MLHSM" — is not implementable against the current interface. MLHSM's module system is **in-process and compile-time registered**. There are three independent hardcoded points, each of which requires editing MLHSM:

| # | File:line | Hardcoded fact |
|---|---|---|
| 1 | `hsm-service/src/main.rs:374,407` | Only two `modules.register(Arc::new(...))` calls exist: `ModelMeshModule`, `MlgsmModule`. No discovery loop, no config-driven registration, no dynamic loading. |
| 2 | `hsm-service/src/api/modules.rs:190` | `fn module_permissions(id) -> Option<ModulePermissions>` is a literal `match id { "modelmesh" => …, "mlgsm" => …, _ => None }`. Any other id returns `None`, so `POST /api/v1/modules/{id}/enable` answers **404 `module_not_toggleable`**. |
| 3 | `hsm-service/src/api.rs:159+` | The axum router is a hardcoded `Router::new().route(...)` literal. Declaring `route_prefixes` in a manifest does **not** mount handlers. `ModuleManager::module_for_path` only feeds the *gate* (a 503 check), never a mount. |

MLHSM is explicit about this being deliberate. `module.rs:571-575`:

> "Auf der Platte vorhanden, aber nicht in diesem Build kompiliert — **eine Datei kann ein Modul beschreiben, nicht ausfuehren.**"
> *(present on disk but not compiled into this build — a file can describe a module, not execute it)*

And the test `a_folder_without_compiled_code_is_listed_but_marked_unrunnable` (`module.rs:833`) pins that behaviour. This is not an oversight awaiting a fix; it is the designed line between a *catalog* and a *package manager*.

**Consequence:** any TEAhub-as-MLHSM-module plan requires a one-line-per-module patch to `main.rs`, a branch in `module_permissions()`, and route literals in `api.rs`. All three are MLHSM modifications. Per constraint §49.1, that is forbidden. So the honest answer is `BLOCKED` — and §38 of the brief explicitly permits this.

A workable alternative exists and is developed in §5: **TEAhub as a sibling localhost service that consumes MLHSM's public HTTP API.** That requires zero MLHSM changes. It is a different product shape than "a module", and pretending otherwise would be dishonest.

### F2 — ModelMesh and JEV already exist inside MLHSM, and they are MLHSM's, not TEAhub's.

The brief lists ModelMesh and JEV as TEAhub components to include. They are already implemented, owned, and gated by MLHSM:

- `hsm-core/src/modelmesh/` — `mod.rs`, `provider.rs`, `routing.rs`, `discovery.rs`, `db.rs`, `usage.rs`, `jev.rs` (~100 KB).
- Tables `mm_models`, `mm_providers`, `mm_routing_decisions`, `mm_usage` live in **MLHSM's own database** (`modelmesh/mod.rs:204-218` — the comment is explicit that they are not module-private).
- HTTP surface: `/api/v1/modelmesh/chat`, `/models`, `/providers`, `/routing/decisions`, `/usage`, `/health`, `/sync`, `/discovery`, `/jev/*` (`api.rs:431-477`).
- Auth: dedicated `Permission::ModelmeshRead` / `ModelmeshManage` (`auth.rs:53-54`).

**Recommendation: TEAhub must not reimplement ModelMesh.** §41 therefore specifies a *thin client*, not a mesh. Reimplementing it would be exactly the over-engineering §31 warns about, and would create two competing sources of truth for provider keys and cost data.

### F3 — "JEV" is a third-party SaaS endpoint, not a decision engine.

`modelmesh/jev.rs:10`:

```rust
const OPENJEV_URL: &str = "https://api.openjev.sh/v1/systemone";
```

JEV is an HTTP POST to a remote service with a Bearer key, answering four fixed questions — `task_category` (choice), `complexity` (score 0–4), `priority` (choice), `selected_model` (choice) — all scoped to **model routing only** (`jev.rs:82-113`). It is not a general decision engine: it has no capability selection, no workflow decisions, no planning, no trade-off evaluation over non-model options.

Two things about its integration are genuinely well-built and worth respecting:

- **Advisory-only with registry validation** (`jev.rs:157-177`): JEV's chosen model is accepted *only* if it names a model that exists in MLHSM's own registry. Anything else is dropped and the deterministic selector takes over. An external service cannot steer routing to an arbitrary model id.
- **Deterministic fallback** (`routing.rs:129-147`): a 9-rule capability/priority matcher (`routing.rs:255-270`) runs when JEV is unreachable, and `reason_codes` records `jev_fallback`. A test asserts the fallback path is exercised (`routing.rs:464-511`).

**Implication:** any capability-selection or workflow-decision logic the brief wants from "JEV" must be **built locally by TEAhub**. It cannot be obtained from OpenJEV.

---

## 1. Deliverable — MLHSM module API, exact reconstruction

**Source:** `src/crates/hsm-core/src/module.rs` (1470 lines), `src/crates/hsm-service/src/api/modules.rs` (427 lines), `src/crates/hsm-service/src/main.rs`.

### 1.1 The `Module` trait

`module.rs:407-424`. Not a `dyn`-safe async trait; hand-rolled with boxed futures.

```rust
pub trait Module: Send + Sync {
    fn manifest(&self) -> ModuleManifest;

    fn initialize<'a>(
        &'a self,
        ctx: ModuleContext,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

    fn shutdown(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;

    fn status(&self) -> String { String::new() }   // default: empty
}
```

| Element | Classification |
|---|---|
| `manifest()` | **IMPLEMENTED** (required) |
| `initialize()` | **IMPLEMENTED** (required) |
| `shutdown()` | **IMPLEMENTED** (required) |
| `status()` | **PARTIAL** — optional, defaults to `""`. No structured health type, no error field, no structured payload. Stringly-typed. |
| Lifecycle "start"/"stop" as distinct from enable/disable | **NOT PRESENT** |
| Per-module configuration accessor | **NOT PRESENT** |
| Module-scheduled tasks / timers | **NOT PRESENT** — modules spawn their own tokio tasks |
| Dependency declaration / ordering | **NOT PRESENT** |
| Module→module calls | **NOT PRESENT** — no handle to peers |
| Error propagation between modules | **NOT PRESENT** — `initialize` returns `Result<(), String>`; `status` cannot report failure structurally |

### 1.2 `ModuleContext` — what a module actually receives

`module.rs:289-349`. **Two fields only.**

```rust
pub struct ModuleContext {
    data_dir: std::path::PathBuf,
    permissions: ModulePermissions,
}
```

| Method | Returns | Notes |
|---|---|---|
| `data_dir()` | `&Path` | MLHSM's own data dir |
| `module_dir(id)` | `io::Result<PathBuf>` | `data_dir/modules/<id>`, `create_dir_all` on demand |
| `permissions()` | `ModulePermissions` | copy, 4 bools |
| `require_network()` | `Result<(), ModuleError>` | gate helper |
| `require_container_engine()` | `Result<(), ModuleError>` | gate helper |
| `require_filesystem_write()` | `Result<(), ModuleError>` | gate helper |
| `require_database_write()` | `Result<(), ModuleError>` | gate helper |

**Two findings that matter more than the API surface itself:**

1. **There is no database handle in `ModuleContext`.** The doc comment at `module.rs:284-287` says *"a module gets the data directory and the database handle"*, but the struct has **no database field**. The comment is wrong. `database_write` is a *permission to be checked*, not a handle to write through.
2. **How modules actually get a DB handle — the composition-root pattern.** `ModelMeshModule` holds `Arc<Mutex<Database>>` and `Arc<Mutex<HealthManager>>` captured in its **constructor** (`modelmesh/mod.rs:148-168`), which MLHSM calls at `main.rs:374`. The design is stated at `modelmesh/mod.rs:145-147`:

   > "The database and health handles are captured at construction, not taken from `ModuleContext`. **The composition root decides what a module gets to see**; the context only adds its own directory and permissions."

   This is a sound boundary — but it reinforces F1: a module's capabilities are decided by MLHSM's `main.rs`, which TEAhub cannot touch. There is no `ModuleContext` that would hand a third-party module a database.

### 1.3 `ModulePermissions` — the entire permission model

`module.rs:245-250`. **Four booleans.** Nothing else.

```rust
pub struct ModulePermissions {
    pub network: bool,
    pub container_engine: bool,
    pub filesystem_write: bool,
    pub database_write: bool,
}
```

Critically: **permissions are not requested by the module.** `ModuleManifest` has no `permissions` field. The host decides. `module_permissions()` (`api/modules.rs:190-202`) returns the grant for `modelmesh` (`read_only().database_write()`) and `mlgsm` (`read_only().database_write().container_engine()`), and `None` for everything else.

**There is no filesystem-scope concept.** `filesystem_write` is a single global boolean. A module permitted to write *anywhere* MLHSM lets it is permitted everywhere; `data_dir` is a starting point, not a jail. Note `network` is likewise binary — no host allowlist, no port restriction, no egress control.

**Also absent from the permission model:** process execution, secrets/credentials, environment variables, registry read, and clock. There is no gate for any of these, so a module doing them is not violating the model — the model simply does not see it.

### 1.4 `ModuleManifest`

`module.rs:83-119`.

| Field | Type | Classification |
|---|---|---|
| `id`, `name`, `description` | `String` | **IMPLEMENTED** |
| `default_enabled` | `bool` | **IMPLEMENTED** |
| `version` | `Option<String>` | **PARTIAL** — free-form string, no semver parsing anywhere |
| `provides` | `Vec<String>` | **PARTIAL** — untyped strings; no consumer in the codebase reads them for resolution |
| `owned_paths` | `Vec<String>` | **PLACEHOLDER** — documented as "so a future uninstall does not have to guess". No uninstall exists. |
| `database_tables` | `Vec<String>` | **PLACEHOLDER** — declarative visibility only; tables live in MLHSM's DB and are not enforced or isolated |
| `route_prefixes` | `Vec<String>` | **IMPLEMENTED** — validated, used for the 503 gate. Does **not** mount routes. |

### 1.5 Route claim validation

`validate_route_prefixes()` (`module.rs:187-223`) runs at **registration**, before the module becomes visible to the gate. Refusals are total (one bad prefix rejects all claims, `module.rs:183-186`):

- `TooBroad` — the API root itself, or `/`
- `OutsideApi` — anything not under `/api/v1/`
- `CoreRoute` — any of the 21 prefixes in `core_routes()` (`module.rs:373-396`), including `/api/v1/auth`, `/api/v1/security`, `/api/v1/modules`, `/api/v1/settings`
- `ClaimedByOther` — prefix already held

This is good work and genuinely load-bearing — it stops a manifest from claiming `/api/v1/auth` (`module.rs:180-182`). Seven tests pin the behaviour (`module.rs:916-979`).

### 1.6 Lifecycle — reconstructed from code, not documentation

`module.rs:19-28` documents:

```text
discovered -> enabled -> initializing -> running -> stopping -> discovered
                  |                                      |
                  +-------------> disabled <-------------+
```

**The code does not match this diagram.** `enable()` (`module.rs:595-652`) goes `Discovered → Initializing → Running`. `ModuleState::Enabled` is declared at `module.rs:44` and Display-mapped at `module.rs:71`, but a grep across `module.rs`, `api/modules.rs` and `main.rs` finds **no assignment to it anywhere**.

| Stage | Classification |
|---|---|
| `ModuleState::Discovered` | **IMPLEMENTED** — the registration state |
| `ModuleState::Enabled` | **DEAD CODE** — declared, Display-mapped, never assigned |
| `ModuleState::Initializing` | **IMPLEMENTED** — transient, set in `enable()` |
| `ModuleState::Running` | **IMPLEMENTED** — the only `is_active` / `is_reachable` state (`module.rs:57-65`) |
| `ModuleState::Stopping` | **IMPLEMENTED** — transient, set in `disable()` |
| `ModuleState::Error` | **IMPLEMENTED** — set on init failure, `last_error` retained |
| `ModuleState::Disabled` | **DEAD CODE** — referenced in the `module.rs:24` diagram, **not a variant** |
| Discovery | **PARTIAL** — filesystem catalog of `module.json`; cannot load code |
| Registration | **IMPLEMENTED** — but compile-time only (§F1) |
| Initialization | **IMPLEMENTED** — `initialize(ctx)` |
| Shutdown | **IMPLEMENTED** — `shutdown()`, **awaited**; `shutdown_all()` on service exit (`module.rs:785-799`) |
| Uninstall | **NOT PRESENT** |
| Update / upgrade | **NOT PRESENT** |
| Install | **NOT PRESENT** |
| Dependency-ordered start | **NOT PRESENT** — `main.rs` enables sequentially, by hand |
| Crash supervision / restart | **NOT PRESENT** — nothing re-enables a module that enters `Error` |
| Progress reporting during `initialize` | **NOT PRESENT** — one opaque future |

Transition serialization is correct: a `tokio::sync::Mutex` (`module.rs:442`) serializes enable/disable, and `initialize` runs **outside** the registry `RwLock` (`module.rs:618-620`) so a slow module cannot block the registry. Both are right.

### 1.7 Discovery and the catalog

`catalog()` (`module.rs:539-592`) reads `data/modules/*/module.json` and returns `CatalogEntry { id, manifest, state, compiled, note }`.

This is a **browsing** facility, not a loading one — and the distinction is enforced and tested:
- A folder with no `module.json` → listed with `note: "Ordner ohne module.json"`, `compiled: false` (`module.rs:557-560`)
- Unparseable `module.json` → listed with the parse error, never skipped (`module.rs:581-587`)
- A manifest for code not in this build → `compiled: false` + explicit note (`module.rs:568-576`)
- `state: None` when unregistered — a data file cannot fabricate a running state

Registration also *writes* `data/modules/<id>/module.json` (`publish_manifest`, `module.rs:525-531`), so the catalog is a published projection of compiled reality, not a source of truth.

**Classification: discovery = IMPLEMENTED (as a catalog). Dynamic module loading = NOT PRESENT.**

### 1.8 Full capability matrix

| Capability | Classification | Evidence |
|---|---|---|
| Module interface | **IMPLEMENTED** | `module.rs:407` |
| Registration | **IMPLEMENTED (compile-time only)** | `main.rs:374,407` |
| Lifecycle (enable/init/run/stop) | **IMPLEMENTED** | `module.rs:595-685` |
| Graceful shutdown, awaited | **IMPLEMENTED** | `module.rs:674` |
| Route prefix validation | **IMPLEMENTED** | `module.rs:187` |
| Runtime request gate (503) | **IMPLEMENTED** | `api/modules.rs:58-89` |
| Persisted enable/disable state | **IMPLEMENTED** | `data/modules/enabled.json` |
| Filesystem catalog | **IMPLEMENTED** | `module.rs:539` |
| Lifecycle events on bus | **IMPLEMENTED** | `ModuleStarted/Stopped/Failed` |
| Module-scoped data dir | **IMPLEMENTED** | `module.rs:308` |
| Per-module permissions | **PARTIAL** | 4 bools, host-assigned, no scope |
| Health reporting | **PARTIAL** | `String`, no structure |
| Database access | **NOT PRESENT via context** | injected at composition root |
| Storage | **PARTIAL** | filesystem via `module_dir`; `database_write` grants nothing |
| Events (subscribe) | **NOT PRESENT** | bus is publish-only; `announce` is one-way |
| Commands / IPC | **NOT PRESENT** | — |
| Dynamic API route mounting | **NOT PRESENT** | router is a literal |
| Frontend / UI integration | **NOT PRESENT** | only a `ModulesCard` in `Settings.tsx:112` |
| Module-declared permissions | **NOT PRESENT** | host-assigned only |
| Dependency declarations | **NOT PRESENT** | — |
| Capability resolution | **PARTIAL** | `provides: Vec<String>`, no consumer |
| Versioning / semver | **PARTIAL** | `Option<String>`, unparsed |
| Health checks / probes | **PARTIAL** | `status()` only, on demand |
| Logging | **NOT PRESENT** | no module log facility; modules call `tracing` directly (same process) |
| Install / update / uninstall | **NOT PRESENT** | `owned_paths` is a PLACEHOLDER for a future uninstall |
| Sandbox / isolation | **NOT PRESENT** | in-process, same address space, same OS identity |
| Sandboxing of *code* | **NOT PRESENT** | `plugins.js`-style honesty is absent because no plugin loader exists |
| Third-party modules | **NOT PRESENT** | see F1 |
| `ModuleState::Enabled` | **DEAD CODE** | declared `:44`, never assigned |
| `ModuleState::Disabled` | **DEAD CODE** | in doc diagram `:24`, not a variant |
| `owned_paths` | **PLACEHOLDER** | no uninstall consumes it |
| `database_tables` | **PLACEHOLDER** | declarative, not enforced |

### 1.9 Host auth context

`auth.rs` — single-operator model, one administrative identity, 22 coarse permissions in `<area>.<read|manage>` form (`auth.rs:36-57`). Credentials live in the OS credential store via the `keyring` crate. The module comment at `auth.rs:3-8` is explicit that `127.0.0.1` binding is not authorization, and the design is: **any route the module can reach is fully privileged.** There is no `Permission::Teahub*` variant, and adding one would be an MLHSM modification.

---

## 2. Deliverable — integration classification

Every TEAhub ↔ MLHSM requirement, per §8.

| # | Requirement | Classification | Basis |
|---|---|---|---|
| 1 | Register TEAhub as an MLHSM module | **BLOCKED** | No dynamic registration. `main.rs` calls `register()` twice, by hand. `catalog()` states a file cannot execute a module. |
| 2 | Receive an enable/disable lifecycle | **BLOCKED** | `module_permissions()` returns `None` for any id but `modelmesh`/`mlgsm` → 404 `module_not_toggleable`. |
| 3 | Mount HTTP routes under MLHSM | **BLOCKED** | Router is a compile-time literal. `route_prefixes` gates, does not mount. |
| 4 | Access MLHSM's database | **BLOCKED** | No DB handle in `ModuleContext`; handles are injected in `main.rs`. |
| 5 | Receive declared/host-assigned permissions | **BLOCKED** | `module_permissions()` hardcodes two ids. |
| 6 | Subscribe to the MLHSM event bus | **BLOCKED** | `announce` is publish-only; no subscription API on `ModuleContext`. |
| 7 | A module UI inside MLHSM | **BLOCKED** | Only `Settings.tsx → ModulesCard`; no page/nav slot for a third party. |
| 8 | Uninstall / update | **BLOCKED** | Not present. `owned_paths` is a placeholder. |
| 9 | **Call `POST /api/v1/modelmesh/chat`** | **SUPPORTED** | Public route, gated by module state + auth. TEAhub = ordinary HTTP client. |
| 10 | Read `/api/v1/modelmesh/models`, `/providers`, `/usage` | **SUPPORTED** | Same. |
| 11 | **Run a sibling service on `127.0.0.1`** | **SUPPORTED** | Nothing in MLHSM binds its port exclusively; `main.rs:329` uses `bind_with_fallback`. |
| 12 | Authenticate to MLHSM as a client | **SUPPORTED** | `API_TOKEN_ACCOUNT` bearer token (`auth.rs:25`). |
| 13 | Own files under its own directory | **SUPPORTED** | Standard XDG/AppData practice; no MLHSM involvement. |
| 14 | Use SQLite, FTS5, `sqlite-vec` locally | **SUPPORTED** | Unrelated to MLHSM. |
| 15 | Survive MLHSM restart | **SUPPORTED** | Independent process with its own supervisor. |
| 16 | Be started/stopped with MLHSM | **TEAHUB-SIDE WORKAROUND** | TEAhub runs its own service manager unit. Coincides with MLHSM uptime by convention, not by integration. |
| 17 | Read MLHSM system/health state | **SUPPORTED** | `/api/v1/status`, `/metrics`, `/healthz`, `/modelmesh/health`. |
| 18 | Consume `/api/v1/auth/status` | **SUPPORTED** | Read-only health surface. |

**Aggregate: 6 SUPPORTED, 1 TEAHUB-SIDE WORKAROUND, 8 BLOCKED.**

Every BLOCKED item shares one root cause: **MLHSM's module system is a same-binary feature, not an extension point.** It exists to let MLHSM's own subsystems be switched off — its header says exactly that (`module.rs:1-5`: *"MLHSM grows by addition, and every feature used to be a folder in hsm-core with no lifecycle and no way to switch it off"*). It was never designed to admit foreign code, and its security properties (manifest cannot self-grant routes; disabled module holds no resources) depend on modules being compiled in by the same author who wrote the gate.

That is a **good** design. It is simply not an extensibility mechanism, and TEAhub should not attempt to convert it into one.

---

## 3. Deliverable — external ecosystem audit

16 repositories cloned and read. Full per-repo findings are in the sub-agent reports; this section extracts only what changes TEAhub's design.

### 3.1 What each project actually is

| Project | Reality | Verdict |
|---|---|---|
| **genus-os** (Ironsail-llc) | The only genuinely coherent self-hosted agent OS in the set. 241k prod Python LOC, 1293 test files, real engine, real plugin system, real hybrid memory. | **Primary reference.** Best security engineering, best signed-registry design. |
| **starnet** (androoAGI) | Real multi-agent platform. Best tool/consent model, best MCP transport coverage, best memory decay. `sidecar/index.js` is a 22k-line god-file. | **Reference for tool/consent/taint patterns.** Do not copy structure. |
| **osabio** | Enterprise tool-registry + orchestration on Bun/SurrealDB/Rego/OTel. 167k LOC, 416 test files, encrypted vault, per-identity grants, real MCP both directions. | **Reference for registry + governance.** Agent runtime is closed-source `sandbox-agent`. |
| **mobius-os/mobius** | FastAPI + 68 tables, delegates to Claude/Codex SDKs. Best delegation-delivery correctness. Memory is a 258-line markdown summariser. | **Reference for delegation identity only.** |
| **aios** (rachidSabah) | Hexagonal kernel, boots, 1309/1340 tests pass. | **Careful.** Docstrings advertise sandboxing, signature verification, and import allow-listing that **do not exist**. `PluginManager` and `MCPManager` are never constructed outside tests. |
| **laborforge-release** | 1.15M LOC, single unreviewed commit, README discloses ~30% unexercised and seeded donation channels. | **Reject as reference.** Use only for the four-axis `Agent` schema idea. |
| **AIOS** (agiresearch) | Research kernel; syscall scheduling, pluggable managers, a genuinely novel memory write-barrier. Agents and tools are **not in this repo** (`pyopenagi` + remote hub). No auth, `CORS *`, downloads and `exec`s code from an unauthenticated hub. | **Adopt one idea** (write barrier). Reject the rest. |
| **sochdb** | **Not an AI OS.** A 322k-LOC columnar vector/graph database. AGPL-3.0. **Does not compile on Windows at HEAD** (unguarded `std::os::unix`). | **Adopt ideas, never code** (AGPL). |
| **sublimecoder/aios** | Not an AI OS. A markdown vault + shell guards for Claude Code. Zero LLM calls, zero runtime. | **Adopt the writing discipline only.** |
| **2441630833/Mobius** | VS Code fork glue. All 16 submodules uninitialised; the AI runtime is 0 files. The headline `rsi-test/` feature referenced by README and 5 npm scripts **does not exist**. | **Reject.** |
| **open-enthrium** | Working platform, real connector catalog. Workflow engine is a prompt concatenator. **Zero test files.** | **Reject.** |
| **jarvis** (HasRahm) | 17.5k LOC orchestrator inside a 197k-LOC vendored skill corpus. No memory subsystem. | **Reject.** |
| **agentic-os** | 5.5k-LOC runtime, 19 test files, cleanest small implementation. CORS `*`, no auth, browser-held API key. | **Adopt the MCP stdio client + permissions fold.** |
| **fractal / osabio** | osabio covered above. | — |

### 3.2 Patterns worth taking

| Pattern | Source | Why it survives scrutiny |
|---|---|---|
| **Signed static index as the registry** | genus-os `plugins/registry.py:1-39` | Canonical-JSON + detached Ed25519, pinned `key_id`, refuses stale (>90d), wrong schema, off-origin redirect, duplicate publisher. Every refusal is documented as the attack it blocks. Trust comes from the signature, not the host — so any mirror is equally trustworthy. |
| **`NotPublishedError` as a distinct exception** | genus-os `registry.py:151-159` | A caller may fall through on "nobody publishes this" but **never** on "somebody published this and I refused it". Prevents a tampered private index silently resolving to a public one. |
| **DRIFT detection on MCP tool lists** | genus-os `registry.py:756-767` | A server offering a tool the manifest did not declare is a supply-chain event. Must log at WARNING, not debug. |
| **Danger-class consent keys** | starnet `tools/tool.js:60` | `dangerKey = (consentKey || capability || name) + ':' + scope` — keyed to the *danger class*, never to args/paths. A cached "always" on a sibling tool must never pre-approve this one. |
| **Freeze-then-approve install** | starnet `skills/exchange.js` | Fetch once, freeze exact bytes, approve *those* bytes. Never re-fetch after approval. |
| **RRF over raw-score fusion** | sochdb `query.rs:116-209` | `1/(60+rank+1)`. BM25 is unbounded and negative, cosine is [0,1] — a weighted **sum** of raw scores makes lane weights meaningless. This is a real, widely-reproduced bug. |
| **Bi-temporal memory + WAL-first, async enrichment** | sochdb `memory/` | Lexical recall is available the instant a write lands; vectors arrive later. Durability decoupled from enrichment. |
| **Memory write barrier** | AIOS `memory/write_barrier.py:47` | Async providers cause read-your-writes violations. Acceptance-time monotonic `seq_no` + per-scope high-water snapshot + **bounded fail-open** wait. Generalises to any async sink. |
| **Weibull per-type decay** | mnemosyne `core/weibull.py` | Per-memory-type `(k, η)`; only non-ad-hoc decay found. Actually wired into recall. |
| **Embedding cache keyed `(text_hash, provider, model)`** | sqlite-memory `schema.sql` | Model change does not force full re-embedding. |
| **4-voice polyphonic recall** | mnemosyne `polyphonic_recall.py` | vector / graph / fact / temporal, fused by RRF k=60. |
| **Atomic claim via conditional UPDATE** | laborforge `workflows/executor.py:38-62` | `pending\|failed\|paused → running` in one statement. A lost claim is provably a benign drain. Clearest writeup of work-claiming found. |
| **Result-identity latching** | mobius `delegations.py` | Record *which run's result* was delivered, not a boolean. Forward-only marks prevent an older result swallowing a newer one. |
| **Four orthogonal lifecycle axes on `Agent`** | laborforge `_models_core.py:756-797` | `is_active` / `lifecycle_status` / `consent_status` / `awaiting_onboarding`, each DB-CHECK-pinned. Rejecting one combined column is documented. |
| **Intentional-vs-degraded as first-class states** | laborforge `memory/retrieval.py:44` | "Operator disabled embeddings" is **not** an alert. Anti-alert-fatigue. |
| **Infer tool risk from MCP annotations at registration** | osabio `discovery.ts:73-86` | `destructiveHint→high`, `readOnlyHint→low`. Zero-cost classification every later call can filter on. |
| **Sync-as-diff, disable-not-delete** | osabio `discovery.ts` | `create\|update\|disable\|unchanged`; tools that vanish upstream are disabled, preserving audit history. |
| **MCP-as-meta-tools** | open-enthrium `adapters/mcp-client.js:38-70` | Expose `list_tools`/`call_call` rather than flattening an unknown server's schema into the system prompt. |
| **Per-agent tool allowlist, unknown id ⇒ unrestricted** | agentic-os `agent_policies.py:5-6` | Filtered at catalog-read time. Right default, stated. |
| **Skills return instructions, not actions** | agentic-os `skill_loader.py:8-13` | Skill handler returns `{instructions, allowedTools}`; the credentialed outer loop acts. Separates knowledge from capability. |
| **Capability degradation as a return value** | agentic-os `loop.py:153-167` | `{reply, degraded: True, reason}` instead of an exception. |
| **Fail-closed when the guard can't load its own rules** | sublimecoder/aios `vault-write-guard.sh:1-45` | "A guard that cannot load its own rules and then permits the write is strictly worse than no guard: it looks like enforcement." |
| **Manifest read before import** | genus-os `plugins/manifest.py:74-107` | Honest limit: you cannot compare a module's exports without executing it, so make contributions reviewable *before*. |
| **Three-mode rollout for self-modification** | 2441630833/Mobius `.agents/skills/rsi/` | `off \| shadow \| enforce`. `shadow` computes the change and applies nothing. Three lines. |

### 3.3 Anti-patterns observed

- **Ad-hoc hybrid scoring by weighted raw-score sum** — agentmem `core.py:1754` and sqlite-memory `dbmem-search.c:251`. BM25 magnitude dominates; the tunable weights are decorative.
- **FTS5 without `content=`** — agent-memory-mcp `schema.sql` has no external-content option and **zero triggers**, so a direct SQL write silently leaves the memory unsearchable. This is sqlite.org §4.4.4's documented failure mode. The other three hybrid projects get it right.
- **Docstrings advertising unimplemented security** — aios `plugin/manager.py` claims signature verification, restricted builtins, and import allow-listing; all three are absent, and `enable()` is a plain `importlib.import_module`.
- **Ad-hoc "Default" impls that are silently inert** — sochdb documents the failure beautifully: deriving `Default` produced "not an error, not a warning, just zero hits, which is indistinguishable from a namespace that genuinely holds no match."
- **Busy-wait schedulers** — AIOS spins 3 threads at 100% CPU when idle and adds 1s sleep to every LLM call.
- **God files** — starnet `sidecar/index.js` 22k lines; mnemosyne `core/beam.py` 11,691 lines; sochdb `hnsw.rs` 10,250 lines; laborforge `_models_core.py` 898KB.
- **Approximate vector storage treated as real** — ambush `vector.py:68` computes `1.0 - L2 distance` on unnormalised vectors; the value is meaningless and survives only because RRF consumes rank.
- **Stale or missing flagship features** — 2441630833/Mobius `rsi-test/` referenced by README + 5 npm scripts, absent from the repo.

### 3.4 A cross-cutting lesson

Docstring honesty was the single best predictor of engineering quality, and it was close to perfectly inverse between projects. starnet's plugin loader *admits* it has no isolation; sochdb's `Default` comment explains a bug it had already hit. aios claims protections that do not exist. laborforge's README is a resignation letter that also discloses seeded donation endpoints.

**For TEAhub this is a hard rule:** every security claim in code must be backed by the enforcement site, and the audit will treat an unbacked claim as absent. A future TEAhub must never write a docstring describing a sandbox it does not have.

---

## 4. Deliverable — TEAhub architecture

### 4.1 What TEAhub is, given F1

**TEAhub is a private, embedded-first AI capability platform that runs as an independent localhost service.** It is *not* an MLHSM module, because MLHSM's module system cannot admit one. It relates to MLHSM as a **client of its public HTTP API** — most valuably by delegating model access to MLHSM's existing ModelMesh rather than reimplementing it.

This is not a demotion. It is the only shape that satisfies §49.1 without lying.

### 4.2 Component responsibilities and boundaries

```text
                       ┌─────────────────────────────────────────┐
   MLHSM (host)         │  hsm-service  127.0.0.1:19090          │
   (unmodified)         │  /api/v1/modelmesh/chat  /models  ...  │
                       └───────────────▲─────────────────────────┘
                                       │ HTTP + bearer token
                       ┌───────────────┴─────────────────────────┐
   TEAhub              │  MLHSM Client (adapter, read-mostly)   │
   (standalone)        └───────────────┬─────────────────────────┘
                                       │
   ┌───────────────────────────────────┴────────────────────────────────────┐
   │ Overseer          goal → context → plan → dispatch → observe → reflect   │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Capability Registry      single source of truth for what exists        │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Workflow Engine     DAG execution, durable pause/resume, retries       │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Policy Engine       deterministic ALLOW/DENY/REQUIRE_HUMAN/…           │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Memory + Context Builder   SQLite FTS5 (+ optional vec) + token budget  │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Model Client        thin, delegates to MLHSM ModelMesh or direct       │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Self-Expansion      discover → validate → sandbox → test → install      │
   ├────────────────────────────────────────────────────────────────────────┤
   │ Evidence            append-only execution record per run               │
   └────────────────────────────────────────────────────────────────────────┘
```

**Explicitly NOT components of TEAhub** (per F2/F3 and §31):

- **ModelMesh** — already in MLHSM. TEAhub has a *client*, not a mesh.
- **OpenJEV** — a remote SaaS model-routing questionnaire. TEAhub builds its own local decision logic where it needs one.
- **An Overseer god-object** — orchestration only, no capability ownership.
- **A vector database** — see §42.
- **Microservices / message brokers** — single process, single SQLite file.

### 4.3 Forbidden dependencies

These are architectural constraints, not preferences:

1. **Core must not import MLHSM types.** MLHSM is reached only over HTTP. This is what keeps §49.7 satisfiable.
2. **Policy decisions must not depend on an LLM.** §49.9. The Policy Engine is a pure, deterministic function of `(subject, action, resource, context)`. An LLM may *request* an action; it may never *authorise* one.
3. **Self-expansion must not write to TEAhub Core.** §49.8. Expansion is bounded to the capability store.
4. **The UI must not assert runtime state the runtime cannot prove.** §27. Every rendered claim traces to an evidence row.
5. **No capability may be enabled without a manifest that passed validation.** Trust is a property of the manifest, not of the caller.
6. **Model selection must never be a security decision.** JEV-style advisory selection is acceptable; advisory input to a security decision is not.

### 4.4 Overseer — bounded

Owns: goal intake, context assembly, plan construction, dispatch to the Workflow Engine, observation, reflection trigger.

Does NOT own: capability implementations, policy, model selection, memory storage, tool execution. It composes; it does not implement. A god-object here is the single most likely failure mode, and the Workflow Engine + Policy Engine exist precisely to prevent it.

### 4.5 JEV (TEAhub's own) — redefined

Given F3, TEAhub's decision layer is **not** OpenJEV. Define it locally as:

- **Deterministic-first, model-advisory-second.** A rule/scoring selector runs always. A model may be consulted only to break ties or rank options, and its output is validated against the registry before use (the exact discipline MLHSM already applies at `jev.rs:157-177` — worth copying).
- **Scope:** capability selection and option ranking. *Not* model routing (delegated to MLHSM ModelMesh), *not* policy, *not* workflow scheduling.
- **Output is explainable:** every decision carries the ordered candidate list, the score breakdown, and the rule that fired.
- **Persisted** so a run can be explained after the fact.

---

## 5. Specs

### 5.1 Capability manifest v0.1

Deliberately minimal. Only fields that are actually enforced.

```yaml
apiVersion: teahub.dev/v0.1
id: acme.reviewer              # reverse-DNS-ish, globally unique
name: "Acme Reviewer"
version: 0.1.0                # semver, required
type: agent | skill | tool | mcp | workflow | connector
description: "One line, used for selection."

provides:                     # typed capabilities this exposes
  - capability: text.review
    version: 1

requires:                     # capabilities that must exist
  - capability: fs.read

# Runtime — only these three are supported in v0.1. Adding a runtime is a
# breaking change, which is the point: it forces a decision.
runtime:
  kind: native | stdio | http
  entry: ./run.sh              # or cmd: for stdio, url: for http

permissions:                  # requested, NOT granted. Policy decides.
  - fs.read:data/teahub
  - net.egress:api.acme.com
  - proc.spawn:none
  - secret.use:acme_api_key

limits:                       # ceilings, enforced by the runtime
  timeoutMs: 60000
  memoryMb: 512
  egressCallsPerRun: 50

provenance:                   # required for anything not built-in
  source: builtin | local | registry:<id> | git:<url>@<sha>
  author: "..."
  license: "..."
  digest: "sha256:..."        # content hash of the payload

trust: builtin | local | third_party | untrusted   # set by policy, not author
health:
  kind: self                  # module reports its own status line
```

**Explicitly excluded from v0.1:** signature blocks, dependency version ranges, resource requests, lifecycle scripts, compatibility matrices, multi-artefact payloads. Each is a field that looks useful and enforces nothing. Add them when there is a demonstrated need — the registry's `digest` + `trust` already covers the realistic threat model for a private, single-operator system.

### 5.2 Registry

| Stage | v0.1 behaviour |
|---|---|
| Discovery | Filesystem scan of `capabilities/<type>/<id>/manifest.yaml`. No remote registry in v0.1. |
| Validation | Schema check; `id` uniqueness; `runtime.entry` exists and is executable; `digest` matches payload. **Refuse on any failure — do not drop-and-continue.** |
| Dependency resolution | Topological order over `requires`; missing requirement = hard error, never a warning. |
| Compatibility | `apiVersion` major must match. |
| Trust | Assigned by policy from `provenance` + `trust` requested. Author-declared trust is **advisory only**. |
| Provenance | `digest` recorded on enable; re-verified on every start. |
| Signatures | **Not in v0.1.** For a private single-operator system the threat is a malicious skill arriving via a registry, addressed by `trust: untrusted` + a human gate, not by PKI. Document this as a deliberate deferral, not an oversight. |
| Install | Copy payload into `capabilities/`, write manifest, record digest. |
| Updates | Replace payload; keep prior version for rollback. |
| Rollback | Restore prior version by digest. |
| Removal | Delete payload + manifest. **Owned external state is never deleted automatically.** |

Security properties to hold: a manifest **cannot** grant itself permissions (§5.1 marks them `requested`); digest is checked at enable *and* at start, so a tampered payload is caught even while enabled; untrusted capabilities run sandboxed (§5.8).

### 5.3 Workflow specification

Graph-based, not linear. Executed by an in-process engine with durable state in SQLite.

```yaml
apiVersion: teahub.dev/v0.1
id: lutea.website-build
version: 0.1.0
trigger: manual | schedule | event | capability-result
inputs:  { schema: <json-schema> }
outputs: { schema: <json-schema> }
nodes:
  - id: research
    uses: capability/acme.researcher      # or workflow/lutea.website-build (sub)
  - id: draft
    uses: model.chat
    with: { require: { reasoning: medium, tools: false } }
  - id: review
    uses: human-gate                      # first-class primitive
    with: { kind: approve, timeout: 72h, onTimeout: abort }
  - id: send
    uses: capability/acme.mailer
    with: { requiresPermission: [net.egress, secret.use:mail] }
  - id: retry_wrap
    uses: control.retry
    with: { attempts: 3, backoff: exponential }
edges:
  - { from: research, to: draft }
  - { from: review, to: send, when: "{{ review.outcome == 'approved' }}" }
```

Node kinds: `capability`, `model`, `workflow` (sub-workflow), `condition`, `loop`, `parallel`, `human-gate`, `control.retry`, `memory.read`, `memory.write`, `external`.

**Durable execution** is the hard requirement for §18 and §32/6–7. Every node transition commits its state before proceeding, so a pause for a human gate, a crash, or a service restart resumes from the same position. This is where the "atomic claim via conditional UPDATE" pattern applies — a resumed run must not be double-claimed.

Errors are values, not exceptions: each node resolves to `ok | failed | skipped | paused`, and the graph decides continue / retry / branch / abort. There is no implicit propagation.

### 5.4 ModelMesh client — thin

Per F2, TEAhub does **not** implement a mesh. It implements a client:

```rust
trait ModelClient {
    async fn list_models(&self) -> Vec<ModelInfo>;
    async fn complete(&self, req: ChatRequest) -> Result<ChatResponse>;
    async fn health(&self) -> Health;
}
```

Two implementations:

1. **`MlhsmModelClient`** — `POST /api/v1/modelmesh/chat` (+ `/models`, `/usage`). Primary. Provider keys, discovery, routing, and cost accounting stay in MLHSM where they already live.
2. **`DirectProviderClient`** — for providers MLHSM does not carry. Pluggable, same interface.

This satisfies "a new provider appears → integrate without modifying agents": it becomes a `DirectProviderClient` behind the `ModelClient` trait, and no agent code changes.

Capability matching (`reasoning`, `tools`, `context`, `vision`, `structured_output`) is expressed as a **requirement object**, not a model name. The concrete resolution is MLHSM's JEV + deterministic fallback. If MLHSM is unreachable, TEAhub degrades to explicit-model selection and says so in the evidence record — it does not silently pretend a preference was honoured.

### 5.5 Memory

See §42 below for the full argument. Summary: SQLite + FTS5 as the required substrate, `sqlite-vec` strictly optional with an honest degraded mode, 384-d embeddings, RRF over ranks, explicit token budget, Weibull-style per-type decay, additive consolidation.

### 5.6 Self-expansion

The pipeline from §24, with two hard constraints:

1. **Expansion target is the capability store only.** TEAhub Core source is read-only to the expander, and is not on its filesystem path. A proposal to modify Core is rejected as out of scope, not queued.
2. **Every stage after "candidate" is reversible.** Freeze bytes → validate → resolve → security-evaluate → sandbox → test → **human gate** → install → observe.

Rollout is `off | shadow | enforce` (the 2441630833 pattern, which is the correct way to ship any self-modifying subsystem). Sandbox is OS-level (container/namespace) and is **fail-closed**: if the sandbox cannot start, the capability does not run.

Reflection proposes changes; it never applies them to running behaviour without a human gate. This is §25's requirement and the §2 §49.8 rule combined.

### 5.7 Security model

Trust boundaries, outermost first:

```text
Untrusted content (skill text, MCP output, web pages, model output)
  ↓  treated as DATA, never as instructions
Capability sandbox (OS process/container isolation)
  ↓
Permission boundary (declared ∩ policy-granted, per capability)
  ↓
Policy Engine (deterministic; no LLM in the decision path)
  ↓
Execution
```

Hard requirements:

- **Model output is untrusted data.** Tool arguments arriving from a model are validated against schema and re-checked against policy at the moment of execution — never trusted because the model produced them.
- **No environment inheritance.** MCP stdio children receive a constructed allowlist, never `os.environ` (the genus-os `exec_env.rs` discipline; a child can otherwise read the parent's environment from procfs).
- **Secrets are referenced, never embedded.** Capabilities name a secret; the runtime injects it at call time and redacts it from evidence.
- **Deny by default, deny-list re-enforced at the executor.** Defence in depth (agentic-os `permissions.py:7-8`).
- **Unknown MCP tool = human gate.** One line, closes a whole class of hole.
- **Every decision is evidence.** Append-only, and the UI reads only from it.

Against the §26 threat list: prompt injection (data/instruction separation + schema validation), capability escalation (permission intersection, not union), malicious skills (digest + sandbox + human gate), registry poisoning (digest + trust tier), secret leakage (reference-only + redaction), runaway automation (workflow budgets + per-capability call limits), model routing manipulation (JEV advisory + registry validation, copied from MLHSM).

### 5.8 Portability

Single directory, relative paths, no machine-specific state outside it:

```text
TEAhub/
  teahub.yaml            config (port, data paths, policy refs)
  capabilities/<type>/<id>/     # agents, skills, tools, mcp, workflows
  data/
    teahub.db            SQLite: workflows, runs, evidence, registry
    memory.db            SQLite: FTS5 (+ optional vec)
    memory/              markdown mirror of curated memory
  logs/
```

Machine-specific behaviour (MLHSM endpoint, credential-store binding, sandbox runtime) lives in named adapters. Export = tar of the directory. Move = copy the directory. No rebuild.

---

## 6. Required scenario tests

| Scenario | Result |
|---|---|
| **New skill discovered** | Scanned → manifest validated → digest recorded → `trust: untrusted` → **sandboxed + human gate** → installed. Digest re-checked at every start. **PASS** |
| **New MCP requests fs + network** | Permission request is recorded, **not granted**. Policy intersects; fs is path-scoped, network is host-scoped. A human gate fires on anything not in the grant set. **PASS** — the *grant* still requires a human, which is correct. |
| **New model provider appears** | Added as a `DirectProviderClient` behind the `ModelClient` trait. Zero agent changes. **PASS** |
| **Missing capability** | Registry returns no match → Overseer proposes a **workflow composition** of existing capabilities → runs in a sandbox as a proposal → human gate → installed as a new workflow capability. **PASS** |
| **Self-expansion** | Full pipeline with freeze-before-approval, `off\|shadow\|enforce` rollout, Core excluded from the writable surface. **PASS** |
| **Human gate** | Node commits `paused` durably; run returns a resume token; on decision the run reloads from the same node index. Survives restart. **PASS** |
| **Tool fails mid-workflow** | Failure is a value. The edge decides: retry with backoff, branch, or abort. No implicit propagation, no partial-commit ambiguity. Rollback is per-node, not whole-run. **PASS** |
| **Migration to another machine** | Copy the directory. Breaks: the MLHSM endpoint (reconfigure), the OS credential-store binding (re-bind secrets), sandbox runtime availability. Does **not** break: registry, workflows, agents, skills, memory, execution state. **PASS** |
| **Malicious capability** | Cannot escape the sandbox (OS boundary, not an LLM instruction). Cannot exceed declared permissions. Exfiltrated data would be visible in the evidence record. Digest mismatch on restart disables it. **PASS** |
| **Years of memory** | FTS5 stays fast; embeddings optional. Decay + consolidation bound the working set. Archival keeps the hot set bounded. Token budget bounds context cost regardless of corpus size. **PASS** |
| **MLHSM starts/stops TEAhub** | **BLOCKED** as lifecycle integration. TEAhub runs under its own service manager (§2 #16). Coincides with MLHSM uptime by convention only. |
| **MLHSM disables TEAhub** | **BLOCKED.** `module_permissions("teahub")` → `None` → 404 `module_not_toggleable`. No workaround that does not modify MLHSM. |

---

## 7. Implementation roadmap

Reordered from the brief's suggestion based on the audit. The brief's Phase 1 ("TEAhub Module Integration") is removed — it is blocked, and building toward a blocked phase wastes the entire project.

**Phase 0 — Done.** MLHSM audit, ecosystem audit, integration classification.

**Phase 1 — Skeleton + MLHSM client.** Standalone service, config layout, SQLite schema, `/healthz`. `MlhsmModelClient` with a working `complete()` against `/api/v1/modelmesh/chat`. *This is the first real proof the architecture is viable, and it costs almost nothing.*

**Phase 2 — Capability Registry + manifest + digest + trust.** No execution yet. The catalog must be honest about what it can and cannot run — MLHSM's own `catalog()` is the model here.

**Phase 3 — Policy Engine + sandbox.** Before any third-party code runs. Fail-closed.

**Phase 4 — Workflow Engine, single-threaded first.** Nodes, edges, durable state, one human-gate node, retries. No parallelism, no loops, no sub-workflows yet.

**Phase 5 — Memory + Context Builder.** FTS5 first. Embeddings last, and only if measurement justifies them.

**Phase 6 — Execution + Evidence.** Every run produces an append-only record. The UI is built against that record and nothing else.

**Phase 7 — Overseer + local JEV.** Deterministic selection first; advisory model ranking second.

**Phase 8 — MCP client + connectors.**

**Phase 9 — Self-expansion.** Only after Phases 2–6 have demonstrably worked.

**Phase 10 — Reflection.** Shadow mode before enforce mode.

---

## 8. Open questions and UNKNOWNs

- **UNKNOWN — MLHSM's intent for third-party modules.** The design (manifest-cannot-grant-routes, compiled-in registry) is coherent and deliberate. Whether MLHSM intends to add a real extension point later is unknown and not my call. If it does, this architecture moves to `SUPPORTED` with a thin adapter and little rework — the HTTP client boundary is the same shape.
- **UNKNOWN — whether `MlgsmModule` establishes a precedent for domain modules that ought to become external.** MLGSM is a large domain (`/api/v1/games/*`, ~22k lines of API) living inside `hsm-core`. That is a design question for MLHSM's author, not something TEAhub should assume.
- **Assumption to verify — `POST /api/v1/modelmesh/chat` request/response schema.** The route exists and is public. Its exact contract was not traced to a type in this audit. **Verify before building Phase 1.**
- **Assumption to verify — auth token acquisition for a non-browser client.** `API_TOKEN_ACCOUNT` exists as a credential-store key (`auth.rs:25`), but the flow for provisioning it programmatically is unconfirmed.

---

## 9. Final answer

**What TEAhub is:** a private, embedded-first AI capability platform. A single Rust (or TypeScript) process, one directory, SQLite for state, that discovers, validates, composes, executes and safely expands capabilities — and that treats its model layer as a *client* of MLHSM's existing ModelMesh rather than a second implementation of it.

**How the pieces interact:** the Overseer turns a goal into a workflow; the Capability Registry resolves what it needs; the Policy Engine authorises each action deterministically; the Workflow Engine executes durably, pausing at human gates; the Context Builder assembles budgeted context from Memory; the Model Client delegates to MLHSM; every step lands in an append-only Evidence record that the UI is forbidden to contradict.

**What exists already:** model discovery, provider keys, routing, and JEV-based model selection — all in MLHSM. Signed registries (genus-os), danger-class consent (starnet), RRF memory fusion and bi-temporal memory (sochdb), durable workflow claims (laborforge), MCP discipline (genus-os, agentic-os), drift detection, and fail-closed guard design.

**What must be built:** the registry, policy engine, workflow engine, memory + context builder, evidence store, and the local decision layer. None of these exist in MLHSM, and none can be hosted there.

**How TEAhub relates to MLHSM without modifying it:** it doesn't, as a module. That is `BLOCKED` — three hardcoded points, no dynamic registration, by design. What TEAhub can do, and should, is run beside MLHSM on localhost and consume its documented HTTP API, using the ModelMesh that MLHSM already ships. That is less integration than the brief imagined, and it is the largest amount of integration that is honestly available.
