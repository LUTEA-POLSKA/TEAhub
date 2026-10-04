# STEP 5–7 — TEAhub MVP-Architektur

**Datum:** 2026-10-02 · **Bezug:** §19, §25, §28, §56 · **Grundlage:** docs/audit-step1.md, docs/research-matrix.md

---

## 1. Die eine Entscheidung, die alles bestimmt

**Ein Prozess führt Agent-Loops aus, nicht der Request.**

Ein Human Gate kann Tage offen bleiben. Ein Task muss Prozess-Neustarts und
Request-Grenzen überleben. Also liegt der Zustand in der Datenbank und ein
eigener Worker holt sich Arbeit — nicht die Route Handler.

**Folge:** kein Monorepo. Eine Next.js-App für UI+API, **ein** Worker-Prozess.
§28 bietet `apps/web` + `packages/*` + `worker/` an, sagt aber selbst „keine
künstliche Monorepo-Komplexität, wenn sie keinen Vorteil bringt". Neun Pakete
für eine App und einen Worker bringen keinen Vorteil — sie bringen neun
Versionierungsfragen.

```
TEAhub/
├── src/
│   ├── app/                 Next.js App Router (UI + Route Handlers)
│   │   └── (dashboard)/     Tasks, Agents, Approvals, Audit
│   ├── server/              Server-only: DB, Policy, Agent, Tools
│   │   ├── db/              Drizzle-Schema und Queries
│   │   ├── auth/            Session, Rollen
│   │   ├── policy/          allow / require_human / deny — fail-closed
│   │   ├── agent/           Loop, Context, Cancellation
│   │   ├── tools/           filesystem.read/write, web.fetch
│   │   ├── ai/              Provider-Interface, Routing
│   │   └── audit/           append-only Event-Schema
│   └── lib/                 geteilte Typen, keine Logik
├── worker/                  Ein Node-Prozess, holt queued Tasks
├── packages/ui/             TEAui (installiert, nicht portiert)
└── docs/
```

## 2. Datenmodell — 10 Tabellen, keine mehr

§34 verlangt `users, sessions, tasks, agents, agent_permissions, tools,
approvals, audit_events, provider_metadata`. Ergänzt um die Dauerhaftigkeit aus
der Research:

| Tabelle | Zweck |
|---|---|
| `users` / `sessions` | Auth |
| `tasks` | Status `queued/running/waiting_approval/completed/failed/cancelled` |
| **`task_steps`** | **Die Dauerhaftigkeit.** Ergebnis + Zustand, append-only |
| **`approvals`** | Gate-Entscheidung, getrennt von `task_steps` (CrewAI-Muster) |
| `agents` / `agent_permissions` | Registry + Rechte |
| `tools` | Registry mit Schemata |
| **`tool_grants`** | **Was ein Agent tatsächlich darf** — getrennt von Deklaration |
| `audit_events` | append-only, nie UPDATE |
| `provider_metadata` | Provider, Modelle, Preise |

**Aus der Research übernommen:**

- `task_steps` bekommt einen **Step-Memo**: `unique(run_id, step_index)`.
  Ohne das läuft ein LLM-Call nach einem Crash doppelt. Das ist die Gegenmaßnahme
  zur `interrupt()`-Falle aus LangGraph.
- `approvals` steht in einer **eigenen Tabelle**, nicht als Feld am Task.
  CrewAI trennt das ebenfalls, und es macht „welche Gates warten" zu einer
  Abfrage statt zu einem Scan.
- **Keine `trace`-Bäume.** `trace_id` + `parent_observation_id` ist eine
  rekursive FK-Kette; Dify nutzt flach `index` + `predecessor_node_id`. Im MVP
  gibt es keine SDK-Grenze zu debuggen, für die der Baum den Aufpreis wert wäre.
- **Keine Event-Sourcing-Pflicht.** Ein Task-State, ein Step-Ergebnis, ein
  Gate. Mehr braucht der MVP nicht.

## 3. Dauerhaftigkeit — ~250 LOC, nicht Temporal

Aus Research B, als Minimum:

```ts
checkpoint(runId, stepIndex, result, stateJson)  // eine Transaktion
gate(runId, toolCall)                            // erzeugt approval, status → waiting_approval
resume(runId, approvalId, decision)              // idempotent
```

**Der Versions-Hash.** `sha256(flow_definition)` wird beim Task-Anlegen
festgehalten. Beim Resume muss er passen, sonst **wird der Task laut verweigert**
statt mit divergierendem Replay fortgesetzt. Ein still divergierender Replay ist
die Art von Fehler, die man sechs Monate später sucht.

**Regel aus der Research, die gilt:** niemals ein Gate in einen Knoten legen,
der einen LLM-Call enthält. Beim TEAhub-Layout heißt das: ein Step endet mit
`gate()`, nie mitten in einer Tool-Kette.

## 4. Policy — ALLOW / REQUIRE_HUMAN / DENY, fail-closed

Aus meinem bestehenden Entwurf, bestätigt durch NeMos `RailOutcome`:

```
requested (Agent-Deklaration)
    ∩
tier policy (Agent-Tier)
    ∩
tool_grants (was tatsächlich erteilt ist)
    =
effective (was der Agent tun darf)
```

Drei Schnitte, jeder kann nur verkleinern. **Kein Schnitt kann erweitern.**

- **Kein Modell im Entscheidungspfad.** Ein LLM darf anfragen, nie erlauben.
- **Unbekannt = DENY.** Kein Tier, keine Regel, kein Schema → abgelehnt.
- **Eskalation geht zum Menschen, nicht zur Fehlerbehebung.** Ein `REQUIRE_HUMAN`
  endet in `waiting_approval` und wartet — es wirft nicht.
- **Keine Bypass-Sequenz existiert im Code.** Der Agent bekommt keinen Pfad
  zum Policy-Code; die Route, die ein Tool aufruft, ist die einzige, und sie
  prüft.

## 5. Agent Runtime — das Minimum aus 15 Frameworks

Aus Research A. Der MVP-Loop ist eine Zustandsmaschine, kein Framework:

```
while (nicht fertig && budget nicht erschöpft) {
  Modell aufrufen
  wenn Tool-Call:
      Policy prüfen
      wenn DENY          → Fehler zurückgeben, Loop läuft weiter
      wenn REQUIRE_HUMAN → gate(), Task pausiert, ENDE
      wenn ALLOW         → Tool ausführen, Ergebnis anhängen
  sonst: fertig
}
```

**Übernommen:**

- **Tool-Fehler sind Werte, keine Exceptions** (`simonw/llm`). Ein fehlgeschlagener
  Tool bricht den Durchlauf nicht ab — das Modell darf reagieren.
- **Cancellation via `AbortSignal`** (`anyio`-Muster). Der einzige `ADOPT` aus
  der Runtime-Research, weil Cancellation sonst die schwächste Achse wird.
- **`finish_reason == "length"` prüfen.** Nur 1 von 13 Frameworks macht das
  (`letta`). Ohne diese Prüfung hält ein abgeschnittener Output eine Task
  scheinbar erfolgreich am Leben.
- **Nur ein Agent im MVP.** kein Swarm, keine Delegation.

**Abgelehnt:** Graph-Engine im MVP. Ein einzelner Agent ist eine Schleife. Ein
Graph lohnt sich erst bei Parallelität, Retry auf Knotenebene und
Sub-Workflows — der MVP hat keinen davon dieser Art.

## 6. Tools — drei, alle begrenzt

§30 sagt: kontrolliert, kein generischer Shell-Executor. Beliebig wäre aber zu
wenig für echte Arbeit.

| Tool | Grenze | Wo durchgesetzt |
|---|---|---|
| `filesystem.read` | Allowlist-Verzeichnisse, kanonischer Pfad, Größenlimit | Server, im Worker |
| `filesystem.write` | dieselbe Allowlist, **Human Gate** bei Überschreiben | Policy + Gate |
| `web.fetch` | **SSRF-Schutz**, keine privaten IPs, Redirect-Validierung, Größenlimit | Server |

**Aus der Sandbox-Research übernommen:** der häufigste ungelöste Punkt ist die
Validierung von Shell-*Ergebnissen*. Für `web.fetch` heißt das: **Content-Type
prüfen, nicht nur Status 200.** Ein HTTP 200 mit `text/html` von einem internen
Dienst ist ein Datenleck.

**Sandbox:** MXC `processcontainer` (AppContainer + Job Objects) läuft ab
Windows 11 24H2 ohne Admin und ist damit der Kandidat für Worker-Exec. Aber
der MVP braucht ihn nicht — die Tools sind begrenzt, es gibt keinen
freien Shell-Zugriff, den man isolieren müsste. **Isolation kommt, wenn es
etwas zu isolieren gibt.**

## 7. AI Provider Layer — SDK plus 150 Zeilen Routing

Aus Research D: der Vercel AI SDK ist ein **Provider-Vertrag**, kein Gateway.
Also selbst bauen, aber klein:

```ts
Requirement { effort, cost, tools, vision, context } → geordnete Kandidatenliste
```

Das ist der Mesh-Kern aus meinem Rust-Entwurf, auf TypeScript portiert:
Requirement-Ranking, geordnete Fallback-Kette, **bekannter Preis = bekannt,
unbekannter Preis = unbekannt, nie `0`**.

### ModelMesh ist ein Kandidat, nicht der Provider

Vom Owner festgelegt: TEAhub begrenzt sich **nicht** auf ModelMesh. Die
Kandidatenliste ist config-gesteuert, jeder OpenAI-kompatible Endpoint kommt
darin vor. Es gibt **keinen TEAhub-Code, der ModelMesh kennt** — nur `baseUrl`
plus Key.

```
Requirement ──► Ranking ──► [ollama, openrouter, mistral, modelmesh, …]
                                 │
                                 ├─► health + preis + Fähigkeiten prüfen
                                 ├─► erster Treffer gewinnt
                                 └─► bei Fehler: nächster Kandidat
```

**Konsequenz für den MVP-Start:** ModelMesh wird **nicht** benötigt, um
TEAhub zu bauen oder zu testen. `ollama` (lokal, ohne Key) oder ein
OpenRouter-/Mistral-Key genügen, weil der Codepfad derselbe ist. ModelMesh
kommt dazu, wenn sein `/v1`-Endpoint existiert — dann ist es eine Zeile in
`.env`, kein Feature.

**Was das für die Fallback-Kette bedeutet:** Ein Fehlschlag darf nicht als
Aufgabe fehlschlagen, solange ein Kandidat übrig ist. Aber ein Fehlschlag
**mit** leerem Kandidaten-Set ist ein Aufgabenfehler, kein Providerfehler. Diese
Unterscheidung entscheidet, ob der Nutzer eine Meldung über seinen Task sieht
oder über seinen Provider.

## 8. Audit — append-only, PII redigiert

Aus Research D (Dify: 18 Felder, Postgres reicht) und Research C (presidio):

- `audit_events`: **append-only**, kein UPDATE, kein DELETE
- `provided_by`, normalisierte Kosten, TTFT — die drei billigen Pflichtfelder
  aus Langfuse
- **Keine Secrets im Log.** Presidio für PII-Redaktion vor dem Persistieren
- Jede Zeile: `user → task → step → agent → model → tool_call → policy →
  approval → result`. Die Kette aus §35, als Fremdschlüssel, nicht als Text.

**Observability bleibt eine Tabelle.** Kein ClickHouse, kein OTLP-Receiver,
kein Collector. §47 sagt „bereite Architektur vor", nicht „baue eine Plattform".

## 9. Was aus §25 fehlt und warum

Alles ist enthalten. Kein Posten aus §25 wird gestrichen — aber **Auth ist
bewusst auf eine einzige Rollenidee reduziert** (`admin` | `user`), weil §37
„jede kritische Aktion serverseitig autorisiert" verlangt und nicht ein
Rollenmodell mit fünf Stufen.

## 10. Entfernte Komplexität

| Kandidat | Warum weg |
|---|---|
| Monorepo mit 9 Paketen | keine Trennung nötig, §28 erlaubt es ausdrücklich |
| Graph-Engine (LangGraph) | ein Agent = eine Schleife |
| Temporal / DBOS / Prefect | ~500× zu groß für einen Task + ein Gate |
| ClickHouse / Langfuse / Phoenix | Postgres reicht, Dify ist der Beweis |
| LiteLLM als Server | als *Library* ja, als Dienst nein — §26 verbietet unnötige Dienste |
| Sandbox-Stack im MVP | es gibt nichts zu isolieren |
| MCP im MVP | §26 nicht genannt, §30 sagt drei Tools |
| Multi-Agent, Delegation | §26 verbietet es |
| Registry-Signaturen (Ed25519) | §45: für einen lokalen Einzelbenutzer ist `digest` + Human Gate die reale Bedrohung, PKI ist es nicht |

## 11. Reihenfolge — gegenüber §50 geändert

§50 nennt Auth (Phase 5) vor der Datenbank (Phase 6). Das ist falsch: **Auth
ohne Datenbank hat nichts, woran es hängt**, und der Session-Speicher *ist* die
Datenbank.

| # | Phase | Begründung der Reihenfolge |
|---|---|---|
| 1 | Schema + Migrationen | alles andere hängt daran |
| 2 | Auth + Session | braucht Phase 1 |
| 3 | Policy-Engine | vor jedem Tool und jeder KI-Ausführung |
| 4 | AI-Provider-Layer | vor dem Agenten |
| 5 | Tools + Audit | vor dem Agenten |
| 6 | Agent-Runtime | braucht 3, 4, 5 |
| 7 | Task Engine + Worker | braucht 6 |
| 8 | Human Gate | Teil von 7, aber eigene Tests |
| 9 | UI | kann parallel zu 7 laufen |
| 10 | E2E, Security-, Performance-Audit | §15, §16, §17 |

## 12. Was diese Architektur blockiert

Nichts aus der Langfrist-Vision (§57). Zwei Dinge bewusst:

- **Modellkontext für Agenten** fehlt (Kontrakt, Kompression, Token-Zählung).
  Der MVP baut das Rad neu; die Research zeigt drei Ansätze (openhands-Condenser,
  aider-PageRank, hermes). Aufholbar, aber der MVP verzichtet darauf.
- **Sub-Agenten und Delegation** fehlen. Bewusst (§26).

Beides ist eine Frage des Tempos, nicht der Struktur.

---

# STEP 7 — Kritische Prüfung des eigenen Vorschlags

Der Vorschlag oben ist gegen seine eigenen Regeln geprüft. Vier Schnitte, die
ich beim Schreiben selbst gefunden habe:

## Schnitt 1 — `tool_grants` fliegt raus

Ich hatte `agent_permissions` (§34) **und** `tool_grants` (von mir erfunden)
angelegt. Das sind zwei Tabellen für dieselbe Frage. `agent_permissions` mit
einer `tools`-JSON-Spalte beantwortet „was darf Agent X". Die dritte Tabelle war
eine ausgedachte Abstraktion für ein Problem, das eine Spalte löst.

**Bleibt:** `agent_permissions(agent_id, tools jsonb, tier, ...)`.

## Schnitt 2 — `tools` und `provider_metadata` sind Config, keine Tabellen

Der MVP hat **drei Tools** und **bis zu zwei Provider**. Eine Tabelle für drei
Zeilen ist dieselbe spekulative Allgemeinheit wie ein Plugin-System — nur
kleiner. Beides gehört in versionierte Config-Dateien neben dem Code.

`provider_metadata` (§34 gelistet) bleibt als **Config**, nicht als Tabelle.
Sobald ein Provider Preise ändert, ist das ein Deploy, kein Datenbank-Schema.
Für den Preis-Override pro Task bleibt eine Spalte am Step.

**Bleibt:** 8 Tabellen. `users, sessions, tasks, task_steps, approvals,
agents, agent_permissions, audit_events`.

## Schnitt 3 — Cancellation muss in die Datenbank, nicht in den Prozess

Ich hatte `AbortSignal` als Cancellation gesetzt. Das ist **falsch**: ein
Signal lebt im Prozess. Stirbt der Worker, stirbt die Abbruch-Anweisung — und
genau dann will man abbrechen, wenn etwas klemmt.

Cancellation braucht ein Statusfeld am Task (`cancel_requested_at`), das der
Worker **beim nächsten Heartbeat** pollt. `AbortSignal` bleibt als zweite
Ebene, damit ein laufender LLM-Call sofort reagiert statt bis zum nächsten
Schritt.

**Neu:** Cancellation ist DB-Flag **plus** Signal. Nur Signal wäre ein Fehler,
den man erst im Produktionsbetrieb findet.

## Schnitt 4 — CSRF und Rate-Limit fehlten

Die Entscheidung „browserbasiert" hat eine Folge, die ich nicht mitgezählt habe:
Sitzungscookies machen Cross-Site-Requests möglich. Ohne CSRF-Schutz kann eine
Seite im Tab daneben einen `filesystem.write` auslösen. Und Auth ohne
Rate-Limit lädt eine Brute-Force-Schleife ein.

Beides gehört in Phase 2 (Auth), nicht in eine spätere Härtungsphase — sonst
wird es nachgerüstet, wenn es bereits Nutzer gibt.

## Was die Prüfung nicht beanstandet

- **Eine App + ein Worker** statt Monorepo. Der Worker ist ein zweiter
  Entry-Point im selben Repo, kein eigenes Deployment-Artefakt.
- **11 Phasen** sind eine Bau-Reihenfolge, kein Release-Plan. Phase 1 allein
  bringt nichts in den Nutzerhänden — das ist bei Schema-first normal und kein
  Argument gegen die Reihenfolge.
- **Ein `task_steps`-Memo** ist die einzige Stelle, an der Dauerhaftigkeit
  wirklich Geld kostet. Ohne sie ist der MVP nicht crash-sicher, also ist das
  der richtige Ort für Aufwand.
- **Kein Sandbox-Stack.** Es gibt keinen freien Shell-Zugriff, den man isolieren
  müsste. Das ist die teuerste Einzelentscheidung des Vorschlags — und sie ist
  negativ, also leicht zu revidieren.

## Was nach den Korrekturen bleibt

Neun Komponenten aus §25, alle vorhanden. Acht Tabellen. ~250 LOC Dauerhaftigkeit,
~150 LOC Routing, eine Policy-Entscheidungskette, drei Tools.

Der Vorschlag ist jetzt ~1.100 Zeilen Dokument für einen MVP. Die Codebasis
darf deutlich kleiner sein als das Dokument, sonst ist das Dokument falsch.
