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

  const notes = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const result = [];
    for (const change of changes) {
      if (!change?.id || change.operation === "delete") {
        if (change?.id) await tx.note.deleteMany({ where: { id: change.id, userId: user.id } });
        continue;
      }
      if (!change.courseId || typeof change.title !== "string" || typeof change.body !== "string") {
        continue;
      }
      const course = await tx.course.findFirst({ where: { id: change.courseId, userId: user.id } });
      if (!course) continue;
      const note = await tx.note.upsert({
        where: { id: change.id },
        create: {
          id: change.id,
          userId: user.id,
          courseId: change.courseId,
          title: change.title,
          body: change.body,
          sourceType: change.sourceType || "typed",
          ...(change.updatedAt ? { updatedAt: new Date(change.updatedAt) } : {}),
        },
        update: {
          courseId: change.courseId,
          title: change.title,
          body: change.body,
          sourceType: change.sourceType || "typed",
          ...(change.updatedAt ? { updatedAt: new Date(change.updatedAt) } : {}),
        },
      });
      result.push(note);
    }
    return result;
  });
  res.json({ notes: notes.map(shapeNote) });
});
