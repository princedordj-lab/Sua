import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";
import { aiConfigured, geminiTranscribe } from "../lib/ai.js";
import { openRouterChat, strongModel } from "../lib/ai.js";

export const chatRouter = Router();

// Grounding budget: notes feed into one grounded call, so keep context tight.
const MAX_CONTEXT_CHARS = 12_000;
const MAX_SOURCE_NOTES = 3;
const MIN_PER_NOTE_CHARS = 2_500;
const HISTORY_TURNS = 8;
const ANSWER_MAX_TOKENS = 1_024;
const FREE_ASSISTANT_QUERIES = Number(process.env.FREE_ASSISTANT_QUERIES ?? 15);

const QUICK_ACTIONS = {
  explain_simply:
    'The student tapped "Explain simply": use plain language, short sentences, and one everyday analogy.',
  give_example:
    'The student tapped "Give an example": add one concrete worked example drawn from the notes.',
  quiz_me:
    'The student tapped "Quiz me on this": ask ONE exam-style question on the relevant material, then ask the student to answer it in their next message. Do not reveal the answer yet.',
};

function shapeMessage(message) {
  return {
    id: message.id,
    courseId: message.courseId,
    role: message.role,
    content: message.content,
    sourceNoteIds: message.sourceNoteIds ?? [],
    createdAt: message.createdAt,
  };
}

function requireChat(res) {
  if (!process.env.DATABASE_URL || !aiConfigured()) {
    res.status(503).json({ error: "Ask Sua is not configured" });
    return false;
  }
  return true;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "how",
  "what", "why", "when", "who", "was", "his", "her", "its", "with", "from",
  "this", "that", "have", "has", "does", "did", "yes", "about", "into", "over",
]);

function tokenize(text) {
  return (String(text ?? "").toLowerCase().match(/[a-z0-9]{2,}/g) ?? [])
    .filter((token) => !STOP_WORDS.has(token))
    .slice(0, 60);
}

// Naive v1 retrieval: term overlap scoring is cheap and predictable; upgrade
// path is Postgres full-text search if grounding ever feels flaky.
function scoreNotes(question, notes) {
  const tokens = tokenize(question);
  if (!tokens.length) return [];
  return notes
    .map((note) => {
      const haystack = `${note.title} ${note.summary ?? ""} ${note.transcript ?? ""} ${note.body ?? ""}`
        .toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (!haystack.includes(token)) continue;
        score += 1 + Math.min((haystack.split(token).length - 1) * 0.25, 2);
      }
      return { note, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SOURCE_NOTES);
}

// Typed notes keep their content in body; audio and uploads fill transcript
// during ingest, so prefer transcript, fall through body, then summary.
function sourceText(note) {
  return (note.transcript ?? "").trim() || (note.body ?? "").trim() || (note.summary ?? "").trim();
}

function buildContext(entries) {
  if (!entries.length) return { context: "", sources: [] };
  const budget = Math.max(
    MIN_PER_NOTE_CHARS,
    Math.floor(MAX_CONTEXT_CHARS / entries.length),
  );
  const sources = [];
  const blocks = entries.map(({ note }, index) => {
    sources.push({ id: note.id, title: note.title || "Untitled note" });
    const text = sourceText(note).slice(0, budget);
    return `--- SOURCE ${index + 1} (title: "${sources[index].title}", id: ${note.id}) ---\n${text}`;
  });
  return { context: blocks.join("\n\n"), sources };
}

function buildUserTurn(question, quickAction, context, history) {
  const parts = [];
  if (history.length) {
    const turns = history
      .map((message) => `${message.role === "user" ? "Student" : "Sua"}: ${message.content}`)
      .join("\n");
    parts.push(`Conversation so far:\n${turns}`);
  }
  parts.push(
    context
      ? `Your course notes (only these are your sources):\n${context}`
      : "Your course notes: (none of the notes in this course have any saved text yet.)",
  );
  parts.push(`Student's question: ${question}`);
  if (quickAction && QUICK_ACTIONS[quickAction]) {
    parts.push(QUICK_ACTIONS[quickAction]);
  }
  return parts.join("\n\n");
}

function systemPrompt(course) {
  return [
    "You are Sua, a friendly study assistant inside the Sua study app.",
    `The student selected the course "${course.name}"${course.code ? ` (${course.code})` : ""}.`,
    "Answer the student's question primarily from the provided course notes.",
    "When you use the notes, mention the note title(s) you drew from (e.g. \"From your 'Lecture 3' notes\").",
    "If the notes do not contain the answer, say that the notes don't cover it, then give a clearly labelled general-knowledge explanation starting with \"General knowledge (not in your notes):\".",
    "Keep answers concise, exam-focused, and encourage the student with short warm tone.",
    "Never claim to be a lecturer or the student's instructor; remind the student to verify important facts against their own textbook.",
  ].join(" ");
}

// Free-cap shadow counting; warn-only until billing lands in Milestone 5.
async function touchAssistantUsage(tx, user) {
  const month = new Date().toISOString().slice(0, 7);
  const usage = await tx.usage.upsert({
    where: { userId_month: { userId: user.id, month } },
    create: { userId: user.id, month, assistantQueries: 1 },
    update: { assistantQueries: { increment: 1 } },
  });
  if (usage.assistantQueries > FREE_ASSISTANT_QUERIES) {
    console.warn(
      `[CAP WARNING] assistant questions: ${usage.assistantQueries} this month (limit ${FREE_ASSISTANT_QUERIES})`,
    );
  }
}

// Grounded question against the selected course's notes.
chatRouter.post("/ask", async (req, res) => {
  if (!requireChat(res)) return;
  const identity = await identityFromRequest(req);
  const courseId = String(req.body?.courseId ?? "");
  const question = String(req.body?.question ?? "").trim();
  const quickAction = String(req.body?.quickAction ?? "");
  if (!courseId) return res.status(400).json({ error: "courseId is required" });
  if (!question || question.length > 2_000) {
    return res.status(400).json({ error: "question is required (max 2000 chars)" });
  }

  const outcome = await withUser(identity.clerkId, async (tx) => {
    const user = await ensureUser(tx, identity);
    const course = await tx.course.findFirst({ where: { id: courseId, userId: user.id } });
    if (!course) return { status: 404, error: "Course not found" };

    const notes = await tx.note.findMany({
      where: { courseId: course.id },
      select: { id: true, title: true, summary: true, transcript: true, body: true },
    });
    const entries = scoreNotes(question, notes);
    const withText = entries.length
      ? entries
      : notes
          .filter((note) => sourceText(note))
          .slice(0, 1)
          .map((note) => ({ note, score: 0 }));
    const built = buildContext(withText);

    const recent = await tx.chatMessage.findMany({
      where: { courseId: course.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS,
    });
    const history = recent.reverse();

    const answer = await openRouterChat({
      system: systemPrompt(course),
      user: buildUserTurn(question, quickAction, built.context, history),
      model: strongModel(),
      maxTokens: ANSWER_MAX_TOKENS,
    });

    const userMessage = await tx.chatMessage.create({
      data: { userId: user.id, courseId: course.id, role: "user", content: question },
    });
    const assistantMessage = await tx.chatMessage.create({
      data: {
        userId: user.id,
        courseId: course.id,
        role: "assistant",
        content: answer.text,
        sourceNoteIds: built.sources.map((source) => source.id),
      },
    });
    await touchAssistantUsage(tx, user);
    return {
      user: shapeMessage(userMessage),
      assistant: shapeMessage(assistantMessage),
      sources: built.sources,
      model: answer.model,
    };
  });

  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json(outcome);
});

// Course chat history; the client caches it in SQLite for offline reading.
chatRouter.get("/messages", async (req, res) => {
  const identity = await identityFromRequest(req);
  const courseId = String(req.query.courseId ?? "");
  if (!courseId) return res.status(400).json({ error: "courseId is required" });
  const messages = await withUser(identity.clerkId, async (tx) => {
    await ensureUser(tx, identity);
    const course = await tx.course.findFirst({ where: { id: courseId } });
    if (!course) return null;
    return tx.chatMessage.findMany({ where: { courseId }, orderBy: { createdAt: "asc" } });
  });
  if (!messages) return res.status(404).json({ error: "Course not found" });
  res.json({ messages: messages.map(shapeMessage) });
});

// Voice questions: record locally, upload the clip, get text back.
// The client records m4a/audio per its expo-audio config.
chatRouter.post("/speech", async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: "Voice input is not configured" });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: "Raw audio body is required" });
  }
  if (req.body.length > 6 * 1024 * 1024) {
    return res.status(413).json({ error: "Audio clip too large (max 6 MB)" });
  }
  const mimeType = String(req.headers["content-type"] ?? "audio/mp4");
  try {
    const result = await geminiTranscribe({
      bytes: req.body,
      mimeType,
      languageHint: "English",
    });
    res.json({ text: result.text });
  } catch (error) {
    console.warn(`speech transcription failed: ${error?.message ?? error}`);
    res.status(502).json({ error: "Could not transcribe the recording" });
  }
});
