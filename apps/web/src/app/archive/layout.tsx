import { ConsoleShell } from '../../components/layout/console-shell';

export default function ArchiveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
