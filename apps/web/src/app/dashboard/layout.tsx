import { ConsoleShell } from '../../components/layout/console-shell';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
