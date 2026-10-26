"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  Brain,
  ChevronRight,
  Flame,
  Layers,
  Play,
  Plus,
  Sparkles,
  Target,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Card,
  Chip,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  ProgressBar,
  Select,
} from "@/components/ui";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { relativeDate } from "@/lib/format";
import { courseStyle } from "@/lib/course-style";
import type { HomeSummary, ServerStudySet } from "@/lib/types";

export default function StudyPage() {
  const api = useApi();
  const { courses } = useAppData();
  const summary = useResource<HomeSummary>("study-summary", () => api.study.homeSummary());
  const sets = useResource<{ sets: ServerStudySet[] }>("study-sets", () => api.study.sets());
  const [courseId, setCourseId] = useState("all");

  const visible = useMemo(() => {
    const rows = sets.data?.sets ?? [];
    return courseId === "all" ? rows : rows.filter((row) => row.courseId === courseId);
  }, [sets.data, courseId]);

  const grouped = useMemo(() => {
    const map = new Map<string, ServerStudySet[]>();
    for (const set of visible) {
      const list = map.get(set.courseId) ?? [];
      list.push(set);
      map.set(set.courseId, list);
    }
    return [...map.entries()];
  }, [visible]);

  const due = summary.data?.due ?? 0;
  const streak = summary.data?.streakDays ?? 0;
  const reviewedToday = summary.data?.reviewedToday ?? 0;
  const totalCards = summary.data?.totalCards ?? 0;
  const weekly = summary.data?.weekly ?? [];
  const weekTotal = weekly.reduce((sum, day) => sum + day.reviewed, 0);
  const goal = Math.max(1, reviewedToday + due);

  return (
    <div className="study-page">
      <PageHeader
        eyebrow="Study space"
        title="Study"
        description="Review what is due, open a deck, or take a quiz. Progress syncs to your phone."
        actions={
          <Link href="/app/review" className="btn btn-gold btn-md">
            <Play size={17} /> Start review
          </Link>
        }
      />

      {summary.error ? <ErrorState message={summary.error} onRetry={summary.reload} /> : null}
      {sets.error ? <ErrorState message={sets.error} onRetry={sets.reload} /> : null}

      <section className="study-hero" aria-labelledby="study-hero-title">
        <div className="study-hero-copy">
          <p className="eyebrow-sm">Today</p>
          <h2 id="study-hero-title">
            {summary.loading
              ? "Checking your study space…"
              : due > 0
                ? `${due} ${due === 1 ? "card" : "cards"} ready to review`
                : "Nothing due right now"}
          </h2>
          <p>
            {due > 0
              ? "Short sessions beat cramming. Grade each card honestly and Sua schedules the next one."
              : totalCards > 0
                ? "You have reviewed everything due today. Open a deck to practise ahead of schedule."
                : "Generate a study set from a note and your decks, quizzes and daily review appear here."}
          </p>
          <div className="study-hero-progress">
            <div className="study-hero-progress-head">
              <span>Today’s goal</span>
              <span>
                {reviewedToday}/{goal} reviewed
              </span>
            </div>
            <ProgressBar value={(reviewedToday / goal) * 100} tone="gold" label="Today’s review goal" />
          </div>
          <div className="study-hero-actions">
            <Link href="/app/review" className="btn btn-gold btn-md">
              {due > 0 ? "Review now" : "Practise ahead"}
              <ChevronRight size={16} />
            </Link>
            <Link href="/app/create" className="study-hero-link">
              <Plus size={15} /> Add a note
            </Link>
          </div>
        </div>
        <div className="study-hero-stats">
          <div className="study-stat">
            <Flame size={19} aria-hidden="true" />
            <strong>{streak}</strong>
            <span>{streak === 1 ? "day streak" : "day streak"}</span>
          </div>
          <div className="study-stat">
            <Target size={19} aria-hidden="true" />
            <strong>{weekTotal}</strong>
            <span>cards this week</span>
          </div>
          <div className="study-stat">
            <Layers size={19} aria-hidden="true" />
            <strong>{sets.data?.sets.length ?? 0}</strong>
            <span>study sets</span>
          </div>
        </div>
      </section>

      <div className="study-toolbar">
        <div>
          <h2 className="section-title">Your study sets</h2>
          <p className="section-hint">One set per note Sua has turned into cards or a quiz.</p>
        </div>
        <Select
          value={courseId}
          onChange={(event) => setCourseId(event.target.value)}
          aria-label="Filter study sets by course"
          className="study-course-filter"
        >
          <option value="all">All courses</option>
          {courses
            .filter((course) => !course.archived)
            .map((course) => (
              <option key={course.id} value={course.id}>
                {course.name}
              </option>
            ))}
        </Select>
      </div>

      {sets.loading && !sets.data ? <LoadingBlock rows={4} /> : null}

      {!sets.loading && sets.data && visible.length === 0 ? (
        <EmptyState
          icon={<Brain size={26} />}
          title={courseId === "all" ? "No study sets yet" : "Nothing in this course yet"}
          body={
            courseId === "all"
              ? "Open a note and generate a study set. Sua writes the summary, flashcards and quiz in one run."
              : "Pick another course, or generate a study set from a note in this one."
          }
          action={
            <Link href="/app/courses" className="btn btn-secondary btn-md">
              <BookOpen size={16} /> Browse notes
            </Link>
          }
        />
      ) : null}

      {grouped.map(([groupCourseId, groupSets]) => {
        const course = courses.find((row) => row.id === groupCourseId);
        const style = courseStyle(course?.colour);
        return (
          <section key={groupCourseId} className="study-group">
            <Link
              href={`/app/courses/${groupCourseId}`}
              className="study-group-head"
              aria-label={`Open ${course?.name ?? "course"}`}
            >
              <span className={`course-dot ${style.dot}`} aria-hidden="true" />
              <h3>{course?.name ?? "Course"}</h3>
              {course?.code ? <span className="study-group-code">{course.code}</span> : null}
              <Chip tone="muted">{groupSets.length}</Chip>
              <ChevronRight size={17} aria-hidden="true" />
            </Link>
            <div className="study-set-grid">
              {groupSets.map((set) => (
                <Card key={set.noteId} className="study-set-card">
                  <div className="study-set-top">
                    <span className={`study-set-icon ${style.tint} ${style.text}`}>
                      <Layers size={18} />
                    </span>
                    <div>
                      <strong>{set.noteTitle || "Untitled note"}</strong>
                      <p>
                        {set.cards} {set.cards === 1 ? "card" : "cards"} · {set.quizzes}{" "}
                        {set.quizzes === 1 ? "quiz" : "quizzes"}
                      </p>
                    </div>
                  </div>
                  <div className="study-set-foot">
                    <small>Updated {relativeDate(set.updatedAt)}</small>
                    <div className="study-set-actions">
                      <Link href={`/app/review?noteId=${set.noteId}`} className="btn btn-ghost btn-sm">
                        <Play size={14} /> Review
                      </Link>
                      <Link href={`/app/deck/${set.noteId}`} className="btn btn-secondary btn-sm">
                        Open deck
                      </Link>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        );
      })}

      {!sets.loading && visible.length > 0 ? (
        <Card className="study-footer-card">
          <Sparkles size={20} aria-hidden="true" />
          <div>
            <h3>Want more practice?</h3>
            <p>Add cards by hand in any deck, or ask Sua to explain a topic and then quiz you.</p>
          </div>
          <Link href="/app/ask-sua" className="btn btn-secondary btn-sm">
            Ask Sua
          </Link>
        </Card>
      ) : null}
    </div>
  );
}
