"use client";

import Link from "next/link";
import { BookOpen, Info } from "lucide-react";

interface SourceChipsProps {
  sourceNoteIds: string[];
  noteTitles: Map<string, string>;
}

export function SourceChips({ sourceNoteIds, noteTitles }: SourceChipsProps) {
  if (!sourceNoteIds || sourceNoteIds.length === 0) {
    return (
      <div className="ask-ungrounded-notice">
        <Info size={13} aria-hidden="true" />
        <span>No matching notes found, so this is general knowledge</span>
      </div>
    );
  }

  return (
    <div className="ask-sources" aria-label="Sources used for this answer">
      <span className="ask-sources-label">From:</span>
      {sourceNoteIds.map((noteId) => {
        const title = noteTitles.get(noteId) || "Source note";
        return (
          <Link
            key={noteId}
            href={`/app/note/${noteId}`}
            className="ask-source-chip"
            title={`Open note: ${title}`}
          >
            <BookOpen size={12} aria-hidden="true" />
            <span className="ask-source-title">{title}</span>
          </Link>
        );
      })}
    </div>
  );
}
