import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";

export const coursesRouter = Router();

function shapeCourse(course) {
  return {
    id: course.id,
    name: course.name,
    code: course.code,
    examDate: course.examDate,
    colour: course.colour,
    archived: course.archived,
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
    const user = await ensureUser(tx, identity);
    return tx.course.findMany({
      where: { userId: user.id, archived: false },
      orderBy: { createdAt: "asc" },
    });
  });
  res.json(courses.map(shapeCourse));
});

coursesRouter.post("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { name, code, examDate, colour } = req.body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const parsedExamDate = parseDate(examDate);
  if (examDate !== undefined && parsedExamDate === undefined) {
    return res.status(400).json({ error: "examDate must be a valid date" });
  }
  const course = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.course.create({
      data: {
        userId: user.id,
        name: name.trim(),
        code: code || null,
        examDate: parsedExamDate,
        colour: colour || undefined,
      },
    });
  });
  res.status(201).json(shapeCourse(course));
});

coursesRouter.patch("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const allowed = ["name", "code", "examDate", "colour", "archived"];
  const changes = {};
  for (const key of allowed) {
    if (key in (req.body ?? {})) changes[key] = req.body[key];
  }
  if ("examDate" in changes) {
    const parsedExamDate = parseDate(changes.examDate);
    if (changes.examDate !== undefined && parsedExamDate === undefined) {
      return res.status(400).json({ error: "examDate must be a valid date" });
    }
    changes.examDate = parsedExamDate;
  }
  const result = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.course.updateMany({ where: { id, userId: user.id }, data: changes });
  });
  if (result.count === 0) {
    return res.status(404).json({ error: "Course not found" });
  }
  const course = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.course.findFirst({ where: { id, userId: user.id } });
  });
  res.json(shapeCourse(course));
});

coursesRouter.delete("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const result = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    return tx.course.deleteMany({ where: { id, userId: user.id } });
  });
  if (result.count === 0) {
    return res.status(404).json({ error: "Course not found" });
  }
  res.status(204).end();
});
