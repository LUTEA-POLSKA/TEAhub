# TEAhub — Handoff

**Datum:** 2026-10-06
**Branch:** `main` @ `c4ce3f7` (lokal, nicht gepusht)
**Status:** Vertikaler Schnitt implementiert, UI + Worker-Entrypoint offen

---

## Projekt

TEAhub — lokale, browserbasierte AI-Agent-Plattform. Der Nutzer erstellt Tasks, ein Agent führt sie aus, menschliche Gates unterbrechen bei kritischen Aktionen.

**Repo:** `https://github.com/LUTEA-POLSKA/TEAhub` (private)
**Remote:** `origin/main` — lokaler Stand ist **1 Commit voraus** (`c4ce3f7` nicht gepusht)

---

## Stack

| Layer | Technologie |
|---|---|
| Runtime | Node 22, TypeScript 5.9 (strict, verbatimModuleSyntax) |
| Framework | Next.js 15 (App Router) |
| Package-Manager | pnpm 12.9.1 (via corepack, prefix `~/.npm`) |
| DB | PostgreSQL (PGlite für Tests, node-postgres für Prod) |
| ORM | Drizzle ORM 0.44 |
| Schema-Migration | drizzle-kit 0.31 |
| Tests | Vitest 3.2 |
| AI-SDK | Vercel AI SDK 5 + @ai-sdk/openai 2 |
| UI | shadcn/ui + TEAui (installierbar, noch nicht integriert) |

---

## Verzeichnisstruktur

```
TEAhub/
├── src/                          # Rust-Referenz (eingefroren, nicht mehr gebaut)
│   ├── policy.rs                 # 698 Zeilen, 18 Tests — Vertrag für TS-Port
│   ├── capability/               # Digest, Manifest, Validate
│   ├── model/                    # MLHSM/OpenAI/Mesh-Clients
│   └── registry/                 # 810 Zeilen
├── web/                          # TypeScript-Ziel
│   ├── src/
│   │   ├── app/                  # Next.js App Router
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx          # Landing mit API-Übersicht
│   │   │   └── api/
│   │   │       ├── auth/login/route.ts
│   │   │       ├── auth/logout/route.ts
│   │   │       ├── auth/me/route.ts
│   │   │       ├── tasks/route.ts
│   │   │       ├── tasks/[id]/cancel/route.ts
│   │   │       ├── approvals/route.ts
│   │   │       ├── approvals/[id]/route.ts
│   │   │       └── health/route.ts
│   │   └── server/
│   │       ├── auth/auth.ts      # scrypt, Sessions, CSRF, Rate-Limit, AuthZ
│   │       ├── http/
│   │       │   ├── config.ts     # Env-Loading, fail-closed
│   │       │   ├── guard.ts     # withGuard / withPublicGuard
│   │       │   └── routes/
│   │       │       ├── auth.ts
│   │       │       ├── tasks.ts
│   │       │       ├── approvals.ts
│   │       │       └── state.ts
│   │       ├── db/
│   │       │   ├── schema.ts    # 8 Tabellen, Drizzle
│   │       │   ├── schema.test.ts
│   │       │   ├── task-store.ts
│   │       │   ├── task-store.test.ts
│   │       │   └── audit-sink.ts
│   │       ├── policy/
│   │       │   ├── policy.ts    # Port aus Rust, 20 Tests
│   │       │   └── policy-rules/ # 6 Kategorien
│   │       ├── tools/
│   │       │   ├── types.ts
│   │       │   ├── filesystem.ts
│   │       │   ├── web-fetch.ts
│   │       │   ├── runner.ts
│   │       │   └── tools.test.ts
│   │       ├── agent/
│   │       │   ├── types.ts
│   │       │   └── runtime.ts
│   │       └── ai/
│   │           ├── router.ts
│   │           └── openai-compatible.ts
│   ├── drizzle/                  # Migrationen
│   ├── package.json
│   ├── tsconfig.json
│   └── vitest.config.ts
├── docs/
│   ├── audit-step1.md
│   ├── research-matrix.md
│   ├── architecture-proposal.md
│   └── adr/
│       ├── 0001-stack-typescript.md
│       └── 0002-mvp-entscheidungen.md
├── .env.example
├── .gitignore
└── pnpm-workspace.yaml
```

---

## Datenmodell (8 Tabellen)

| Tabelle | Zweck |
|---|---|
| `users` | id, email, name, role (admin/user), passwordHash |
| `sessions` | id (SHA-256 von Token), userId, expiresAt |
| `agents` | id, name, systemPrompt, systemPromptVersion, tier, enabled, trustScore |
| `agent_permissions` | agentId, tools[], toolConstraints |
| `tasks` | id, title, status, requestedBy, agentId, input, flowHash, output, error |
| `task_steps` | taskId, stepNo, stepIndex, kind, state, result, error |
| `approvals` | taskId, stepId, toolName, arguments, decision, decidedBy, decidedAt |
| `audit_events` | id, timestamp, actorType, actorId, taskId, stepIndex, action, target, outcome, detail |

**Kritische Constraints:**
- `UNIQUE(task_id, step_index)` auf `task_steps` — Step-Memo
- `audit_events` hat kein `updated_at` — append-only by shape
- `sessions.id` ist SHA-256 vom Token — DB-Leck liefert keine Sessions

---

## Policy Engine

Portiert aus `src/policy.rs` (Rust). 18 Tests als Vertrag.

**Verdicts:** `allow` | `require_human` | `deny`

**Prioritäten:** deny > require_human > allow > no rule (→ deny)

**Trust-Tiers:** builtin (0) > local (1) > third_party (2) > untrusted (3)

**6 Rule-Kategorien** (aus Automaton-Port):
1. authority — Mindest-Tier pro Tool
2. command_safety — Forbidden-Patterns, Self-Mod-Rate-Limits
3. financial — Transfer-Limits, Mindestreserve
4. path_protection — Geschützte/sensitive Pfade
5. rate_limits — Pro Turn/Session/Stunde/Tag
6. validation — Input-Format-Validierung

---

## Agent Runtime

Loop: Modell-Call → Tool-Calls → Policy-Check → Execute/Block/Gate → Repeat

**Memoisation:**
- `task_steps` mit `UNIQUE(task_id, step_index)` verhindert Doppel-Ausführung
- `stepNo` = logischer Schritt, `stepIndex` = Reihenfolge
- Resume: `firstIncompleteStep()` findet ersten unvollständigen Schritt

**Cancellation:**
- DB-Flag `cancel_requested_at` (überlebt Prozess)
- `AbortSignal` für laufende Calls

**Budgets:** maxSteps, maxOutputTokens, maxCostUsd

---

## SSRF-Schutz (web-fetch)

1. DNS-Auflösung → alle Adressen prüfen (private/loopback/link-local blockiert)
2. Redirects manuell folgen, jeder Hop erneut validiert
3. Content-Type whitelist (text/*, application/json, application/xml)
4. Body-Größenlimit

**Bekannte Lücke:** TOCTOU zwischen DNS-Check und eigentlichem Request

---

## Auth

- scrypt (N=16384, r=8, p=1) für Passwörter
- Session-Token: 256-bit random, als SHA-256 in DB
- Cookie: `__Host-` Prefix, HttpOnly, SameSite=Strict, Secure
- Rate-Limit: 5 Versuche / 15 Min pro Email
- AuthZ: admin-only für `approval.decide`, `agent.*`, `user.create`, `task.cancel.others`

---

## Entscheidungen (ADRs)

### ADR-0001: TypeScript-Stack
Next.js + pnpm + Drizzle + PostgreSQL. Rust-Code bleibt als Referenz.

### ADR-0002: MVP-Entscheidungen
- Vertikaler Schnitt als erster Meilenstein
- Bedarfsgesteuertes Portieren (nicht alles vorab)
- 2 Rollen (admin/user)
- UI-Skelett früh, parallel
- PGlite für Tests, echtes Postgres für Prod
- Provider config-gesteuert, ModelMesh = Kandidat

---

## Forschung

Vollständige Berichte unter `E:\Lukas\_research\step2-4\`:
- `REPORT.md` — Memory/MCP
- `A-agent-runtime.md` — 15 Runtimes
- `B-orchestration.md` — Durable Execution
- `C-sandbox-security.md` — Sandboxing/Guardrails
- `D-observability-gateway.md` — Provider-Layer
- `E-own-repos.md` — Eigene Repositories

**Wichtigste Forschungserkenntnisse:**
- `hashToken` war kein Hash (randomBytes + plaintext)
- Fixed-stride Step-Layout kollidiert bei >2 Tool-Calls
- `ProviderUnavailableError` wurde von Runtime geschluckt
- Vercel AI SDK = Spezifikation, kein Gateway
- PGlite = echtes Postgres nach WASM, kein zweiter Dialekt

---

## Offen / Nächste Schritte

### Sofort
1. **types.ts Syntax-Fehler beheben** — `export type RuleConfig` doppelt (Zeile 106 + 127)
2. **Commit pushen** — `c4ce3f7` ist lokal, nicht auf Origin

### Kurzfristig
3. **UI-Skelett** — Login, Task-List, Approval-Panel mit TEAui/shadcn
4. **Worker-Entrypoint** — `worker/src/index.ts` mit Signal-Handling, Tick-Loop, Health-Check
5. **Provider-Konfiguration** — `.env` mit OpenRouter-Key, Modell-Auswahl

### Mittelfristig
6. **E2E-Tests** — Login → Task → Approval → Resume
7. **Security-Audit** — Auth, CSRF, SSRF, Path-Traversal
8. **Performance-Test** — Last-Test auf echtem Postgres

### Langfristig
9. **Memory-System** — 5-Tier-Modell aus Automaton-Port
10. **Heartbeat-Daemon** — Scheduled Tasks, Credit-Monitoring
11. **Self-Modification** — Audit-logged, git-versioned

---

## Befehle

```bash
# Tests
cd web && pnpm test

# Typecheck
cd web && pnpm typecheck

# Dev-Server
cd web && pnpm dev

# Migration generieren
cd web && pnpm db:generate

# Migration ausführen
cd web && pnpm db:migrate
```

---

## Umgebung

- **OS:** Windows 11, PowerShell 5.1
- **Node:** v24.19.0
- **pnpm:** 12.9.1 (via corepack, prefix `~/.npm`)
- **Podman:** 5.8.3 installiert, aber Machine nicht gestartet
- **Docker:** Nicht installiert
- **Postgres:** Nicht installiert (PGlite für Tests verwendet)
