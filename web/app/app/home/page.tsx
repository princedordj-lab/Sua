"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  Brain,
  ChevronRight,
  CloudUpload,
  Keyboard,
  MessageCircle,
  Mic,
  Plus,
  Sparkles,
} from "lucide-react";
import { useUser } from "@clerk/nextjs";
import { useAppData } from "@/components/app-data";
import { Avatar, Card, Chip, EmptyState, ErrorState, ProgressBar, Skeleton } from "@/components/ui";
import { MarkdownPreview } from "@/components/markdown";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { relativeDate, firstName } from "@/lib/format";
import { courseStyle } from "@/lib/course-style";
import type { HomeSummary, ServerNote } from "@/lib/types";

const ACTION_TILES = [
  {
    label: "Record",
    hint: "Lecture audio",
    href: "/app/create?mode=record",
    Icon: Mic,
    tint: "action-tint-success",
  },
  {
    label: "Upload",
    hint: "PDF or slides",
    href: "/app/create?mode=upload",
    Icon: CloudUpload,
    tint: "action-tint-info",
  },
  {
    label: "Type",
    hint: "Write it out",
    href: "/app/create?mode=type",
    Icon: Keyboard,
    tint: "action-tint-violet",
  },
] as const;

export default function HomePage() {
  const { profile, courses, loading } = useAppData();
  const { user } = useUser();
  const api = useApi();

  const summary = useResource<HomeSummary>("home-summary", () => api.study.homeSummary());
  const recent = useResource<ServerNote[]>(
    `home-recent:${courses.map((course) => course.id).join(",")}`,
    async () => {
      if (!courses.length) return [];
      const groups = await Promise.all(courses.map((course) => api.notes.listForCourse(course.id)));
      return groups
        .flat()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 4);
    },
  );

  const name = profile?.name || user?.fullName || "Student";
  const due = summary.data?.due ?? 0;
  const reviewed = summary.data?.reviewedToday ?? 0;
  const streak = summary.data?.streakDays ?? 0;
  const weekly = summary.data?.weekly ?? [];
  const totalWeek = weekly.reduce((sum, day) => sum + day.reviewed, 0);
  const dailyProgress = due + reviewed > 0 ? (reviewed / (reviewed + due)) * 100 : 0;
  const usage = profile?.usage;

  return (
    <div className="home-page">
      <header className="home-greeting">
        <Avatar name={name} imageUrl={user?.imageUrl} size={56} />
        <div className="home-greeting-copy">
          <p className="eyebrow-sm">Welcome back</p>
          <h1>Hello, {firstName(name)}.</h1>
          <p>Let’s get ready for exams.</p>
        </div>
        <Chip tone={streak > 0 ? "gold" : "muted"} className="streak-chip">
          <Sparkles size={12} /> {streak > 0 ? `${streak}-day streak` : "Start a streak"}
        </Chip>
      </header>

      {summary.error ? (
        <ErrorState message={summary.error} onRetry={summary.reload} />
      ) : (
        <section className="review-hero" aria-labelledby="review-title">
          <div className="review-hero-glow" aria-hidden="true" />
          <div className="review-hero-copy">
            <span className="review-hero-label">Today’s review</span>
            <h2 id="review-title">
              {summary.loading ? "Checking your cards…" : due > 0 ? `${due} ${due === 1 ? "card" : "cards"} due` : "You’re all caught up"}
            </h2>
            <p>
              {summary.loading
                ? "One moment while Sua looks at your study sets."
                : due > 0
                  ? `About ${Math.max(5, due * 2)} minutes of focused recall keeps your memory fresh.`
                  : reviewed > 0
                    ? `You reviewed ${reviewed} ${reviewed === 1 ? "card" : "cards"} today. Come back tomorrow to keep the streak.`
                    : "Generate a study set from any note to start the review loop."}
            </p>
            <div className="review-hero-progress">
              <div className="review-hero-progress-head">
                <span>Today’s goal</span>
                <span>{reviewed} reviewed</span>
              </div>
              <ProgressBar value={dailyProgress} tone="gold" label="Today’s review progress" />
            </div>
            <div className="review-hero-actions">
              <Link href="/app/review" className="btn btn-gold btn-md">
                {due > 0 ? "Start review" : "Review anyway"}
                <ArrowRight size={17} aria-hidden="true" />
              </Link>
              <Link href="/app/study" className="review-hero-link">
                Open study space <ChevronRight size={15} />
              </Link>
            </div>
          </div>
          <div className="review-hero-art" aria-hidden="true">
            <BookOpen size={132} strokeWidth={1.4} />
            <span className="review-hero-art-badge">
              <Brain size={22} />
            </span>
          </div>
        </section>
      )}

      <div className="stat-grid">
        <Card className="stat-card">
          <span className="stat-label">Due now</span>
          <strong>{summary.loading ? "—" : due}</strong>
          <span className="stat-note">{due === 1 ? "flashcard" : "flashcards"} waiting</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-label">This week</span>
          <strong>{summary.loading ? "—" : totalWeek}</strong>
          <span className="stat-note">cards reviewed</span>
        </Card>
        <Card className="stat-card">
          <span className="stat-label">Streak</span>
          <strong>{summary.loading ? "—" : streak}</strong>
          <span className="stat-note">{streak === 1 ? "day in a row" : "days in a row"}</span>
        </Card>
      </div>

      <section className="home-section">
        <div className="section-heading-row">
          <div>
            <h2 className="section-title">Capture a class</h2>
            <p className="section-hint">Start with whatever you have — a recording, slides, or your own words.</p>
          </div>
        </div>
        <div className="action-grid">
          {ACTION_TILES.map(({ label, hint, href, Icon, tint }) => (
            <Link key={label} href={href} className="action-tile card">
              <span className={`action-tile-icon ${tint}`}>
                <Icon size={24} strokeWidth={2.1} aria-hidden="true" />
              </span>
              <span className="action-tile-label">{label}</span>
              <span className="action-tile-hint">{hint}</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="home-columns">
        <section className="home-section">
          <div className="section-heading-row">
            <h2 className="section-title">Recent notes</h2>
            <Link href="/app/courses" className="text-link-sm">
              See all <ChevronRight size={15} />
            </Link>
          </div>
          <Card className="list-card">
            {recent.loading ? (
              <div className="p-4">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="mt-3 h-14 w-full" />
              </div>
            ) : recent.error ? (
              <div className="p-4">
                <ErrorState message={recent.error} onRetry={recent.reload} />
              </div>
            ) : recent.data && recent.data.length > 0 ? (
              recent.data.map((note) => {
                const course = courses.find((row) => row.id === note.courseId);
                const style = courseStyle(course?.colour);
                return (
                  <Link key={note.id} href={`/app/note/${note.id}`} className="note-row">
                    <span className={`note-row-mark ${style.tint} ${style.text}`}>
                      {(course?.code || course?.name || "NOTE").slice(0, 3).toUpperCase()}
                    </span>
                    <span className="note-row-copy">
                      <strong>{note.title || "Untitled note"}</strong>
                      <small>
                        {course?.name || "Study note"} · {relativeDate(note.updatedAt)}
                      </small>
                      <MarkdownPreview text={note.summary || note.body} lines={1} />
                    </span>
                    {note.aiState === "ready" ? <Chip tone="success">Ready</Chip> : <Chip tone="muted">Pending</Chip>}
                    <ChevronRight size={18} className="note-row-arrow" aria-hidden="true" />
                  </Link>
                );
              })
            ) : (
              <EmptyState
                icon={<Plus size={24} />}
                title="Create your first note"
                body="Type a note, upload slides or record a lecture. Sua turns it into a study set."
                action={
                  <Link href="/app/create?mode=type" className="btn btn-secondary btn-sm">
                    Type a note
                  </Link>
                }
              />
            )}
          </Card>
        </section>

        <aside className="home-aside">
          <Card className="weekly-card">
            <div className="weekly-head">
              <div>
                <h2 className="section-title">7-day rhythm</h2>
                <p className="section-hint">Cards you reviewed each day.</p>
              </div>
              <Chip tone="brand">{totalWeek} total</Chip>
            </div>
            <div className="weekly-bars" aria-label="Cards reviewed over the last seven days">
              {weekly.map((day) => {
                const max = Math.max(1, ...weekly.map((entry) => entry.reviewed));
                const height = Math.max(6, (day.reviewed / max) * 100);
                const label = new Date(`${day.date}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: "short",
                });
                return (
                  <div key={day.date} className="weekly-bar">
                    <span className="weekly-bar-track">
                      <span style={{ height: `${height}%` }} />
                    </span>
                    <small>{label}</small>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="ask-card">
            <span className="ask-card-icon">
              <MessageCircle size={21} aria-hidden="true" />
            </span>
            <h2>Ask Sua</h2>
            <p>Stuck on a concept? Ask questions grounded in your own course notes.</p>
            <Link href="/app/ask-sua" className="btn btn-secondary btn-sm">
              Open Ask Sua <ChevronRight size={15} />
            </Link>
          </Card>

          {usage ? (
            <Card className="usage-mini">
              <div className="usage-mini-head">
                <span>Free plan · {usage.month}</span>
                <Chip tone="muted">Read only</Chip>
              </div>
              <div className="usage-mini-row">
                <span>Summaries</span>
                <strong>
                  {usage.summaries}/{usage.limits.summaries}
                </strong>
              </div>
              <ProgressBar
                value={(usage.summaries / Math.max(1, usage.limits.summaries)) * 100}
                label="Summaries used"
              />
              <div className="usage-mini-row">
                <span>Ask Sua questions</span>
                <strong>
                  {usage.assistantQueries}/{usage.limits.assistantQueries}
                </strong>
              </div>
              <ProgressBar
                value={(usage.assistantQueries / Math.max(1, usage.limits.assistantQueries)) * 100}
                tone="gold"
                label="Assistant questions used"
              />
            </Card>
          ) : loading ? (
            <Skeleton className="h-32" />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
