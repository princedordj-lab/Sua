import "../src/config/env.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const [emailInput, clerkId, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
const email = String(emailInput ?? "").trim().toLowerCase();
if (!email || !clerkId || flags.some((flag) => flag !== "--apply")) {
  console.error("Usage: node scripts/relink-user.js <email> <new-clerk-id> [--apply]");
  process.exit(2);
}
if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL is required.");
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL }),
});
const relatedModels = [
  ["courses", "course"], ["notes", "note"], ["assets", "asset"],
  ["jobs", "job"], ["flashcards", "flashcard"], ["quizzes", "quiz"],
  ["feedback", "feedback"], ["usages", "usage"],
  ["pushTokens", "pushToken"], ["chatMessages", "chatMessage"],
  ["reviewLogs", "reviewLog"], ["quizAttempts", "quizAttempt"],
  ["noteTombstones", "noteTombstone"],
];

try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("No user row matches the supplied email.");
  const existingNewId = await prisma.user.findUnique({ where: { clerkId } });
  if (existingNewId && existingNewId.id !== user.id) {
    throw new Error("The new Clerk ID already belongs to another user row.");
  }
  const counts = Object.fromEntries(await Promise.all(relatedModels.map(async ([label, model]) => [
    label, await prisma[model].count({ where: { userId: user.id } }),
  ])));
  console.log(`User row ${user.id}: users.clerkId ${user.clerkId === clerkId ? "already matches" : "would change"}.`);
  for (const [table, count] of Object.entries(counts)) console.log(`${table}: ${count} related rows`);
  if (!apply) {
    console.log("DRY RUN: no rows changed. Add --apply to write.");
  } else if (user.clerkId !== clerkId) {
    await prisma.user.update({ where: { id: user.id }, data: { clerkId } });
    console.log("Applied users.clerkId relink; internal user ID and related rows remain unchanged.");
  } else {
    console.log("No change needed.");
  }
} catch (error) {
  console.error(`Relink failed (code=${String(error?.code ?? "unknown")}).`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
