import './globals.css';
import { SessionProvider } from '@/components/session-provider';
import { AppShell } from '@/components/app-shell';

export const metadata = {
  title: 'TEAhub',
  description: 'Local-first AI agent platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de">
      <body>
        <SessionProvider>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  );
}