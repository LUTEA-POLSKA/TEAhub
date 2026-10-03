# ADR-0001 — TEAhub MVP Stack: TypeScript

**Status:** angenommen · **Datum:** 2026-10-02 · **Bezug:** Master-Prompt §27, §28, §52, §56

## Problem

Das Repository enthielt 4.716 Zeilen Rust: Capability Registry, Policy Engine und
Model-Layer, mit 112 grünen Tests. §27 empfiehlt TypeScript, Node, pnpm, Next.js,
PostgreSQL, Drizzle, Auth.js und den Vercel AI SDK.

Ohne Entscheidung ist jede weitere Arbeit blockiert.

## Optionen

**A — TypeScript nach §27.** Registry-, Policy- und Digest-Logik als getestete
TS-Module portieren; die HTTP-Schale (axum, handgeschriebener
OpenAI-Client, MLHSM-Client) wird durch Next.js Route Handlers und den AI SDK
ersetzt.

**B — Rust behalten, MVP in Rust.** Nichts wird portiert, alles wird neu gebaut.

**C — Rust-Core, TypeScript-UI.** HTTP zwischen beiden.

## Entscheidung

**A.**

## Begründung

Nicht Präferenz für TypeScript, sondern drei erzwungene Abhängigkeiten:

- **Drizzle ist TypeScript-only.** PostgreSQL-ORM und Migrationen hängen daran.
- **shadcn/ui ist React-only.** §27 nennt es für das UI.
- **Auth.js ist TypeScript-only.** §27 nennt es für Authentifizierung.

Damit ist die Toolchain unabhängig vom ORM bereits TypeScript. Ein Rust-Backend
neben einem React-Frontend wäre eine Service-Grenze — und §26 verbietet
Microservices. **Eine Teilmischung existiert nicht ohne Grenze, also gibt es
keine Teilmischung.**

Zusätzlich gemessen (§ docs/audit-step1.md): Der vorhandene Server ist gut
— 591 ms Startup, 7,7 MB RSS, 0,000 s Idle-CPU, 3,41 MB Binary. Diese Zahlen
sind kein Argument gegen Rust; sie sind das Argument dafür, sie nicht zu
verschenken, indem sie beim Stackwechsel verschwinden.

## Trade-offs

**Verloren:** 4.716 Zeilen Rust, davon ca. 1.000 Zeilen HTTP-Plumbing, das
durch gewartete Bibliotheken ersetzt wird. Der handgeschriebene
OpenAI-kompatible Client (485 Zeilen) wird vom AI SDK abgelöst — das ist ein
Verlust an Kontrolle zugunsten von Wartbarkeit.

**Gewonnen:** Die ~1.100 Zeilen reine Logik (Validierung, Policy-Tiers,
Digest, Dependency-Auflösung) bleiben als getestete Module erhalten, mit
denselben 112 Testfällen. Drei erzwingte Toolchain-Entscheidungen fallen weg.

**Bleibt offen:** Der MLHSM-Client wird durch den AI SDK-Provider ersetzt. Ob
MLHSMs `/api/v1/modelmesh/chat` als OpenAI-kompatibel erreichbar ist, ist
**ungeprüft** und in STEP 2 zu verifizieren. Fällt der Test negativ aus, ist
ein eigener Provider-Adapter nötig — dieselbe Seam, nur anders gefüllt.

## Abgelehnte Alternativen

**B (Rust behalten)** — verletzt §27 dreifach: kein Drizzle, kein shadcn/ui, kein
Auth.js. UI und Auth müssten einzeln neu gewählt werden, und das Web-UI wird
zum Engpass für 16 Phasen Arbeit.

**C (Gemischt)** — zwei Toolchains, zwei Dependency-Bäume, zwei CI-Pfade. Für
den MVP zwei Systeme statt eines. §26.

## Zukunftsimplikationen

Der `ModelClient`-Seam aus Rust wird zu einem `ModelProvider`-Interface in TS.
Alles andere — Policy-Hierarchie `deny` → `require_human` → `allow`, das
Tier-System, Digest-Pinning — bleibt fachlich identisch und wird Zeile für
Zeile portiert.

**Der Rust-Code wird erst gelöscht, wenn die Portierung steht und getestet
ist.** Bis dahin existiert er als Referenz und als Quelle der Testfälle.