import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";

export const notesRouter = Router();

function shapeNote(note) {
  return {
    id: note.id,
    courseId: note.courseId,
    title: note.title,
    body: note.body,
    sourceType: note.sourceType,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

notesRouter.get("/course/:courseId", async (req, res) => {
  const identity = await identityFromRequest(req);
  const notes = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.note.findMany({
      where: { userId: user.id, courseId: req.params.courseId },
      orderBy: { updatedAt: "desc" },
    });
  });
  res.json(notes.map(shapeNote));
});

notesRouter.post("/sync", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
  if (changes.length > 100) return res.status(400).json({ error: "Too many changes" });

  const { notes, results } = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const notes = [];
    const results = [];
    for (const change of changes) {
      if (!change?.id) {
        results.push({ id: "", status: "rejected", reason: "missing id" });
        continue;
      }
      if (change.operation === "delete") {
        await tx.note.deleteMany({ where: { id: change.id, userId: user.id } });
        // Idempotent: deleting a note that is already gone still succeeds.
        results.push({ id: change.id, status: "accepted" });
        continue;
      }
      if (!change.courseId || typeof change.title !== "string" || typeof change.body !== "string") {
        results.push({ id: change.id, status: "rejected", reason: "invalid payload" });
        continue;
      }
      const course = await tx.course.findFirst({ where: { id: change.courseId, userId: user.id } });
      if (!course) {
        results.push({ id: change.id, status: "rejected", reason: "course not found" });
        continue;
      }
      const existing = await tx.note.findUnique({ where: { id: change.id } });
      if (existing && existing.userId !== user.id) {
        results.push({ id: change.id, status: "rejected", reason: "id not available" });
        continue;
      }
      const parsedUpdatedAt = change.updatedAt ? new Date(change.updatedAt) : null;
      if (parsedUpdatedAt && Number.isNaN(parsedUpdatedAt.getTime())) {
        results.push({ id: change.id, status: "rejected", reason: "invalid updatedAt" });
        continue;
      }
      // Timestamp guard: reject a write that is older than what the server
      // already holds and hand the newer copy back so the device can adopt it.
      if (
        existing &&
        parsedUpdatedAt &&
        parsedUpdatedAt.getTime() < existing.updatedAt.getTime()
      ) {
        results.push({ id: change.id, status: "conflict", note: shapeNote(existing) });
        continue;
      }
      const data = {
        courseId: change.courseId,
        title: change.title,
        body: change.body,
        sourceType: change.sourceType || "typed",
        ...(parsedUpdatedAt ? { updatedAt: parsedUpdatedAt } : {}),
      };
      const note = existing
        ? await tx.note.update({ where: { id: existing.id }, data })
        : await tx.note.create({
            data: { id: change.id, userId: user.id, ...data },
          });
      notes.push(note);
      results.push({ id: change.id, status: "accepted" });
    }
    return { notes, results };
  });
  res.json({ notes: notes.map(shapeNote), results });
});
