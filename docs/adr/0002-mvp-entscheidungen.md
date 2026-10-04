# ADR-0002 — MVP-Entscheidungen

**Datum:** 2026-10-02 · **Status:** angenommen · **Beschlossen vom Owner**
**Bezug:** docs/architecture-proposal.md, docs/research-matrix.md

Vier Fragen, die §25 bis §57 offen ließen. Hier die Antworten und warum.

---

## 1 — TypeScript portieren, Rust bleibt lesbar

**Entschieden:** Die TypeShell-Implementierung entsteht **neben** dem
bestehenden Rust-Code. Rust wird nicht weiter entwickelt, aber nicht gelöscht.

**Begründung.** Die 112 Rust-Tests sind der einzige existierende Beweis, dass
Policy-Hierarchie und Digest-Pinning korrekt arbeiten. Beim Portieren werden sie
zum Vertrag: jedes TS-Modul bekommt den Port der reinen Logik, und die
Rust-Tests definieren, was das Ergebnis sein muss.

**Grenze.** `src/` bleibt der Rust-Bestand und ist kein gültiges Ziel mehr. Der
TS-Code liegt in `src/` des neuen Aufbaus — die Trennung ist ein Migrationsschritt,
kein Dauerzustand.

**Auflösung der Löschfrage.** Rust wird entfernt, **wenn** für jedes portierte
Modul ein TS-Test existiert, der denselben Fall abdeckt. Vorher nicht. Das ist
eine Checkliste, kein Gefühl.

## 2 — Nur PostgreSQL

**Entschieden:** Eine Datenbank. Drizzle bleibt portabel, wird aber nicht
dual getestet.

**Begründung.** §16 verlangt einen Last-Test, §17 nennt PostgreSQL. Die Research
empfahl SQLite für die Dauerhaftigkeit — das war Minimalismus für ein einzelnes
Skript mit drei Tabellen, nicht für eine Anwendung mit acht Tabellen und
Audit-Volumen. Ein zweiter Datenbankpfad verdoppelt jeden Test und jede
Migrationsaussage.

**Folge.** Jede Testaussage gilt uneingeschränkt. Kein „nur unter SQLite".

## 3 — OpenRouter als Test-Provider

**Entschieden:** Die Provider-Schicht wird gegen **OpenRouter** getestet. Ollama
bleibt als Zero-Setup-Fallback in der Kandidatenliste.

**Begründung.** Nur so werden Kostenberechnung und Latenzpfad gegen echte Werte
geprüft, nicht gegen eine lokale Modellgeschwindigkeit. Der Key bleibt in `.env`
und wird nicht committet.

**Was das nicht bedeutet.** ModelMesh ist dadurch nicht vorbereitet und nicht
ausgeschlossen — es ist ein weiterer Kandidat in derselben Liste, sobald sein
`/v1`-Endpoint existiert. Die Entscheidung betrifft den Testpfad, nicht die
Architektur.

## 4 — Provider sind config-gesteuert, ModelMesh ist Kandidat

**Entschieden:** TEAhub begrenzt sich nicht auf ModelMesh. Die Kandidatenliste
ist config-gesteuert, jeder OpenAI-kompatible Endpoint gehört hinein.

**Begründung.** Der Vercel AI SDK ist eine Provider-*Spezifikation*, kein Gateway.
Routing, Fallback und Cooldown existieren darin nicht und werden selbst gebaut —
dafür ist eine config-gesteuerte Liste die richtige Form.

**Folge.** Es gibt keinen TEAhub-Code, der ModelMesh kennt. Nur `baseUrl` und
Key. ModelMesh hinzufügen ist eine Zeile in `.env`.

---

## Nicht entschieden (bewusst offen)

- **Human-Gate-UI** (§34 verlangt sie, §26 nicht) — braucht ein Mockup
- **Modellkontext und Kompression** — §57 braucht sie, der MVP verzichtet
- **Sandbox für den Worker** — MXC AppContainer ist ab Win11 24H2 ohne Admin
  möglich, aber der MVP hat nichts zu isolieren
- **Signaturen für die Tool-Registry** (Ed25519) — §45 nennt sie, §46 hält
  Digest plus Human Gate für den realen lokalen Bedrohungsschirm