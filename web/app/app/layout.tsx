import { AppDataProvider } from "@/components/app-data";
import { AppShell } from "@/components/app-shell";

export default function AppLayout({ children }: LayoutProps<"/app">) {
  return (
    <AppDataProvider>
      <AppShell>{children}</AppShell>
    </AppDataProvider>
  );
}
