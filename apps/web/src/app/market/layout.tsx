import { ConsoleShell } from '../../components/layout/console-shell';

export default function MarketLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
