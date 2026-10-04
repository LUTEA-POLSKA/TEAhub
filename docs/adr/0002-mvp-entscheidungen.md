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

**Grenze.** Rust wird **nicht verschoben.** Es bleibt in `src/`, der TypeScript-Code
geht nach `web/` (Next.js) und `worker/`. Damit bleiben die Audit-Messung
(4.716 LOC in `src/`) und alle Doc-Verweise gültig, und der Umzug bleibt eine
spätere, leicht nachgeholte Entscheidung.

**Was das kostet.** Zwei Toolchains in einem Repo. Rust wird nicht mehr gebaut
und nicht mehr getestet, außer beim Portieren — seine Tests sind Vertrag, kein
laufender Build. Der Preis ist im Architekturvorschlag festgehalten.

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

---

# ADR-0003 — Erster Meilenstein und Umsetzungstiefe

**Datum:** 2026-10-02 · **Status:** angenommen · **Beschlossen vom Owner**

## 1 — Erster Meilenstein ist ein vertikaler Schnitt

**Entschieden:** Der erste Meilenstein reicht von Schema bis Tool-Call.
Schema, Auth, Policy und Agent-Runtime in einer dünnen Scheibe, dann Tasks,
Gates, Oberfläche.

**Begründung.** Er beweist, dass die ganze Kette trägt, und dass die
Rust-Tests als Vertrag funktionieren — beides, bevor irgendein Framework
läuft. Ein Schema-plus-Auth-Commit wäre schneller, lässt aber die
Schnittstelle zwischen Policy und Agent unberührt.

## 2 — Portierung bedarfsgesteuert

**Entschieden:** Portiert wird nur, was die neue Architektur braucht.
Policy-Hierarchie, Digest-Pinning, Trust-Tiers.

**Begründung.** Die HTTP-Schale wird **nicht** portiert — TypeScript hat
Next.js Route Handler. Der MLHSM-Client wird **nicht** portiert — die
Multi-Provider-Entscheidung ersetzt ihn durch den config-gesteuerten
Layer. Ein vollständiger Vorab-Port würde Wochen in Code stecken, den die
Zielarchitektur teilweise gar nicht verwendet.

**Folge.** Der Rust-Bestand bleibt länger als Parallelstand im Repo sichtbar.
Das ist der akzeptierte Preis und der Grund für die Lösch-Checkliste in
§1 — jedes Modul verschwindet mit seinem Port, nicht gebündelt am Ende.

## 3 — Zwei Rollen

**Entschieden:** `admin` und `user`. Jede kritische Aktion wird serverseitig
geprüft (§37).

**Begründung.** §37 verlangt serverseitige Autorisierung, nicht ein
mehrstufiges Rechtesystem. Regeln pro Tool und pro Verzeichnis werden erst
sinnvoll, wenn mehrere Menschen mit verschiedenen Rechten arbeiten — das ist
eine Frage des Betriebs, nicht des MVP.

## 4 — Oberfläche entsteht früh als Skelett

**Entschieden:** Layout, Navigation und LEER-Zustände mit TEAui entstehen
parallel zum Backend, nicht danach.

**Begründung.** TEAui ist installierbar, die Komponenten stehen also sofort
bereit. Ein Skelett deckt früh auf, ob die Seitenstruktur trägt, und teilt
die Arbeit zwischen der Tool-Chain und der UI-Kette.

**Grenze.** Nur Struktur und LEER-Zustände. Keine Funktionalität vor dem
vertikalen Schnitt.