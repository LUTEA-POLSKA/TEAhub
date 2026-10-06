'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from './session-provider';

const NAV: Array<{ href: string; label: string; admin?: boolean }> = [
  { href: '/', label: 'Tasks' },
  { href: '/approvals', label: 'Approvals', admin: true },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useSession();
  const pathname = usePathname();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">T</span>
          <span className="brand-name">TEAhub</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => {
            if (item.admin && user?.role !== 'admin') return null;
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={active ? 'nav-link active' : 'nav-link'}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {loading ? (
            <span className="muted">…</span>
          ) : user ? (
            <>
              <span className="user">
                <span className="user-name">{user.name}</span>
                <span className="user-role">{user.role}</span>
              </span>
              <button className="link-btn" onClick={() => void logout()}>Sign out</button>
            </>
          ) : (
            <Link href="/login" className="nav-link">Sign in</Link>
          )}
        </div>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}