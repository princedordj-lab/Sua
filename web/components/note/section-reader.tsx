"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  List,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Markdown } from "@/components/markdown";
import { Button, ProgressBar } from "@/components/ui";
import { parseNoteSections } from "@/lib/markdown";
import type { NoteTextScale } from "@/lib/types";

const SECTION_EVENT = "sua:note-section";

function subscribeNotePosition(onChange: () => void) {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("hashchange", onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener(SECTION_EVENT, onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SECTION_EVENT, onChange);
  };
}

/** The URL hash is the source of truth; localStorage covers a clean hash. */
function readHashSlug() {
  if (typeof window === "undefined") return "";
  try {
    return window.location.hash.replace(/^#/, "");
  } catch {
    return "";
  }
}

function readSavedSlug(noteId: string) {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(`note-section:${noteId}`) ?? "";
  } catch {
    return "";
  }
}

// Sections the pipeline names for a reason get a quiet, distinct treatment.
function sectionTone(title: string) {
  const name = title.toLowerCase();
  if (name.includes("key takeaway")) return "is-takeaways";
  if (name.includes("definition") || name.includes("key term")) return "is-definitions";
  if (name.includes("example")) return "is-examples";
  if (name.includes("formula") || name.includes("equation")) return "is-formulas";
  if (name.includes("overview") || name.includes("introduction")) return "is-overview";
  return "";
}

/**
 * Page-at-a-time note reader. The URL hash (plus a localStorage mirror) is the
 * reading position, so navigation never touches the note record and reloads or
 * back/forward restore the same page. Only the selected section is mounted.
 */
export function SectionReader({
  text,
  scale,
  noteId,
  courseId,
  title,
}: {
  text: string;
  scale?: NoteTextScale;
  noteId: string;
  courseId?: string | null;
  title?: string;
}) {
  const { intro, sections } = useMemo(() => parseNoteSections(text), [text]);
  const [finished, setFinished] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const lastIndexRef = useRef<number | null>(null);

  const hashSlug = useSyncExternalStore(subscribeNotePosition, readHashSlug, () => "");
  const savedSlug = useSyncExternalStore(
    subscribeNotePosition,
    () => readSavedSlug(noteId),
    () => "",
  );

  const total = sections.length;
  const hashIndex = sections.findIndex((section) => section.id === hashSlug);
  const savedIndex = sections.findIndex((section) => section.id === savedSlug);
  const safeIndex = total
    ? Math.max(0, Math.min(total - 1, hashIndex >= 0 ? hashIndex : savedIndex))
    : 0;
  const current = total ? sections[safeIndex] : null;
  const isFinal = total > 0 && safeIndex === total - 1;
  const progress = total ? Math.round(((safeIndex + 1) / total) * 100) : 0;
  const tone = current ? sectionTone(current.title) : "";

  // Keep the highlighted row visible inside a long navigator. The first render
  // is skipped so opening a note never scrolls the page on its own.
  useEffect(() => {
    if (lastIndexRef.current === null) {
      lastIndexRef.current = safeIndex;
      return;
    }
    lastIndexRef.current = safeIndex;
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [safeIndex]);

  const scrollReaderIntoView = useCallback(() => {
    readerRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  const selectSection = useCallback(
    (next: number) => {
      if (!sections.length) return;
      const clamped = Math.max(0, Math.min(sections.length - 1, next));
      const slug = sections[clamped].id;
      try {
        window.localStorage.setItem(`note-section:${noteId}`, slug);
        const url = new URL(window.location.href);
        url.hash = slug;
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`,
        );
      } catch {
        // Private mode / blocked storage: reading still works, position just
        // does not survive a reload.
      }
      window.dispatchEvent(new Event(SECTION_EVENT));
      setFinished(false);
      setNavOpen(false);
      scrollReaderIntoView();
    },
    [noteId, scrollReaderIntoView, sections],
  );

  if (!sections.length) {
    return <Markdown text={text} scale={scale} />;
  }

  return (
    <div className="note-reader-paged" ref={readerRef}>
      <header className="note-reading-head">
        <div className="note-reading-top">
          <div className="note-reading-copy">
            <span className="note-reading-note" title={title}>
              {title || "Study notes"}
            </span>
            <span className="note-reading-count">
              Section {safeIndex + 1} of {total}
              {isFinal ? <span className="note-final-chip">Final section</span> : null}
            </span>
          </div>
          <div className="note-reading-actions">
            <button
              type="button"
              className="note-toc-trigger"
              aria-expanded={navOpen}
              aria-controls="note-sections-toc"
              onClick={() => setNavOpen((open) => !open)}
            >
              <List size={15} aria-hidden="true" /> Contents
            </button>
            <button
              type="button"
              className="note-nav-toggle"
              aria-expanded={!navCollapsed}
              aria-controls="note-sections-toc"
              onClick={() => setNavCollapsed((collapsed) => !collapsed)}
            >
              {navCollapsed ? (
                <PanelLeftOpen size={15} aria-hidden="true" />
              ) : (
                <PanelLeftClose size={15} aria-hidden="true" />
              )}
              {navCollapsed ? "Show contents" : "Hide contents"}
            </button>
          </div>
        </div>

        <div className="note-reading-progress">
          <div className="note-reading-progress-row">
            <span className="note-reading-progress-label">Reading progress</span>
            <span className="note-reading-progress-pct">{progress}%</span>
          </div>
          <ProgressBar value={progress} label="Reading progress" />
        </div>
        <span className="sr-only" aria-live="polite">
          Section {safeIndex + 1} of {total}: {current?.title}
        </span>
      </header>

      <div className={`note-reading-body ${navCollapsed ? "is-nav-collapsed" : ""}`}>
        <nav
          id="note-sections-toc"
          ref={navRef}
          className={`note-sections-toc scrollbar-hidden ${navOpen ? "is-open" : ""}`}
          aria-label="Note sections"
        >
          <span className="note-toc-heading" aria-hidden="true">
            Contents
          </span>
          {sections.map((section, index) => {
            const active = index === safeIndex;
            return (
              <button
                key={section.id}
                type="button"
                className={`note-toc-link ${active ? "is-active" : ""}`}
                aria-current={active ? "true" : undefined}
                onClick={() => selectSection(index)}
              >
                <span className="note-toc-number">{index + 1}</span>
                <span className="note-toc-title">{section.title}</span>
                {active ? (
                  <span className="note-toc-check" aria-hidden="true">
                    <Check size={13} />
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>

        <div className="note-section-page" key={current?.id}>
          {intro && safeIndex === 0 ? (
            <div className="note-section-intro">
              <Markdown text={intro} scale={scale} className="note-prose" />
            </div>
          ) : null}

          <div className="note-section-page-head">
            <span className="note-section-kicker">Section {safeIndex + 1}</span>
            <h2>{current?.title}</h2>
          </div>

          <div className={`note-section-body ${tone}`}>
            <Markdown text={current?.body ?? ""} scale={scale} className="note-prose" />
          </div>

          {finished ? (
            <div className="note-complete">
              <div className="note-complete-head">
                <Check size={18} aria-hidden="true" />
                <h3>You’ve reached the end of this note</h3>
              </div>
              <p>Every section is read. Review the contents or go back to your course.</p>
              <div className="note-complete-actions">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setNavOpen(true);
                    setNavCollapsed(false);
                    scrollReaderIntoView();
                  }}
                >
                  Review contents
                </Button>
                <Link
                  href={courseId ? `/app/courses/${courseId}` : "/app/courses"}
                  className="btn btn-primary"
                >
                  Back to course
                </Link>
              </div>
            </div>
          ) : (
            <div className="note-section-nav">
              <Button
                variant="secondary"
                disabled={safeIndex === 0}
                onClick={() => selectSection(safeIndex - 1)}
              >
                <ChevronLeft size={16} aria-hidden="true" /> Previous section
              </Button>
              {isFinal ? (
                <Button onClick={() => setFinished(true)}>
                  <Check size={16} aria-hidden="true" /> Finish reading
                </Button>
              ) : (
                <Button onClick={() => selectSection(safeIndex + 1)}>
                  Next section <ChevronRight size={16} aria-hidden="true" />
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
