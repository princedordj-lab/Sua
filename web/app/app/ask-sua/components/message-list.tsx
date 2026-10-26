"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { ArrowDown } from "lucide-react";
import { MessageItem, ThinkingIndicator, ErrorMessage } from "./message-item";
import { QuickActions, type QuickActionItem } from "./quick-actions";
import type { ChatMessageView, ServerCourse } from "@/lib/types";

interface MessageListProps {
  messages: ChatMessageView[];
  noteTitles: Map<string, string>;
  sending: boolean;
  error: string | null;
  onRetryLast?: () => void;
  onQuickAction: (action: QuickActionItem) => void;
  activeCourse?: ServerCourse;
  dividerNotice?: string | null;
  children?: React.ReactNode; // Composer slot for layout
}

export function MessageList({
  messages,
  noteTitles,
  sending,
  error,
  onRetryLast,
  onQuickAction,
  activeCourse,
  dividerNotice,
  children,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const isNearBottomRef = useRef(true);

  const isEmpty = messages.length === 0;

  // Track scroll position to decide whether to auto-scroll or show "Jump to latest"
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distanceToBottom < 80;
    isNearBottomRef.current = nearBottom;
    setShowScrollBottom(!nearBottom && messages.length > 0);
  };

  const scrollToBottom = (smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setShowScrollBottom(false);
    isNearBottomRef.current = true;
  };

  // When new messages arrive or status changes, scroll to bottom if student was already near bottom
  useEffect(() => {
    if (isNearBottomRef.current) {
      scrollToBottom(true);
    }
  }, [messages.length, sending, error]);

  // Find latest assistant message id for follow-up chips
  const latestAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === "assistant")?.id;

  return (
    <div className={`ask-conversation-column ${isEmpty ? "is-empty" : "has-messages"}`}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="ask-messages-scroll"
        role="log"
        aria-live="polite"
      >
        <div className="ask-messages-inner">
          {isEmpty ? (
            <div className="ask-empty-state">
              <div className="ask-empty-hero">
                <div className="ask-empty-mark" aria-hidden="true">
                  <Image
                    src="/icon.png"
                    alt=""
                    width={44}
                    height={44}
                    className="ask-empty-mark-img"
                  />
                </div>
                <h1 className="ask-empty-title">What are you stuck on?</h1>
                <p className="ask-empty-subtitle">
                  Sua answers from your notes and shows where each answer came from.
                </p>
              </div>

              {/* Centered composer slot in empty state */}
              <div className="ask-empty-composer-slot">
                {children}
                <div className="ask-empty-chips">
                  <QuickActions onSelect={onQuickAction} disabled={sending} />
                </div>
              </div>
            </div>
          ) : (
            <div className="ask-thread-content">
              {dividerNotice ? (
                <div className="ask-switch-divider" role="separator">
                  <span>{dividerNotice}</span>
                </div>
              ) : null}

              {messages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  noteTitles={noteTitles}
                  isLatestAssistant={message.id === latestAssistantId && !sending}
                  onRetry={message.id === latestAssistantId ? onRetryLast : undefined}
                  onQuickAction={onQuickAction}
                  quickActionsDisabled={sending}
                />
              ))}

              {sending ? <ThinkingIndicator /> : null}

              {error ? (
                <ErrorMessage message={error} onRetry={onRetryLast} />
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* Floating Jump to Latest Button */}
      {showScrollBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="ask-jump-latest-btn"
          aria-label="Jump to latest message"
        >
          <ArrowDown size={14} />
          <span>Jump to latest</span>
        </button>
      ) : null}

      {/* Bottom docked composer slot when conversation is active */}
      {!isEmpty ? (
        <div className="ask-bottom-dock">
          <div className="ask-bottom-dock-inner">
            {children}
          </div>
        </div>
      ) : null}
    </div>
  );
}
