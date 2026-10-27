"use client";

import { useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { Markdown } from "@/components/markdown";
import { SuaChatMark } from "@/components/sua-chat-icon";
import { SourceChips } from "./source-chips";
import { QuickActions, type QuickActionItem } from "./quick-actions";
import type { ChatMessageView } from "@/lib/types";

interface MessageItemProps {
  message: ChatMessageView;
  noteTitles: Map<string, string>;
  isLatestAssistant: boolean;
  onRetry?: () => void;
  onQuickAction?: (action: QuickActionItem) => void;
  quickActionsDisabled?: boolean;
}

export function MessageItem({
  message,
  noteTitles,
  isLatestAssistant,
  onRetry,
  onQuickAction,
  quickActionsDisabled = false,
}: MessageItemProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Best-effort
    }
  };

  if (message.role === "user") {
    return (
      <div className="ask-turn is-user">
        <div className="ask-bubble-user">
          <p className="ask-user-text">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message: left-aligned, no bubble, plain text with small Sua mark
  return (
    <div className="ask-turn is-sua">
      <div className="ask-sua-avatar" aria-hidden="true">
        <SuaChatMark size={26} className="ask-sua-mark-img" />
      </div>

      <div className="ask-sua-body">
        <div className="ask-sua-content">
          <Markdown text={message.content} scale="small" />
        </div>

        <SourceChips
          sourceNoteIds={message.sourceNoteIds}
          noteTitles={noteTitles}
        />

        <div className="ask-turn-actions">
          <button
            type="button"
            onClick={handleCopy}
            className="ask-action-btn"
            aria-label="Copy answer"
          >
            {copied ? (
              <>
                <Check size={13} className="text-success" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy size={13} />
                <span>Copy</span>
              </>
            )}
          </button>

          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="ask-action-btn"
              aria-label="Retry answer"
            >
              <RefreshCw size={13} />
              <span>Try again</span>
            </button>
          ) : null}
        </div>

        {isLatestAssistant && onQuickAction ? (
          <div className="ask-follow-ups">
            <QuickActions
              onSelect={onQuickAction}
              disabled={quickActionsDisabled}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="ask-turn is-sua" aria-busy="true" aria-label="Sua is thinking">
      <div className="ask-sua-avatar" aria-hidden="true">
        <SuaChatMark size={26} className="ask-sua-mark-img" />
      </div>
      <div className="ask-sua-body">
        <div className="ask-thinking-dots">
          <span className="ask-dot" />
          <span className="ask-dot" />
          <span className="ask-dot" />
        </div>
      </div>
    </div>
  );
}

export function ErrorMessage({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="ask-turn is-sua" role="alert">
      <div className="ask-sua-avatar" aria-hidden="true">
        <SuaChatMark size={26} className="ask-sua-mark-img" />
      </div>
      <div className="ask-sua-body">
        <div className="ask-error-box">
          <p className="ask-error-text">{message}</p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="ask-retry-btn"
            >
              <RefreshCw size={13} />
              <span>Try again</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
