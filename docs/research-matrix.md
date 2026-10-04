# STEP 2–4 — Research Matrix

**Datum:** 2026-10-02
**Vollständige Berichte:** `E:\Lukas\_research\step2-4\*.md` (A–E, ~3.000 Zeilen)
**Methode:** Repos geklont und gelesen, nicht READMEs zusammengefasst. Lizenzen geprüft.

---

## A — Agent Runtime & Coding Agents

| Projekt | LOC | Gelöstes Problem | Verdikt |
|---|---|---|---|
| OpenHands/OpenHands | 0 py | **Kein Framework mehr — Control-Panel.** 9 .py-Files, `package.json` = `@openhands/agent-canvas` | **REJECT** |
| OpenHands/software-agent-sdk | 158.756 | Event-basierte Runtime, Branching, Condensation | **ADAPT** |
| openai-agents-python | 143.394 | Guardrails, Handoffs, MCP | **ADAPT** |
| openai-agents-js | 169.624 | dasselbe in JS | INSPIRE |
| pydantic-ai | 254.626 | Zustandsmaschinen-Loop, SSRF, Approval | **ADAPT** |
| letta *(detached HEAD)* | 150.310 | Memory-Blöcke, Tool-Regeln, Step-Persistenz | **ADAPT** |
| hermes-agent | 1.559.791 | Produktions-Kompression, Provider-Recovery | INSPIRE |
| openclaw | 2.760.784 | Pluggable Context-Engines | INSPIRE |
| SWE-agent | 12.691 | SWE-bench-Harness | INSPIRE |
| aider | 25.151 | PageRank-Kontext, Edit-Formate | ADAPT |
| open-swe | 188.059 | GitHub/Slack-PR-Bot | REJECT |
| browser-use | 66.795 | Browser-Steuerung, Loop-Detection | ADAPT |
| **simonw/llm** | 16.490 | Tool-Semantik + Plugins | **ADAPT** |
| **anyio** | 16.455 | Cancellation Scopes | **ADOPT** |
| **humanlayer** | 102.152 | Approval-Protokoll | **ADAPT** |

## B — Orchestration & Durable Workflows

| Projekt | LOC | Gelöstes Problem | Verdikt |
|---|---|---|---|
| **langgraph** | 74.494 | BSP-Graph + Checkpointing + `interrupt()`-HITL | **ADOPT** |
| **dbos-transact-py** | 15.967 | Temporal-Kern in SQLite, Crash-Recovery per Step-Memo | **ADOPT** |
| **crewAI** | 338.943 | Dekorator-Graph + SQLite-State, `@human_feedback` (State nur 1.417 LOC) | ADAPT |
| restate | 316.055 | Journal-Replay + Epoch-Fencing | INSPIRE — **BSL 1.1 ⚠** |
| inngest | 320.530 | Generator/Opcode-Protokoll | INSPIRE — **SSPL ⚠** |
| **temporal** | 787.517 | Replizierte event-sourced Distributed-Runtime | **REJECT** |
| agent-framework | 474.849 | Delegiert Dauerhaftigkeit an Azure | REJECT |
| prefect | 674.640 | Server-Orchestrator | REJECT |
| hatchet | 583.320 | Task-Queue mit durable events | INSPIRE |
| autogen | 117.677 | Message-Passing, **kein Checkpointer** | REJECT |
| camel / agentscope / langchain | 152k/114k/217k | Bibliotheken ohne Dauerhaftigkeit | REJECT |

## C — Sandboxing & Security

| Projekt | LOC | Isolationsmechanismus | Verdikt |
|---|---|---|---|
| E2B | 131.697 | Firecracker-microVM + cgroup + nftables-Egress | ADOPT (Muster) / REJECT (Windows) |
| **daytona** | **0** | **OSS eingestellt 06/2026, AGPL-3.0** | **REJECT** |
| modal-examples | 46.099 | gVisor oder VM, wählbar | INSPIRE |
| gVisor | 954.053 | Sentry-Go, kein CGo | INSPIRE (Linux) / REJECT (Windows) |
| Firecracker | 182.181 | KVM + seccomp-BPF + jailer | INSPIRE (Spec) / REJECT (Windows) |
| **mxc** | 328.218 | **AppContainer + DACL, Job Objects** | **ADOPT (Schema)** |
| wassette | 100.542 | Wasmtime-Capabilities | ADOPT (nur MCP-Tools) |
| guardrails | 45.705 | Output-Rails ja, Injection-Validator **nein** | ADAPT |
| **NeMo-Guardrails** | 236.011 | **RailOutcome ALLOW/BLOCK/TRANSFORM, fail-closed** | **ADOPT** |
| presidio | 66.370 | PII-Anonymisierung | **ADOPT** (Audit-Logs) |

## D — Observability, Gateway, Plattformen

| Projekt | LOC | Gelöstes Problem | Verdikt |
|---|---|---|---|
| Langfuse | 876.687 | Voll-Observability, **ClickHouse** | INSPIRE / REJECT |
| Phoenix | 870.094 | OTel-Traces, Elastic-2.0 | INSPIRE / REJECT |
| **Vercel AI SDK** | 163.748 | **Provider-*Spezifikation*, kein Gateway** | **ADOPT** |
| **LiteLLM** | 2.984.883 | Provider-Abstraktion + Router | **ADAPT als Library** |
| Portkey Gateway | 71.375 | Minimal-Proxy, Routing = 156 Zeilen, Cache = 113 Zeilen | ADAPT |
| **Dify** | 1.915.479 | **`workflow_node_executions` = 18 Felder, append-only** | **ADAPT** |
| **Haystack** | 126.332 | Austauschbare Komponenten, Token-Fallback | **ADOPT** |
| Semantic Kernel | 445.822 | Filter-Pipeline | ADAPT |
| Flowise | 279.488 | Node-Editor | INSPIRE / REJECT |
| LlamaIndex | 397.709 | Ingestion/RAG | INSPIRE |
| Promptfoo | 954.973 | Evals als Code | ADAPT |

## E — Eigene Repositories

| Repository | Gefunden | Stack | LOC | Wiederverwendbar |
|---|---|---|---|---|
| **TEAui** | ja | React 19.2, TS 5.9, Radix, Tailwind, Vitest | 25.8k | **Ja — sofort installierbar, kein Portieren** |
| **OCTEAFORK** | ja, Branch `dev` | Bun + Turbo + Effect-TS + drizzle/SQLite | ~523k | **Ja — `packages/llm/`, `CONSTRAINTS.md`** |
| MLHSM-MODULES | ja | JSON-Registry + Schema + Validator | 312 | **Ja — Manifest-Isolationsvertrag** |
| **StarNet** | ja, **0 Commits** | Node-Sidecar + Tauri | 470k | **REJECT als Baustein — nur Code-Inspiration** (Vom Owner festgelegt. Nichts portieren, nichts einbauen. `permissions.js`/`challengegate.js`/`budget.js` sind als *Muster* lesbar, nicht als Komponenten übernehmbar.) |
| LUTEADESIGNDASHBOARD | ja, **86 uncommittet** | Next 15.5, React 19, better-sqlite3, zod | 8.2k | Teilweise — `overseer/{control,gate}`, Auth/RBAC |
| TEAflow | ja, lokal | Rust (Gecko) + TS, MCP-Server | 8.5k | Teilweise — `packages/policy`, `packages/mcp` |
| OC-TEA | ja | unveränderter OpenCode-Fork | 664k | **Nein — null TEA-Spezifika** |
| MLHSM (Remote) | **NEIN** — `Repository not found` | — | — | nicht bewertbar |

---

## Fünf Fallen, in die wir ohne diese Recherche gegangen wären

**1. LangGraph `interrupt()` führt den ganzen Knoten erneut aus.** Alle Side-Effects davor laufen doppelt. **Regel: nie ein `interrupt()` in einen Knoten mit einem LLM-Call legen.** Die Step-Memo-Tabelle ist die Gegenmaßnahme.

**2. OpenHands/OpenHands ist kein Framework mehr.** Der Name führt zu einer Web-UI; die Runtime liegt in `software-agent-sdk`. Wer dem Repo-Namen folgt, klont die falsche Sache.

**3. Der Vercel AI SDK ist kein Gateway.** `@ai-sdk/gateway` ist ein *Client* für Vercels gehosteten SaaS, setzt selbst nur `specificationVersion = 'v4'`. Routing, Fallback, Cooldown: **null vorhanden** — der Fundstelle für `fallback` trifft nur Tests. Von 81 Paketen sind 66 Provider. Die Stärke ist die *Spezifikation*, nicht ein Router.

**4. Daytona ist tot** (OSS eingestellt 06/2026, AGPL-3.0). **Restate ist BSL 1.1**, **Inngest ist SSPL** — beide verbieten bzw. erschweren einen öffentlichen Platform-Service. Lizenzprüfung vor Architekturprüfung.

**5. Cancellation ist die schwächste Achse im gesamten Feld.** Jede Runtime löst sie anders, keine nutzt `CancelScope`. openai-agents braucht einen Shim, um `CancelledError` aus `__context__` zu graben.

## Größenkorrekturen

| Behauptung im Briefing | Befund |
|---|---|
| Temporal als Durable-Execution-Vorbild | **~500× überdimensioniert.** 766k Go-Zeilen kaufen 7 Dinge, **null davon** werden gebraucht. Kleinster sinnvoller Betrieb: 4 Prozesse + Cassandra + UI, 2–4 GB RAM. |
| `dbos-project/dbos` | **existiert nicht.** `dbos-transact-py` existiert (MIT, 15.967 LOC). Briefing war falsch. |
| Observability braucht eine Plattform | **Postgres reicht.** Dify ist der Beweis: 18 Felder, append-only, normale Indizes. Aber **2–4 schmale Tabellen**, nicht eine. ClickHouse kommt *nicht* wegen vieler Spans, sondern wegen Ad-hoc-Aggregation über Milliarden Zeilen. |
| Sandbox ist das Problem | **Sandbox blockiert den MVP auf Windows nicht.** MXC `processcontainer` (AppContainer + DACL) läuft ab Windows 11 24H2 **ohne Admin**. Aber: kein Default-Deny-Egress ohne Elevation. |
| Ein Gateway ist groß | **Ein Gateway ist klein**, wenn Routing Konfiguration statt Optimierung ist: Portkey = 156 Zeilen Routing, 113 Zeilen Cache. |

## Kleinste korrekte Dauerhaftigkeit (aus B)

~250 LOC. Drei Tabellen (`runs`, `steps`, `gates`). Drei Primitive
(`checkpoint()`, `gate()`, `resume()`). SQLite. Ein Versions-Hash aus
`sha256(flow_module)` — mit **lauter Verweigerung** statt divergierendem Replay.

**Der MVP braucht NICHT:** Event-Sourcing, deterministisches Replay,
History-Log, Task-Queue-Engine, Plugin-Registry, visueller Designer, Nexus,
Worker-Deployments, Cron-Schedules.

## Was der Audit bereits in TEAhub vorhanden ist

| Baustein | Herkunft | Verdikt |
|---|---|---|
| Policy-Hierarchie `deny → require_human → allow` | eigener Entwurf | deckt sich mit NeMos `RailOutcome` |
| Digest-Pinning beim Enable | eigener Entwurf | kein Vorbild gefunden — bleibt Eigenlösung |
| Trust-Tiers mit Senkung | eigener Entwurf | passt |
| Manifest-Isolationsvertrag | MLHSM-MODULES | **direkt übernehmen** |
| `openai-compatible.ts` = 900 Bytes | OCTEAFORK `packages/llm/` | **Muster übernehmen** |
| Komponentenbibliothek | TEAui | **installieren, nicht portieren** |
| Consent-Broker mit E-STOP | StarNet | **nur Inspiration, kein Import** |

## Vom Owner festgelegt

- **StarNet ist ausschließlich Code-Inspiration.** Kein Baustein, kein Import,
  keine Portierung. Wertvoll sind die *Muster*, nicht die Dateien.
- **TEAhub ist am Ende browserbasiert.** Die UI ist eine Web-Anwendung. Das
  Backend bleibt Server-seitig, weil Secrets, Policy-Entscheidungen und die
  Datenbank nicht in den Browser gehören (§36, §38).

## Offen und nicht verifiziert

- **LUTADESIGNDASHBOARD hat 86 uncommittete Änderungen** inkl. laufender Radix-Migration
- **StarNet hat 0 Commits** — die Historie ist unwiederbringlich weg
- `mlhsm/ModelMesh` als OpenAI-kompatibler Endpoint existiert **noch nicht** (kein `/v1/`, kein `/chat/completions` in MLHSM)
- Lizenzfreigabe für jede ADOPT-Empfehlung steht aus
