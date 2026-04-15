import { ConsoleShell } from '../../components/layout/console-shell';

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
