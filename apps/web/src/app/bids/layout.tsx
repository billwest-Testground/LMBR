import { ConsoleShell } from '../../components/layout/console-shell';

export default function BidsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
