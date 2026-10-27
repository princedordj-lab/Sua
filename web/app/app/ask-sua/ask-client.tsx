"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, MessageCircle, PlusCircle, Trash2 } from "lucide-react";
import { useAppData } from "@/components/app-data";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { usePrefs } from "@/lib/prefs";
import { EmptyState, LoadingBlock } from "@/components/ui";
import { useVisualViewportHeight } from "@/hooks/use-visual-viewport";
import { Composer } from "./components/composer";
import { MessageList } from "./components/message-list";
import type { QuickActionItem } from "./components/quick-actions";
import type { ChatMessageView, ChatQuickAction, ServerNote } from "@/lib/types";

export function AskSuaClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const api = useApi();
  const { prefs, update: updatePref } = usePrefs();
  const { courses, profile, refreshProfile, loading: appLoading } = useAppData();
  const { containerRef, isKeyboardOpen } = useVisualViewportHeight<HTMLDivElement>();

  const activeCourses = useMemo(
    () => courses.filter((c) => !c.archived),
    [courses],
  );

  // Determine initial course from URL param, prefs, or fallback to first course
  const paramCourseId = searchParams.get("course");
  const initialCourseId = useMemo(() => {
    if (paramCourseId && courses.some((c) => c.id === paramCourseId)) {
      return paramCourseId;
    }
    if (prefs.lastCourseId && courses.some((c) => c.id === prefs.lastCourseId)) {
      return prefs.lastCourseId;
    }
    return activeCourses[0]?.id ?? courses[0]?.id ?? "";
  }, [paramCourseId, courses, prefs.lastCourseId, activeCourses]);

  const [courseId, setCourseId] = useState(initialCourseId);

  // Sync state if initialCourseId changes from URL / data
  useEffect(() => {
    if (paramCourseId && courses.some((c) => c.id === paramCourseId)) {
      setCourseId(paramCourseId);
    } else if (!courseId && initialCourseId) {
      setCourseId(initialCourseId);
    }
  }, [paramCourseId, initialCourseId, courses, courseId]);

  const effectiveCourseId =
    courses.find((c) => c.id === courseId)?.id ??
    activeCourses[0]?.id ??
    courses[0]?.id ??
    "";

  // Cache notes for current course to resolve note titles
  const notesResource = useResource<ServerNote[]>(
    `chat-notes:${effectiveCourseId}`,
    () =>
      effectiveCourseId
        ? api.notes.listForCourse(effectiveCourseId)
        : Promise.resolve([]),
  );

  const noteTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of notesResource.data ?? []) {
      map.set(note.id, note.title || "Untitled note");
    }
    return map;
  }, [notesResource.data]);

  // Messages history from server
  const serverMessages = useResource<{ messages: ChatMessageView[] }>(
    `chat:${effectiveCourseId}`,
    () =>
      effectiveCourseId
        ? api.chat.messages(effectiveCourseId)
        : Promise.resolve({ messages: [] }),
  );

  // Local thread state kept per course
  const [threads, setThreads] = useState<Record<string, ChatMessageView[]>>({});
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastQuestion, setLastQuestion] = useState<{ text: string; action?: ChatQuickAction } | null>(null);
  const [offline, setOffline] = useState(false);
  const [dividerNotice, setDividerNotice] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const previousCourseIdRef = useRef<string>(effectiveCourseId);

  // Track online/offline status
  useEffect(() => {
    if (typeof window === "undefined") return;
    setOffline(!navigator.onLine);
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // When course switches, record thin divider notice if conversation was active
  const handleSelectCourse = useCallback(
    (newCourseId: string) => {
      if (newCourseId === effectiveCourseId) return;

      const prevCourse = courses.find((c) => c.id === effectiveCourseId);
      const newCourse = courses.find((c) => c.id === newCourseId);

      setCourseId(newCourseId);
      updatePref({ lastCourseId: newCourseId });

      // Update URL search param without reload
      const url = new URL(window.location.href);
      url.searchParams.set("course", newCourseId);
      window.history.replaceState(null, "", url.toString());

      if (prevCourse && newCourse) {
        setDividerNotice(`Switched to ${newCourse.name}`);
      }
    },
    [effectiveCourseId, courses, updatePref],
  );

  // Effective history for current course
  const currentThread = threads[effectiveCourseId];
  const messages = useMemo(() => {
    if (currentThread !== undefined) return currentThread;
    return serverMessages.data?.messages ?? [];
  }, [currentThread, serverMessages.data?.messages]);

  const activeCourse = courses.find((c) => c.id === effectiveCourseId);

  // Send question
  const ask = async (questionText: string, quickAction?: ChatQuickAction) => {
    const text = questionText.trim();
    if (!text || !effectiveCourseId || sending || offline) return;

    const targetCourse = effectiveCourseId;
    setSending(true);
    setError(null);
    setDraft("");
    setLastQuestion({ text, action: quickAction });

    const optimisticId = `local-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const optimisticMessage: ChatMessageView = {
      id: optimisticId,
      courseId: targetCourse,
      role: "user",
      content: text,
      sourceNoteIds: [],
      createdAt: now,
    };

    setThreads((prev) => ({
      ...prev,
      [targetCourse]: [...(prev[targetCourse] ?? messages), optimisticMessage],
    }));

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const response = await api.chat.ask({
        courseId: targetCourse,
        question: text,
        quickAction,
      });

      if (!controller.signal.aborted) {
        setThreads((prev) => {
          const current = (prev[targetCourse] ?? []).filter((m) => m.id !== optimisticId);
          return {
            ...prev,
            [targetCourse]: [...current, response.user, response.assistant],
          };
        });
        void refreshProfile();
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        // User aborted: remove optimistic message and restore draft
        setThreads((prev) => ({
          ...prev,
          [targetCourse]: (prev[targetCourse] ?? []).filter((m) => m.id !== optimisticId),
        }));
        setDraft(text);
      } else {
        setThreads((prev) => ({
          ...prev,
          [targetCourse]: (prev[targetCourse] ?? []).filter((m) => m.id !== optimisticId),
        }));
        setDraft(text);
        setError(
          cause instanceof Error ? cause.message : "Ask Sua could not answer that. Try again.",
        );
      }
    } finally {
      setSending(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleRetryLast = () => {
    if (lastQuestion) {
      void ask(lastQuestion.text, lastQuestion.action);
    }
  };

  const handleQuickAction = (action: QuickActionItem) => {
    if (messages.length === 0) {
      // In empty state: fill composer with starter prompt so student can review or edit
      setDraft(action.prompt);
    } else {
      // Mid-conversation: follow-up runs directly on existing context
      void ask(action.prompt, action.key);
    }
  };

  const handleNewChat = () => {
    if (messages.length === 0) return;
    const confirmed = window.confirm("Start a new chat for this course? Current messages will be cleared.");
    if (!confirmed) return;

    setThreads((prev) => ({
      ...prev,
      [effectiveCourseId]: [],
    }));
    setDraft("");
    setError(null);
    setDividerNotice(null);
  };

  const handleBack = () => {
    const referrer = document.referrer;
    const cameFromSua = (() => {
      if (!referrer) return false;

      try {
        return new URL(referrer).origin === window.location.origin;
      } catch {
        return false;
      }
    })();

    if (cameFromSua && window.history.length > 1) {
      router.back();
      return;
    }

    router.replace("/app/home");
  };

  if (!appLoading && courses.length === 0) {
    return (
      <div className="ask-chat-layout is-no-courses">
        <EmptyState
          icon={<MessageCircle size={28} />}
          title="Add a course first"
          body="Sua answers from the notes in one course, so it needs something to read first."
          action={
            <Link href="/app/courses" className="btn btn-primary btn-md">
              <PlusCircle size={16} /> Go to courses
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`ask-chat-layout ${isKeyboardOpen ? "is-keyboard-open" : ""}`}
    >
      {/* Top Header */}
      <header className="ask-header">
        <div className="ask-header-left">
          <button
            type="button"
            onClick={handleBack}
            className="ask-back-btn"
            aria-label="Back to previous page"
          >
            <ArrowLeft size={18} aria-hidden="true" />
            <span>Back</span>
          </button>
          <h1 className="ask-header-title">Ask Sua</h1>
          {activeCourse ? (
            <span className="ask-header-subtitle">
              {activeCourse.code ? `${activeCourse.code} · ` : ""}
              {activeCourse.name}
            </span>
          ) : null}
        </div>

        <div className="ask-header-right">
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={handleNewChat}
              className="ask-new-chat-btn"
              title="Start a new chat"
              aria-label="New chat"
            >
              <Trash2 size={16} aria-hidden="true" />
              <span className="ask-new-chat-label">New chat</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* Main Conversation & Composer */}
      <MessageList
        messages={messages}
        noteTitles={noteTitles}
        sending={sending}
        error={error}
        onRetryLast={handleRetryLast}
        onQuickAction={handleQuickAction}
        activeCourse={activeCourse}
        dividerNotice={dividerNotice}
      >
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void ask(draft)}
          onStop={handleStop}
          sending={sending}
          offline={offline}
          courses={activeCourses}
          selectedCourseId={effectiveCourseId}
          onSelectCourse={handleSelectCourse}
          usage={profile?.usage}
          disabled={!effectiveCourseId}
        />
      </MessageList>

      {/* Footer micro-copy */}
      <footer className="ask-footer">
        <p>Sua answers from your notes. If a source is missing, it says so.</p>
      </footer>
    </div>
  );
}
