"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  BookOpen,
  Bot,
  ChevronRight,
  Lightbulb,
  ListChecks,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingBlock,
  PageHeader,
  ProgressBar,
  Select,
  TextArea,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useApi } from "@/lib/use-api";
import { useResource } from "@/lib/use-resource";
import { relativeDate } from "@/lib/format";
import type { ChatMessageView, ChatQuickAction, ServerNote } from "@/lib/types";

// Prompt text is identical to mobile's `ask-sua.tsx` so a quick action reads
// the same in the chat history on both platforms.
const QUICK_ACTIONS: { key: ChatQuickAction; label: string; prompt: string; Icon: typeof Lightbulb }[] = [
  {
    key: "explain_simply",
    label: "Explain simply",
    prompt: "Explain the last topic in simpler terms",
    Icon: Lightbulb,
  },
  {
    key: "give_example",
    label: "Give an example",
    prompt: "Give me an example from the notes",
    Icon: ListChecks,
  },
  {
    key: "quiz_me",
    label: "Quiz me on this",
    prompt: "Quiz me on one point from the notes",
    Icon: Sparkles,
  },
];

export default function AskSuaPage() {
  const api = useApi();
  const { courses, profile, refreshProfile, loading } = useAppData();
  const activeCourses = courses.filter((course) => !course.archived);
  const [courseId, setCourseId] = useState(activeCourses[0]?.id ?? courses[0]?.id ?? "");
  const effectiveCourseId =
    courses.find((course) => course.id === courseId)?.id ?? activeCourses[0]?.id ?? courses[0]?.id ?? "";

  const messages = useResource<{ messages: ChatMessageView[] }>(
    `chat:${effectiveCourseId}`,
    () =>
      effectiveCourseId
        ? api.chat.messages(effectiveCourseId)
        : Promise.resolve({ messages: [] }),
  );
  const notes = useResource<ServerNote[]>(
    `chat-notes:${effectiveCourseId}`,
    () =>
      effectiveCourseId ? api.notes.listForCourse(effectiveCourseId) : Promise.resolve([]),
  );

  const [thread, setThread] = useState<{
    courseId: string;
    messages: ChatMessageView[];
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ courseId: string; message: string } | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const course = courses.find((row) => row.id === effectiveCourseId);
  const history =
    thread && thread.courseId === effectiveCourseId
      ? thread.messages
      : (messages.data?.messages ?? []);
  const currentError = error?.courseId === effectiveCourseId ? error.message : null;
  const usage = profile?.usage;
  const capReached = usage
    ? usage.assistantQueries >= usage.limits.assistantQueries
    : false;

  const titles = useMemo(() => {
    const map = new Map<string, string>();
    for (const note of notes.data ?? []) map.set(note.id, note.title || "Untitled note");
    return map;
  }, [notes.data]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history.length, sending]);

  async function ask(question: string, quickAction?: ChatQuickAction) {
    const text = question.trim();
    if (!text || !effectiveCourseId || sending) return;
    const targetCourse = effectiveCourseId;
    setSending(true);
    setError(null);
    setDraft("");
    setPendingQuestion(text);
    const optimisticId = `local-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    setThread({
      courseId: targetCourse,
      messages: [
        ...history,
        {
          id: optimisticId,
          courseId: targetCourse,
          role: "user",
          content: text,
          sourceNoteIds: [],
          createdAt: now,
        },
      ],
    });
    try {
      const response = await api.chat.ask({
        courseId: targetCourse,
        question: text,
        quickAction,
      });
      setThread((current) => {
        const base =
          current && current.courseId === targetCourse
            ? current.messages.filter((message) => message.id !== optimisticId)
            : [];
        return {
          courseId: targetCourse,
          messages: [...base, response.user, response.assistant],
        };
      });
      void refreshProfile();
    } catch (cause) {
      setThread((current) =>
        current && current.courseId === targetCourse
          ? { ...current, messages: current.messages.filter((message) => message.id !== optimisticId) }
          : current,
      );
      setDraft(text);
      setError({
        courseId: targetCourse,
        message:
          cause instanceof Error ? cause.message : "Ask Sua could not answer that. Try again.",
      });
    } finally {
      setSending(false);
      setPendingQuestion(null);
    }
  }

  function send() {
    void ask(draft);
  }

  if (!loading && !activeCourses.length) {
    return (
      <div>
        <PageHeader
          eyebrow="Ask Sua"
          title="Ask Sua"
          description="Grounded answers from your own notes — not the open internet."
        />
        <EmptyState
          icon={<MessageCircle size={26} />}
          title="Add a course first"
          body="Sua answers from the notes in one course, so it needs something to read first."
          action={
            <Link href="/app/courses" className="btn btn-primary btn-md">
              Go to courses
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="ask-page">
      <PageHeader
        eyebrow="Grounded in your notes"
        title="Ask Sua"
        description="Stuck on a concept? Ask about the course you are studying. Every answer links back to the notes it used."
        actions={
          <div className="ask-course-picker">
            <label htmlFor="ask-course" className="visually-hidden">
              Course context
            </label>
            <Select
              id="ask-course"
              value={effectiveCourseId}
              onChange={(event) => setCourseId(event.target.value)}
            >
              {activeCourses.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.code ? ` · ${row.code}` : ""}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {usage ? (
        <Card className="ask-usage">
          <div className="ask-usage-copy">
            <span className="ask-usage-icon">
              <MessageCircle size={18} />
            </span>
            <div>
              <strong>
                {usage.assistantQueries} of {usage.limits.assistantQueries} questions this month
              </strong>
              <p>Free plan · {usage.month}</p>
            </div>
          </div>
          <div className="ask-usage-meter">
            <ProgressBar
              value={(usage.assistantQueries / Math.max(1, usage.limits.assistantQueries)) * 100}
              tone={capReached ? "gold" : "brand"}
              label="Assistant questions used"
            />
          </div>
        </Card>
      ) : null}

      {capReached ? (
        <Alert tone="warning" title="You have used this month’s free questions">
          Sua still answers while the preview is live, but heavy use may be limited. Billing arrives
          on mobile first.
        </Alert>
      ) : null}

      <Card className="chat-card">
        <div className="chat-head">
          <div className="chat-head-course">
            <BookOpen size={17} aria-hidden="true" />
            <strong>{course?.name ?? "Course"}</strong>
          </div>
          <div className="chat-quick-actions">
            {QUICK_ACTIONS.map(({ key, label, prompt, Icon }) => (
              <button
                key={key}
                type="button"
                className="chat-quick"
                disabled={sending}
                onClick={() => void ask(prompt, key)}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        </div>

        <div className="chat-thread" ref={listRef} aria-live="polite">
          {messages.error ? <ErrorState message={messages.error} onRetry={messages.reload} /> : null}
          {messages.loading && !messages.data && !thread ? <LoadingBlock rows={3} /> : null}

          {!messages.loading && !history.length ? (
            <div className="chat-empty">
              <span className="chat-empty-icon">
                <Bot size={28} />
              </span>
              <h2>Ask anything about {course?.name ?? "this course"}</h2>
              <p>
                Sua reads the notes in this course and answers with citations. Try one of the quick
                actions, or type your own question.
              </p>
              {notes.data && notes.data.length === 0 ? (
                <Alert tone="info">
                  This course has no notes yet, so Sua can only answer from general knowledge.{" "}
                  <Link href="/app/courses">Add material first.</Link>
                </Alert>
              ) : null}
            </div>
          ) : null}

          {history.map((message) => (
            <div
              key={message.id}
              className={`chat-bubble ${message.role === "user" ? "is-user" : "is-sua"}`}
            >
              {message.role === "assistant" ? (
                <span className="chat-avatar" aria-hidden="true">
                  <Bot size={16} />
                </span>
              ) : null}
              <div className="chat-bubble-body">
                {message.role === "assistant" ? (
                  <Markdown text={message.content} scale="small" />
                ) : (
                  <p>{message.content}</p>
                )}
                <small>{relativeDate(message.createdAt)}</small>
                {message.role === "assistant" && message.sourceNoteIds.length ? (
                  <div className="chat-sources">
                    <span>Sources</span>
                    {message.sourceNoteIds.map((noteId) => (
                      <Link key={noteId} href={`/app/note/${noteId}`} className="chat-source">
                        <BookOpen size={12} />
                        {titles.get(noteId) ?? "Source note"}
                      </Link>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {sending ? (
            <div className="chat-bubble is-sua">
              <span className="chat-avatar" aria-hidden="true">
                <Bot size={16} />
              </span>
              <div className="chat-bubble-body chat-typing">
                {pendingQuestion ? (
                  <p className="chat-typing-question">“{pendingQuestion}”</p>
                ) : null}
                <span className="chat-typing-dots" aria-label="Sua is thinking">
                  <span />
                  <span />
                  <span />
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {currentError ? <Alert title="Ask Sua could not answer">{currentError}</Alert> : null}

        <div className="chat-composer">
          <TextArea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            placeholder={`Ask about ${course?.name ?? "your course"}…`}
            rows={2}
            aria-label="Ask Sua a question"
          />
          <Button
            onClick={send}
            disabled={!draft.trim() || sending || !effectiveCourseId}
            busy={sending}
            icon={!sending ? <ArrowUp size={17} /> : undefined}
            aria-label="Send question"
          >
            Ask
          </Button>
        </div>
        <p className="chat-disclaimer">
          Sua answers from your notes. If a source is missing, it says so rather than inventing one.
        </p>
      </Card>

      <div className="ask-foot-links">
        <Link href={`/app/courses/${effectiveCourseId}`} className="text-link-sm">
          Open course notes <ChevronRight size={14} />
        </Link>
        <Link href="/app/study" className="text-link-sm">
          Study sets <ChevronRight size={14} />
        </Link>
      </div>
    </div>
  );
}
