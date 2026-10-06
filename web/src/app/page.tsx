import { AppShell } from '@/components/app-shell';
import TasksPage from '@/app/tasks/page';

export default function HomePage() {
  return (
    <AppShell>
      <TasksPage />
    </AppShell>
  );
}