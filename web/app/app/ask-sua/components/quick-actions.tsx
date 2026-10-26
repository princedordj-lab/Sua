"use client";

import { Lightbulb, ListChecks, Sparkles } from "lucide-react";
import type { ChatQuickAction } from "@/lib/types";

export interface QuickActionItem {
  key: ChatQuickAction;
  label: string;
  prompt: string;
  Icon: typeof Lightbulb;
}

export const QUICK_ACTIONS: QuickActionItem[] = [
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

interface QuickActionsProps {
  onSelect: (action: QuickActionItem) => void;
  disabled?: boolean;
  className?: string;
}

export function QuickActions({ onSelect, disabled, className = "" }: QuickActionsProps) {
  return (
    <div className={`ask-quick-actions ${className}`}>
      {QUICK_ACTIONS.map((action) => {
        const { key, label, Icon } = action;
        return (
          <button
            key={key}
            type="button"
            className="ask-chip"
            disabled={disabled}
            onClick={() => onSelect(action)}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
          </button>
        );
      })}
    </div>
  );
}
