"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useClerk, useUser } from "@clerk/nextjs";
import { Suspense, useEffect } from "react";
import {
  BookOpen,
  Brain,
  Home,
  LogOut,
  Plus,
  Settings,
  User,
} from "lucide-react";
import { Logo } from "./logo";
import { Avatar, Button, ErrorState, ProgressBar, Skeleton } from "./ui";
import { useAppData } from "./app-data";
import { SuaChatMark, type SuaChatIconComponent } from "./sua-chat-icon";
import { useVisualViewportHeight } from "@/hooks/use-visual-viewport";

const NAV: { href: string; label: string; Icon: SuaChatIconComponent; iconSize?: number }[] = [
  { href: "/app/home", label: "Home", Icon: Home },
  { href: "/app/courses", label: "Courses", Icon: BookOpen },
  { href: "/app/create", label: "Create", Icon: Plus },
  { href: "/app/study", label: "Study", Icon: Brain },
  { href: "/app/ask-sua", label: "Ask Sua", Icon: SuaChatMark, iconSize: 24 },
  { href: "/app/profile", label: "Profile", Icon: User },
];

const MOBILE_NAV = NAV.filter((item) => item.href !== "/app/ask-sua");

function isActive(pathname: string, href: string) {
  if (href === "/app/home") return pathname === "/app" || pathname === "/app/home";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Nav links live in their own components so `usePathname()` has a Suspense
 * boundary. Next 16 (Cache Components) suspends on unknown dynamic params —
 * every `/app/note/[id]`-style route — and without the boundary the whole
 * shell fails to prerender. The fallback renders the same links unhighlighted.
 */
function NavItems({ pathname, mobile = false }: { pathname: string | null; mobile?: boolean }) {
  const items = mobile ? MOBILE_NAV : NAV;
  return (
    <>
      {items.map(({ href, label, Icon, iconSize }) => {
        const active = pathname ? isActive(pathname, href) : false;
        return (
          <Link
            key={href}
            href={href}
            className={`${mobile ? "bottom-nav-item" : "nav-item"}${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <Icon
              size={iconSize ?? (mobile ? 21 : 19)}
              strokeWidth={2.1}
              aria-hidden="true"
            />
            <span>{label}</span>
          </Link>
        );
      })}
    </>
  );
}

function SidebarNav() {
  const pathname = usePathname();
  return <NavItems pathname={pathname} />;
}

function BottomNav() {
  const pathname = usePathname();
  return <NavItems pathname={pathname} mobile />;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={<AppShellContent pathname={null}>{children}</AppShellContent>}>
      <AppShellWithPathname>{children}</AppShellWithPathname>
    </Suspense>
  );
}

function AppShellWithPathname({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <AppShellContent pathname={pathname}>{children}</AppShellContent>;
}

function AppShellContent({
  children,
  pathname,
}: {
  children: React.ReactNode;
  pathname: string | null;
}) {
  const router = useRouter();
  const { signOut } = useClerk();
  const { user } = useUser();
  const { profile, courses, loading, error, refresh } = useAppData();
  const { containerRef, isKeyboardOpen } = useVisualViewportHeight<HTMLDivElement>();

  // New accounts finish onboarding before the shell becomes useful. The
  // server verdict also covers accounts created before the flag existed; the
  // local fallback keeps a rolling deploy safe.
  useEffect(() => {
    if (!profile) return;
    const needsOnboarding =
      profile.onboarded === undefined
        ? !profile.onboardingCompletedAt && courses.length === 0
        : !profile.onboarded;
    if (needsOnboarding) router.replace("/onboarding");
  }, [profile, courses.length, router]);

  const name = profile?.name || user?.fullName || user?.firstName || "Sua student";
  const usage = profile?.usage;
  const summaryPercent = usage ? (usage.summaries / Math.max(1, usage.limits.summaries)) * 100 : 0;
  const isAskSua = pathname === "/app/ask-sua";

  return (
    <div ref={containerRef} className={`app-shell${isAskSua ? " is-ask-sua" : ""}`}>
      <aside className="app-sidebar" aria-label="Main navigation">
        <div className="sidebar-top">
          <Logo href="/app/home" />
          <p className="sidebar-tagline">Hear it once. Know it for the exam.</p>
        </div>

        <nav className="sidebar-nav">
          <Suspense fallback={<NavItems pathname={null} />}>
            <SidebarNav />
          </Suspense>
        </nav>

        <div className="sidebar-bottom">
          {usage ? (
            <div className="usage-card">
              <div className="usage-head">
                <span>Free plan · this month</span>
                <span className="usage-plan">{usage.limits.summaries}</span>
              </div>
              <p className="usage-line">
                {usage.summaries} of {usage.limits.summaries} summaries used
              </p>
              <ProgressBar
                value={summaryPercent}
                tone={summaryPercent >= 100 ? "gold" : "brand"}
                label="Monthly summaries used"
              />
              <p className="usage-note">Billing arrives on mobile first.</p>
            </div>
          ) : null}

          <div className="sidebar-user">
            <Avatar name={name} imageUrl={user?.imageUrl} size={36} />
            <div className="sidebar-user-copy">
              <strong>{name}</strong>
              <span>{profile?.email ?? user?.primaryEmailAddress?.emailAddress}</span>
            </div>
          </div>
          <div className="sidebar-actions">
            <Link href="/app/preferences" className="sidebar-icon-link" aria-label="Preferences">
              <Settings size={17} />
            </Link>
            <button
              type="button"
              className="sidebar-icon-link"
              aria-label="Sign out"
              title="Sign out"
              onClick={() => void signOut({ redirectUrl: "/" })}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="mobile-topbar">
          <Logo href="/app/home" />
          <div className="mobile-topbar-actions">
            <Link href="/app/ask-sua" className="sidebar-icon-link" aria-label="Ask Sua">
              <SuaChatMark size={26} />
            </Link>
            <Link href="/app/profile" aria-label="Profile">
              <Avatar name={name} imageUrl={user?.imageUrl} size={32} />
            </Link>
          </div>
        </header>

        {error && !profile ? (
          <div className="app-content">
            <ErrorState message={error} onRetry={refresh} />
            <div className="mt-4">
              <Button variant="ghost" onClick={() => void signOut({ redirectUrl: "/" })}>
                Sign out
              </Button>
            </div>
          </div>
        ) : loading && !profile ? (
          <div className="app-content" aria-busy="true">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="mt-4 h-40 w-full" />
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
              <Skeleton className="h-28" />
            </div>
          </div>
        ) : (
          <div className="app-content">
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>{children}</Suspense>
          </div>
        )}
      </div>

      <nav
        className={`bottom-nav${isKeyboardOpen ? " is-keyboard-open" : ""}`}
        aria-label="Primary"
      >
        <Suspense fallback={<NavItems pathname={null} mobile />}>
          <BottomNav />
        </Suspense>
      </nav>
    </div>
  );
}
