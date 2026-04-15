import { ConsoleShell } from '../../components/layout/console-shell';

export default function VendorsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ConsoleShell>{children}</ConsoleShell>;
}
