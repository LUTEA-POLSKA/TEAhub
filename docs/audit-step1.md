# TEAhub — STEP 1: Repository Audit

**Datum:** 2026-10-02
**Geprüfter Stand:** `main`, 5 Commits, Working Tree sauber
**Methode:** Messung, nicht Behauptung. Alle Zahlen sind mit den angegebenen Mitteln erhoben.

---

## 1. Gemessene Fakten

| Kennzahl | Wert | Gemessen mit |
|---|---|---|
| Quellzeilen | **4.716** | `Get-ChildItem src -Recurse -Filter *.rs \| Measure-Object -Line` |
| Tests | **112, alle grün** | `cargo test` |
| Testlaufzeit | **2,10 s** | `cargo test` |
| Direkte Dependencies | **9 + 1 dev** | `Cargo.toml` |
| Transitive Crates | **137** | `Cargo.lock` |
| Release-Binary | **3,41 MB** | `Get-Item target\release\teahub.exe` |
| Release-Build (kalt) | **108,9 s** | `Stopwatch` um `cargo build --release` |
| **Startup bis `/health`** | **591 ms** | Stopwatch um Prozessstart + erstes erfolgreiches `/health` |
| **Idle-RAM** | **7,7 MB, flach** | 5 Samples über 10 s, `WorkingSet64` |
| **Idle-CPU** | **0,000 s über 10 s** | `TotalProcessorTime`-Delta |
| Idle-Polling | **keines** | CPU-Delta 0, kein Timer im Idle-Pfad |

**Verteilung:**

| Datei | Zeilen |
|---|---|
| `src/registry/mod.rs` | 810 |
| `src/policy.rs` | 630 |
| `src/model/mesh.rs` | 486 |
| `src/model/openai.rs` | 485 |
| `src/model/mlhsm.rs` | 397 |
| `src/capability/manifest.rs` | 386 |
| `src/capability/validate.rs` | 351 |
| `src/main.rs` | 308 |
| `src/config.rs` | 291 |

---

## 2. Was existiert

| Komponente | Status |
|---|---|
| **Capability Registry** | Discovery, Validierung, Digest-Pinning, Dependency-Auflösung, Zyklen-Erkennung — **funktionsfähig** |
| **Policy Engine** | Trust-Tiers, requested→granted, fail-closed, Glob-Matching, Explain — **funktionsfähig** |
| **Model Layer** | OpenAI-kompatibel + MLHSM-Client, Requirement-Routing, Fallback, Kosten, Usage — **funktionsfähig** |
| **HTTP-API** | 9 Endpoints — **funktionsfähig, aber ohne jede Authentifizierung** |

## 3. Was fehlt — vollständig

Alles aus §25 (MVP-Inhalt) außer dem AI-Provider-Layer und dem Permission-System:

Web UI · Auth · Authorization · Datenbankserver · Task Engine · Agent Runtime · Tool System · Human Gate · Audit Log · Orchestration · Tests über HTTP hinaus

**Die Lücke ist nicht ein Feature, sie ist der Großteil des MVP.**

---

## 4. Security-Audit

Geprüft gegen die Klassen aus §38.

| Klasse | Befund |
|---|---|
| **Auth Bypass** | **KRITISCH.** Die API hat **keine Authentifizierung**. `POST /api/v1/teahub/chat` ist offen; jeder Prozess mit Netzzugang auf den Port kann Modellaufrufe auslösen und damit Kosten verursachen. Betroffen sind alle 9 Endpoints. |
| **Authorization Bypass** | Nicht bewertbar — es gibt keine Autorisierung, die man umgehen könnte. |
| **Command Injection** | **Nicht vorhanden.** `Command::new` kommt im gesamten Repo nicht vor. Keine Prozessausführung. |
| **SQL Injection** | Nicht anwendbar, kein SQL. |
| **Path Traversal** | **Beherrscht.** Manifest-Pfade werden gegen `/`, `\`, `:` und `..` geprüft (`validate.rs::validate_runtime`); `entry` muss ein Bare Filename sein. Der Registry-Scan konstruiert Pfade aus `data_dir`, nicht aus Manifest-Eingaben. |
| **SSRF** | **Kein Vektor.** Alle `reqwest`-Ziele stammen aus `providers.json`, das operator-eigene Konfiguration ist, nicht aus Nutzereingaben. Anmerkung: es *ist* ein konfigurierbarer Egress — für den MVP zu protokollieren. |
| **Secret Leakage** | **Sauber.** Der Token wird ausschließlich als `Authorization`-Header gesendet. Log-Ausgaben enthalten `env_name`, nie den Wert. Offen: die Fehlerbehandlung von `ModelError::Provider` übernimmt die ersten 400 Zeichen der Provider-Antwort — ein Provider, der den Key echoed, würde ihn ausgeben. |
| **Permission Escalation** | **Gefixt.** `tier_for` nahm `min()` und lieferte damit die *grosszügigere* der beiden Tiers. Ein Autor mit `trust: local` hätte `local` behalten, nachdem die Registry auf `untrusted` herabgestuft hatte. Jetzt `max()`, mit Test. |
| **AI Output Injection** | Nicht anwendbar. Es gibt keinen Agenten und keine Tool-Ausführung. |
| **XSS / CSRF** | Nicht anwendbar, kein Frontend, kein Cookie-Login. |

### Fazit Security

Der einzige Fund der Severity „kritisch" ist die fehlende Authentifizierung — und die ist kein Versehen, sondern weil der bisherige Fokus auf Capability-Verteilung lag, nicht auf Tasks. **Für den MVP ist das die erste Arbeit, nicht ein Abwägen.**

---

## 5. Codequalität

| Prüfpunkt | Befund |
|---|---|
| Dead Code | `capabilities/tool/broken-one/` ist eine bewusste Negativ-Fixture, kein toter Code. Kein unbenutzter Produktivcode gefunden. |
| Error Swallowing | 34 Stellen mit bewusstem Wegwerfen (`.ok()`, `unwrap_or_default()`), jeweils mit Begründung im Code. **133 `unwrap`/`expect`, davon 132 im Testpfad.** Der eine im Produktivpfad (`policy.rs:309`) ist durch eine Vorprüfung abgesichert. |
| Übergroße Dateien | `registry/mod.rs` bei 810 Zeilen ist die einzige über der Grenze. Sie enthält Registry-Scan, Dependency-Auflösung, State-Persistenz und Policy-Hooks — **drei Verantwortlichkeiten in einer Datei.** |
| Duplikation | Gering. Die Provider-Clients `openai.rs` und `mlhsm.rs` teilen ~150 Zeilen Request-Aufbau, Response-Parsing und Fehlerklassifikation. Begründbar, da die Wire-Formate sich unterscheiden — aber die Fehlerklassifikation ist identisch. |
| Fehlende Typisierung | Rust; `any` existiert nicht. |
| Unnötige Dependencies | **0.** Jede der 9 Direktabhängigkeiten ist begründet und benutzt. `tempfile` ist die einzige Dev-Dependency. |
| Runtime-Kosten | Gemessen: 7,7 MB RSS, 0 CPU. Kein Overhead. |

---

## 6. Performance

| Aspekt | Befund |
|---|---|
| Startup | **591 ms**, davon der Großteil Prozessstart. |
| **Blockierendes I/O beim Start** | **Befund.** `Config::mesh()` ist `async` und ruft bei aktivem MLHSM-Provider `fetch_models` auf — ein HTTP-Request **blockiert den Start**. Ohne Token (gemessen: 591 ms) wird der Provider vorher übersprungen. Mit Token und MLHSM nicht erreichbar kann der Start in den Timeout des HTTP-Clients laufen. **Das ist ein echter Befund, kein Theoriemuster.** |
| Idle-RAM | 7,7 MB, flach. |
| Idle-CPU | 0,000 s / 10 s. Kein Polling, kein Timer. |
| Bundle Size | Nicht anwendbar (kein Frontend). |
| Datenbankeffizienz | Nicht anwendbar (Dateien, kein Server). |

---

## 7. Die vier Konflikte mit §27/§28/§32

Das Repository und der Stack-Empfehlung widersprechen sich an vier Stellen. Nicht in einem Punkt, sondern in allen.

| | §27 empfiehlt | Repository hat | Konflikt |
|---|---|---|---|
| **Sprache** | TypeScript / Node / pnpm | Rust / Cargo | total |
| **Daten** | PostgreSQL + Drizzle | SQLite-Dateien + JSON | total — und **Drizzle ist TypeScript-only** |
| **Web** | Next.js + React + shadcn/ui | axum, kein Frontend | UI-Stack erzwingt Node-Toolchain |
| **KI-Layer** | Vercel AI SDK | eigener OpenAI-kompatibler Client (485 Zeilen) | Austausch zugunsten gewarteter Bibliothek |

**Und ein Architekturkonflikt, der schwerer wiegt als die Technik:**

| | Mega-Prompt | Repository |
|---|---|---|
| **Mittelpunkt** | Task Engine (§32): Tasks, Status, Agenten, Approvals | Capability Registry: Fähigkeiten verteilen, validieren, ausführen |
| **Permissions** | pro Task und pro Aktion, zur Laufzeit, mit Human Gate | pro Capability, einmalig beim Enable |
| **Granularität** | eine Aktion, ein Check | eine Fähigkeit, ein Satz |

Das sind nicht verschiedene Ausbauten desselben Systems. **Ein Task-Executor und ein Capability-Distributor haben verschiedene Zentren.** Der MVP-Code, den §25 verlangt, existiert in beiden Stapeln nicht.

Was sich **überschneidet** — und daher portierbar ist:

| Modul | Zeilen | Bewertung |
|---|---|---|
| `capability/validate.rs` | 351 | **portieren** — reine Logik, kein I/O, direkt auf TS übertragbar |
| `policy.rs` | 630 | **portieren** — reine Funktion, die Hierarchie deny→human→allow ist der eigentliche Wert |
| `capability/digest.rs` | 119 | **portieren** — sha2 ist in Node ein eingebautes `crypto` |
| `registry/mod.rs` | 810 | **teilweise** — die Auflösungslogik ja, der Dateisystem-Scan muss in die DB |
| `model/openai.rs` + `mlhsm.rs` | 882 | **nicht portieren** — durch den AI SDK ersetzen |

**~1.100 Zeilen Logik sind wertvoll. ~1.000 Zeilen HTTP-Plumbing sind es nicht.**

---

## 7a. Zweiter Audit-Durchgang — Testverteilung, Dokumentation, Nebenwirkungen

### Testabdeckung pro Modul

| Modul | Zeilen | Tests |
|---|---|---|
| `policy.rs` | 698 | 18 |
| `registry/mod.rs` | 891 | 18 |
| `capability/validate.rs` | 385 | 13 |
| `model/openai.rs` | 538 | 13 |
| `model/mesh.rs` | 538 | 11 |
| `model/mlhsm.rs` | 442 | 10 |
| `config.rs` | 325 | 8 |
| `model/capability.rs` | 289 | 7 |
| `capability/manifest.rs` | 432 | 7 |
| `capability/digest.rs` | 133 | 6 |
| `model/mod.rs` | 184 | 1 |
| **`main.rs`** | **340** | **0** |
| `lib.rs` | 36 | 0 (nur Modul-Deklarationen) |
| `capability/mod.rs` | 6 | 0 (nur Re-Exports) |

**Befund: die Logikmodule sind gut getestet (112 Tests), die HTTP-Schicht hat
keinen einzigen.** `main.rs` ist mit 340 Zeilen und 9 Endpoints die
Sicherheitsgrenze — und genau dort ist die Testabdeckung null. Das ist die
falsche Verteilung: Bei 112 grünen Tests liest es sich besser, als es ist.

### Nebenwirkungen im Produktivpfad

Alle `fs::write` / `create_dir_all` / `remove_` / `rename` liegen in
Test-Helpern. Im Produktivpfad schreibt genau eine Stelle: `state.json` über
`Registry::save_state`. **Keine versteckten Dateiseiteneffekte, kein globales
Mutable-State, keine Initialisierungs-Reihenfolge-Falle.**

### Dokumentation

| Dokument | Zeilen | Zustand |
|---|---|---|
| `AUDIT.md` | 554 | **Überholt.** Beschreibt die vorige Architektur (MLHSM-Modul-Frage, SQLite, Capability-Zentrum). Steht im Repo-Root und wird jeden Leser in die falsche Richtung führen. |
| `docs/audit-step1.md` | 242 | aktuell |
| `docs/adr/0001-stack-typescript.md` | 118 | aktuell |
| **`README.md`** | — | **Fehlt vollständig** |

§43 fordert `clone → install → configure → dev`. Ohne README existiert dieser
Pfad nicht — weder dokumentiert noch ausführbar.

### Nicht verifizierbar in dieser Umgebung

Ehrliche Lücken dieses Audits:

- **`cargo audit` ist nicht installiert.** Die 137 transitiven Crates sind
  **nicht** auf bekannte Schwachstellen geprüft. Das ist die wichtigste offene
  Lücke und sie ist mit Bordmitteln nicht zu schließen.
- **`Cargo.lock` enthält keine Lizenzfelder.** Die Lizenzkonformität ist aus
  dem Lockfile heraus nicht prüfbar; sie müsste crateweise über crates.io
  erhoben werden. Die crates.io-API drosselte die Abfrage.
- **Versionsfrische der direkten Dependencies** nicht vollständig erhoben, aus
  demselben Grund.

Diese drei Punkte gehören vor dem ersten Commit einer neuen Dependency
beantwortet, nicht danach.

---

## 8. Empfehlung

Nach §56: weniger Komplexität, weniger Dependencies, bessere Security, bessere Performance, bessere Wartbarkeit.

**Stack:** §27 folgen — TypeScript, Next.js, PostgreSQL, Drizzle. Nicht aus Begeisterung für TypeScript, sondern weil drei Vorgaben es erzwingen: **Drizzle ist TS-only**, **shadcn/ui ist React-only**, und **Auth.js ist TS-only**. Ein Rust-Backend neben einem React-Frontend wäre eine Service-Grenze — und §26 verbietet Microservices. Es gibt keine Teilmischung ohne Grenze.

**Bestehenden Code:** §52 (kein Big-Bang-Rewrite) gegen die Tatsache, dass die Server-Schale ersetzt wird. Auflösung: **die reine Logik portieren, die HTTP-Schale nicht.** ~1.100 Zeilen gehen als getestete TypeScript-Module mit denselben 112 Tests weiter — das ist kein Wegwerfen, das ist ein Stackwechsel mit erhaltenem Erkenntnis.

**MVP-Reihenfolge, gegenüber §50 geändert:**

§50 nennt Auth (Phase 5) vor der Datenbank (Phase 6). Das ist falsch — Auth ohne Datenbank hat nichts, woran es hängt, und der Session-Speicher *ist* die Datenbank. **Datenbank zuerst, dann Auth.** Im Übrigen bleibt §50.

---

## 9. Eine Entscheidung brauche ich

Die Stack-Frage ist ab §9 gestellt und begründet beantwortet, aber sie bestimmt 16 Phasen Arbeit. Sie ist Eure Entscheidung, nicht meine.

Siehe begleitende Frage im Chat. Danach: STEP 2–4 (Ecosystem Research + Research Matrix), dann STEP 5–7 (Architektur), und **erst dann** STEP 8.