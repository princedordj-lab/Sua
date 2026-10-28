"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ExternalLink, Search, X } from "lucide-react";
import { colors } from "@/config/theme";
import type { ServerCourse } from "@/lib/types";

interface CourseSelectProps {
  courses: ServerCourse[];
  selectedCourseId: string;
  onSelect: (courseId: string) => void;
  disabled?: boolean;
}

function resolveCourseColor(colourKey: string): string {
  const map = colors.course as Record<string, string>;
  if (colourKey && map[colourKey]) return map[colourKey];
  if (colourKey && colourKey.startsWith("#")) return colourKey;
  return colors.brand.DEFAULT;
}

export function CourseSelect({
  courses,
  selectedCourseId,
  onSelect,
  disabled = false,
}: CourseSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const pillRef = useRef<HTMLButtonElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listboxRef = useRef<HTMLDivElement | null>(null);
  const listboxId = useId();

  const selectedCourse = useMemo(
    () => courses.find((c) => c.id === selectedCourseId) ?? courses[0],
    [courses, selectedCourseId],
  );

  const filteredCourses = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return courses;
    return courses.filter((c) => {
      const matchName = c.name.toLowerCase().includes(q);
      const matchCode = c.code ? c.code.toLowerCase().includes(q) : false;
      return matchName || matchCode;
    });
  }, [courses, query]);

  // Keep the highlighted row in bounds without an effect: query changes reset
  // it explicitly, list changes just clamp at use.
  const changeQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
  };

  // Handle focus when opened: autofocus on desktop, avoid auto-popping keyboard on touch
  useEffect(() => {
    if (!open) return;
    const isTouch =
      typeof window !== "undefined" &&
      (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
    if (!isTouch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        listboxRef.current &&
        !listboxRef.current.contains(target) &&
        pillRef.current &&
        !pillRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const handleSelect = (courseId: string) => {
    onSelect(courseId);
    setOpen(false);
    changeQuery("");
    pillRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      pillRef.current?.focus();
      return;
    }

    if (!open) {
      if (event.key === "Enter" || event.key === "ArrowDown" || event.key === " ") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1 < filteredCourses.length ? prev + 1 : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 >= 0 ? prev - 1 : filteredCourses.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filteredCourses[Math.min(activeIndex, Math.max(0, filteredCourses.length - 1))];
      if (target) {
        handleSelect(target.id);
      }
    }
  };

  const selectedDotColor = selectedCourse
    ? resolveCourseColor(selectedCourse.colour)
    : colors.brand.DEFAULT;

  return (
    <div className="ask-course-select-wrap">
      <button
        ref={pillRef}
        type="button"
        className="ask-course-pill"
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={handleKeyDown}
        disabled={disabled || courses.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={`Current course: ${selectedCourse?.name ?? "Select course"}`}
      >
        <span
          className="ask-course-dot"
          style={{ backgroundColor: selectedDotColor }}
          aria-hidden="true"
        />
        <span className="ask-course-pill-text">
          {selectedCourse?.code ? (
            <strong className="ask-course-code">{selectedCourse.code}</strong>
          ) : null}
          <span className="ask-course-name">{selectedCourse?.name ?? "Choose course"}</span>
        </span>
        <ChevronDown size={14} className={`ask-course-chevron ${open ? "is-open" : ""}`} />
      </button>

      {open ? (
        <>
          <div
            className="ask-course-overlay"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label="Select course"
            className="ask-course-dropdown"
            onKeyDown={handleKeyDown}
          >
            <div className="ask-course-dropdown-head">
              <div className="ask-course-search-wrap">
                <Search size={15} className="ask-course-search-icon" aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => changeQuery(e.target.value)}
                  placeholder="Search courses…"
                  className="ask-course-search-input"
                  aria-label="Search courses"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => changeQuery("")}
                    className="ask-course-clear-btn"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            </div>

            <div className="ask-course-list">
              {filteredCourses.length === 0 ? (
                <div className="ask-course-empty-search">
                  <p>No courses match “{query}”</p>
                </div>
              ) : (
                filteredCourses.map((course, idx) => {
                  const isSelected = course.id === selectedCourse?.id;
                  const isActive = idx === activeIndex;
                  const dotColor = resolveCourseColor(course.colour);

                  return (
                    <div
                      key={course.id}
                      role="option"
                      aria-selected={isSelected}
                      className={`ask-course-option ${isSelected ? "is-selected" : ""} ${
                        isActive ? "is-active" : ""
                      }`}
                      onClick={() => handleSelect(course.id)}
                      onMouseEnter={() => setActiveIndex(idx)}
                    >
                      <span
                        className="ask-course-dot"
                        style={{ backgroundColor: dotColor }}
                        aria-hidden="true"
                      />
                      <div className="ask-course-option-copy">
                        <span className="ask-course-option-name">
                          {course.code ? (
                            <strong className="ask-course-code">{course.code} · </strong>
                          ) : null}
                          {course.name}
                        </span>
                        <span className="ask-course-option-notes">
                          {course.noteCount} {course.noteCount === 1 ? "note" : "notes"}
                        </span>
                      </div>
                      {isSelected ? (
                        <Check size={16} className="ask-course-check" aria-hidden="true" />
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            {selectedCourse ? (
              <div className="ask-course-dropdown-foot">
                <Link
                  href={`/app/courses/${selectedCourse.id}`}
                  className="ask-course-link"
                  onClick={() => setOpen(false)}
                >
                  <span>Open course notes</span>
                  <ExternalLink size={13} aria-hidden="true" />
                </Link>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
