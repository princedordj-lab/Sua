"use client";

/**
 * The web has no data cache — every screen fetches on mount and nothing tells a
 * mounted screen that its numbers went stale because something changed
 * elsewhere. This is that missing signal: a registry of `reload` functions keyed
 * by the same strings `useResource` already uses, and nothing else. It stores no
 * data, so it cannot serve a stale copy, and it cannot drift from the server.
 *
 * Only the current page's resources are registered (navigating away unmounts
 * them), so an invalidation re-asks exactly the screens the student is looking
 * at and never a background tab's whole history.
 */

type Reload = () => void;

const listeners = new Map<string, Set<Reload>>();

export function registerResource(key: string, reload: Reload): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(reload);
  return () => {
    set.delete(reload);
    if (!set.size) listeners.delete(key);
  };
}

// Handlers that mutate often invalidate two or three prefixes at once, and the
// same screen can answer to more than one. Coalesce to one reload per tick: two
// back-to-back reloads are two transactions against a five-connection pool.
let pending: Set<Reload> | null = null;

function flush() {
  const batch = pending;
  pending = null;
  if (!batch) return;
  for (const reload of batch) {
    try {
      reload();
    } catch {
      // A screen that cannot refetch is its own problem; the rest still update.
    }
  }
}

export function invalidate(predicate: (key: string) => boolean) {
  for (const [key, set] of listeners) {
    if (!predicate(key)) continue;
    for (const reload of set) (pending ??= new Set()).add(reload);
  }
  if (pending) queueMicrotask(flush);
}

/** Every mounted screen whose key starts with `prefix` refetches. */
export function invalidatePrefix(prefix: string) {
  invalidate((key) => key.startsWith(prefix));
}

export function invalidateAll() {
  invalidate(() => true);
}

/**
 * The numbers a deck edit moves: this deck on the note and deck screens, the
 * study-set list, the due queue, and both summary counts. `courseId` is optional
 * because the caller on `/app/deck/[id]` knows it and the one on the note screen
 * may not; without it every course's set list is re-asked, which is still one
 * query per mounted screen.
 */
export function invalidateDeck(noteId: string, courseId?: string | null) {
  for (const prefix of [
    `note-study:${noteId}`,
    `deck-study:${noteId}`,
    "study-sets",
    "review:",
    "home-summary",
    "study-summary",
  ]) {
    invalidatePrefix(prefix);
  }
  invalidatePrefix(courseId ? `course-sets:${courseId}` : "course-sets:");
}

/**
 * Anything that adds, renames, moves or deletes a note: that course's list, the
 * home recents strip (keyed by the course ids it was built from), every study-set
 * listing and the summaries that count notes.
 */
export function invalidateNotes(courseId?: string | null) {
  for (const prefix of [
    courseId ? `course-notes:${courseId}` : "course-notes:",
    "home-recent:",
    "study-sets",
    "course-sets:",
    "home-summary",
    "study-summary",
  ]) {
    invalidatePrefix(prefix);
  }
}

/** A finished/failed job: the note, its deck, its course list, and the summaries. */
export function invalidateNoteOutputs(noteId: string, courseId?: string | null) {
  for (const prefix of [`note:${noteId}`, `create-note:${noteId}`, `job-note:${noteId}`]) {
    invalidatePrefix(prefix);
  }
  invalidateDeck(noteId, courseId);
  invalidateNotes(courseId);
}
