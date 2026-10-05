export default function HomePage() {
  return (
    <main style={{ padding: '2rem', maxWidth: '640px', margin: '0 auto' }}>
      <h1>TEAhub</h1>
      <p>Local-first AI agent platform</p>
      <p>API endpoints:</p>
      <ul>
        <li><code>POST /api/auth/login</code> — Sign in</li>
        <li><code>POST /api/auth/logout</code> — Sign out</li>
        <li><code>GET /api/auth/me</code> — Current session</li>
        <li><code>POST /api/tasks</code> — Create task</li>
        <li><code>GET /api/tasks</code> — List tasks</li>
        <li><code>POST /api/tasks/[id]/cancel</code> — Cancel task</li>
        <li><code>GET /api/approvals</code> — List pending approvals</li>
        <li><code>POST /api/approvals/[id]</code> — Decide approval</li>
      </ul>
    </main>
  );
}