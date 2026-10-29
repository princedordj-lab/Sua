import { Router } from "express";
import { flushStorageDeletes, purgeNoteRows } from "../lib/note-deletion.js";
import { withUser } from "../lib/db.js";
import { requireUser } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";

export const coursesRouter = Router();

function shapeCourse(course) {
  return {
    id: course.id,
    name: course.name,
    code: course.code,
    examDate: course.examDate,
    colour: course.colour,
    lecturer: course.lecturer ?? null,
    archived: course.archived,
    noteCount: course._count?.notes ?? 0,
  };
}

function parseDate(value) {
  if (value === null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

coursesRouter.get("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const courses = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    // Archived courses are included so the client's Archived filter survives
    // a restart; screens pick active courses explicitly where needed.
    return tx.course.findMany({
      where: { userId: user.id },
      orderBy: [{ archived: "asc" }, { createdAt: "asc" }],
      include: { _count: { select: { notes: true } } },
    });
  });
  res.json(courses.map(shapeCourse));
});

coursesRouter.post("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { name, code, examDate, colour, lecturer } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const parsedExamDate = parseDate(examDate);
  if (examDate !== undefined && parsedExamDate === undefined) {
    return res.status(400).json({ error: "examDate must be a valid date" });
  }
  const course = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    return tx.course.create({
      data: {
        userId: user.id,
        name: name.trim(),
        code: code || null,
        examDate: parsedExamDate,
        colour: colour || undefined,
        lecturer: lecturer ? String(lecturer).trim() : null,
      },
      include: { _count: { select: { notes: true } } },
    });
  });
  res.status(201).json(shapeCourse(course));
});

coursesRouter.patch("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const allowed = ["name", "code", "examDate", "colour", "archived", "lecturer"];
  const changes = {};
  for (const key of allowed) {
    if (key in (req.body ?? {})) changes[key] = req.body[key];
  }
  if ("lecturer" in changes) {
    changes.lecturer = changes.lecturer ? String(changes.lecturer).trim() : null;
  }
  if ("examDate" in changes) {
    const parsedExamDate = parseDate(changes.examDate);
    if (changes.examDate !== undefined && parsedExamDate === undefined) {
      return res.status(400).json({ error: "examDate must be a valid date" });
    }
    changes.examDate = parsedExamDate;
  }
  const course = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    const result = await tx.course.updateMany({
      where: { id, userId: user.id },
      data: changes,
    });
    if (result.count === 0) return null;
    return tx.course.findFirst({
      where: { id, userId: user.id },
      include: { _count: { select: { notes: true } } },
    });
  });
  if (!course) {
    return res.status(404).json({ error: "Course not found" });
  }
  res.json(shapeCourse(course));
});

coursesRouter.delete("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const moveToCourseId = req.body?.moveToCourseId;
  const result = await withUser(identity.clerkId, async (tx) => {
    const user = await requireUser(tx, identity);
    if (moveToCourseId) {
      if (moveToCourseId === id) {
        return { count: 0, error: "invalid_move_target", storageKeys: [], userId: user.id };
      }
      const target = await tx.course.findFirst({
        where: { id: moveToCourseId, userId: user.id },
        select: { id: true },
      });
      if (!target) {
        return { count: 0, error: "move_target_not_found", storageKeys: [], userId: user.id };
      }
      await tx.note.updateMany({
        where: { courseId: id, userId: user.id },
        data: { courseId: target.id },
      });
      const deleted = await tx.course.deleteMany({ where: { id, userId: user.id } });
      return { count: deleted.count, storageKeys: [], userId: user.id };
    }
    const notes = await tx.note.findMany({
      where: { courseId: id, userId: user.id },
      select: { id: true },
    });
    const noteIds = notes.map((n) => n.id);
    if (noteIds.length > 0) {
      // Every other device learns about this from the tombstone pull; without
      // them a cached copy of the deleted course's notes would survive forever.
      await tx.noteTombstone.createMany({
        data: noteIds.map((noteId) => ({ id: noteId, userId: user.id })),
        skipDuplicates: true,
      });
    }
    const storageKeys = await purgeNoteRows(tx, { userId: user.id, noteIds });
    const deleted = await tx.course.deleteMany({ where: { id, userId: user.id } });
    return { count: deleted.count, storageKeys, userId: user.id };
  });
  if (result.count === 0) {
    return res.status(result.error === "move_target_not_found" ? 400 : 404).json({
      error: result.error === "move_target_not_found" ? "Move target not found" : "Course not found",
    });
  }
  // Object I/O belongs outside the transaction (withUser caps it at 15 s).
  await flushStorageDeletes(result.storageKeys, result.userId);
  res.status(204).end();
});
