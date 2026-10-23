import { Router } from "express";
import { cloudinary, cloudinaryConfigured } from "../config/cloudinary.js";
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
    // Archived courses are included so the client's Archived filter survives
    // a restart; screens pick active courses explicitly where needed.
    return tx.course.findMany({
      where: { userId: user.id },
      orderBy: [{ archived: "asc" }, { createdAt: "asc" }],
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
  const course = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const result = await tx.course.updateMany({
      where: { id, userId: user.id },
      data: changes,
    });
    if (result.count === 0) return null;
    return tx.course.findFirst({ where: { id, userId: user.id } });
  });
  if (!course) {
    return res.status(404).json({ error: "Course not found" });
  }
  res.json(shapeCourse(course));
});

coursesRouter.delete("/:id", async (req, res) => {
  const identity = await identityFromRequest(req);
  const { id } = req.params;
  const result = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const notes = await tx.note.findMany({
      where: { courseId: id, userId: user.id },
      select: { id: true },
    });
    if (notes.length > 0) {
      const noteIds = notes.map((n) => n.id);
      const assets = await tx.asset.findMany({
        where: { noteId: { in: noteIds }, userId: user.id },
      });
      for (const asset of assets) {
        if (cloudinaryConfigured() && asset.publicId && asset.publicId !== "pending") {
          try {
            await cloudinary.uploader.destroy(asset.publicId, {
              resource_type: asset.resourceType,
            });
          } catch (err) {
            console.warn(`Cloudinary destroy failed for asset ${asset.publicId}:`, err);
          }
        }
      }
      await tx.asset.deleteMany({
        where: { noteId: { in: noteIds }, userId: user.id },
      });
    }
    return tx.course.deleteMany({ where: { id, userId: user.id } });
  });
  if (result.count === 0) {
    return res.status(404).json({ error: "Course not found" });
  }
  res.status(204).end();
});
