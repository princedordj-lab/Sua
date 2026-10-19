import { Buffer } from "node:buffer";

/**
 * Model routing lives here, never in call sites. Every model name reads from
 * env so pricing/provider changes are a config change, not a code change.
 *
 * - Transcription: Gemini (Google API), with a second Gemini tier as fallback.
 * - Bulk generation (summaries, cards, quizzes): OpenRouter, cheap model.
 * - Strong model (assistant, short-answer marking — Milestone 4): OpenRouter.
 */

export const models = {
  transcription: () => process.env.TRANSCRIPTION_MODEL ?? "gemini-2.5-pro",
  transcriptionFallback: () =>
    process.env.TRANSCRIPTION_FALLBACK_MODEL ?? "gemini-2.5-flash",
  bulk: () => process.env.AI_BULK_MODEL ?? "google/gemini-2.5-flash",
  strong: () => process.env.AI_STRONG_MODEL ?? "google/gemini-2.5-pro",
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_TIMEOUT_MS = 120_000;

export function aiConfigured() {
  return Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.OPENROUTER_API_KEY &&
      process.env.REDIS_URL,
  );
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

// Rough token estimate for cost attribution when a provider omits usage
// metadata (~4 chars per English token).
export function estimateTokens(text) {
  return Math.ceil((text ?? "").length / 4);
}

/**
 * Transcribe raw audio bytes with a Gemini model. Returns
 * { text, promptTokens, completionTokens } or throws. `mimeType` follows the
 * Cloudinary format (audio/mp4 for m4a, audio/mpeg for mp3, ...).
 */
export async function geminiTranscribe({ bytes, mimeType, languageHint }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const primary = models.transcription();
  try {
    return await geminiTranscribeOnce({
      bytes,
      mimeType,
      languageHint,
      model: primary,
    });
  } catch (error) {
    console.warn(
      `Transcription with ${primary} failed (${error?.message ?? error}); retrying with fallback`,
    );
    return await geminiTranscribeOnce({
      bytes,
      mimeType,
      languageHint,
      // Second Gemini tier: same account, so an API-wide outage still fails,
      // but model-level throttling/quality issues recover.
      model: models.transcriptionFallback(),
    });
  }
}

async function geminiTranscribeOnce({ bytes, mimeType, languageHint, model }) {
  const prompt =
    "Transcribe this lecture recording exactly as spoken. Keep the speaker's words; " +
    "do not summarise. Preserve technical terms verbatim. If a section is inaudible, " +
    "write [inaudible]. Output only the transcript text." +
    (languageHint ? ` The expected language is ${languageHint}.` : "");
  const base64 = Buffer.from(bytes).toString("base64");
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inlineData: { data: base64, mimeType } },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };
  const { signal, done } = withTimeout(DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${GEMINI_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini transcription failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("Gemini returned an empty transcript");
    const usage = data?.usageMetadata ?? {};
    return {
      text,
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    };
  } finally {
    done();
  }
}

/**
 * OCR an image (photo of the board, scanned handout) with Gemini vision.
 * Returns { text, model, promptTokens, completionTokens }.
 */
export async function geminiImageText({ bytes, mimeType }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const model = models.transcriptionFallback();
  const body = {
    contents: [
      {
        parts: [
          {
            text:
              "Extract all visible text from this image of lecture material " +
              "(whiteboard, slides, handout). Preserve line breaks and ordering. " +
              "Keep technical terms exactly as written. Output only the text (markdown is fine).",
          },
          { inlineData: { data: Buffer.from(bytes).toString("base64"), mimeType } },
        ],
      },
    ],
  };
  const { signal, done } = withTimeout(90_000);
  try {
    const response = await fetch(
      `${GEMINI_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini OCR failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    const usage = data?.usageMetadata ?? {};
    return {
      text: text || null,
      model,
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    };
  } finally {
    done();
  }
}

function billableCostUsd(data) {
  // OpenRouter reports the billed cost in usage.cost when accounting is on.
  const cost = Number(data?.usage?.cost ?? data?.cost);
  if (Number.isFinite(cost) && cost >= 0) return cost;
  return null;
}

/**
 * One chat completion through OpenRouter. Returns the message text plus usage.
 * `json: true` asks for a JSON object response (response_format json_object).
 */
export async function openRouterChat({
  system,
  user,
  model,
  maxTokens,
  json = false,
  temperature,
}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const body = {
    model,
    max_tokens: maxTokens ?? 4096,
    messages: [
      ...(system
        ? [{ role: "system", content: system + "\n\nNever claim to be a lecturer or the student's instructor; remind the student to verify important facts against their own textbook." }]
        : []),
      { role: "user", content: user },
    ],
    ...(temperature !== undefined ? { temperature } : {}),
    ...(json ? { response_format: { type: "json_object" } } : {}),
  };
  const { signal, done } = withTimeout(DEFAULT_TIMEOUT_MS * 2);
  try {
    const response = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://sua.app",
        "X-Title": "Sua",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenRouter call failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const message = data?.choices?.[0]?.message?.content ?? "";
    if (!message.trim()) throw new Error("Model returned an empty response");
    const usage = data?.usage ?? {};
    const cost = billableCostUsd(data);
    return {
      text: message,
      model: data?.model ?? model,
      promptTokens: usage.prompt_tokens ?? estimateTokens(system + user),
      completionTokens: usage.completion_tokens ?? estimateTokens(message),
      usdMicros: cost != null ? Math.round(cost * 1_000_000) : null,
    };
  } finally {
    done();
  }
}

// Bulk work should stay low-cost; the strong model is opt-in per call.
export function bulkModel() {
  return models.bulk();
}

export function strongModel() {
  return models.strong();
}
