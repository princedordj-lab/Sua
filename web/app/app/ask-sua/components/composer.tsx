"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { CourseSelect } from "./course-select";
import type { ServerCourse, Usage } from "@/lib/types";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  sending: boolean;
  offline: boolean;
  courses: ServerCourse[];
  selectedCourseId: string;
  onSelectCourse: (courseId: string) => void;
  usage?: Usage;
  disabled?: boolean;
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  offline,
  courses,
  selectedCourseId,
  onSelectCourse,
  usage,
  disabled = false,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isCoarsePointer, setIsCoarsePointer] = useState(false);

  const selectedCourse = courses.find((c) => c.id === selectedCourseId);
  const placeholder = selectedCourse
    ? `Ask about ${selectedCourse.name}…`
    : "Ask a question about your notes…";

  // Detect coarse pointer (touch device) without user-agent sniffing
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(pointer: coarse)");
    setIsCoarsePointer(media.matches);

    const handler = (e: MediaQueryListEvent) => setIsCoarsePointer(e.matches);
    if (media.addEventListener) {
      media.addEventListener("change", handler);
      return () => media.removeEventListener("change", handler);
    }
  }, []);

  // Auto-grow textarea without jump, capped at 6 lines (~144px)
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const minHeight = 24; // 1 line minimum height
    const maxHeight = 144; // ~6 lines
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter") {
      // On touch devices, Enter creates a newline so student can write multiline easily
      if (isCoarsePointer) return;

      // On physical keyboard, Enter sends; Shift+Enter creates a newline
      if (!event.shiftKey) {
        event.preventDefault();
        if (canSend) {
          onSend();
        }
      }
    }
  };

  const canSend = Boolean(value.trim()) && !sending && !offline && !disabled;

  // Usage calculations
  const remaining = usage
    ? Math.max(0, usage.limits.assistantQueries - usage.assistantQueries)
    : null;
  const isUsageWarning = remaining !== null && remaining <= 3;

  return (
    <div className="ask-composer-container">
      <div className={`ask-composer-card ${sending ? "is-sending" : ""}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={1}
          disabled={disabled || offline}
          aria-label="Ask a question about your notes"
          className="ask-composer-input"
        />

        <div className="ask-composer-bottom-bar">
          <div className="ask-composer-left">
            <CourseSelect
              courses={courses}
              selectedCourseId={selectedCourseId}
              onSelect={onSelectCourse}
              disabled={sending || disabled}
            />
          </div>

          <div className="ask-composer-right">
            {sending ? (
              <button
                type="button"
                onClick={onStop}
                className="ask-send-btn is-stop"
                aria-label="Stop generating answer"
                title="Stop generating"
              >
                <Square size={16} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                disabled={!canSend}
                className="ask-send-btn"
                aria-label="Send question"
                title={offline ? "Offline" : "Send question"}
              >
                <ArrowUp size={18} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>

      {offline ? (
        <p className="ask-usage-quiet is-offline" role="status">
          You are offline. Connect to the internet to ask questions.
        </p>
      ) : usage ? (
        <p
          className={`ask-usage-quiet ${isUsageWarning ? "is-warning" : ""}`}
          role="status"
        >
          {usage.assistantQueries} of {usage.limits.assistantQueries} questions used this month
          {isUsageWarning ? ` · ${remaining} left on free plan` : ""}
        </p>
      ) : null}
    </div>
  );
}
