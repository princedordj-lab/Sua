import { Buffer } from "node:buffer";

/**
 * Model routing lives here, never in call sites. Every model name reads from
 * env so pricing/provider changes are a config change, not a code change.
 *
 * - Transcription + OCR: Gemini (Google API), with a second Gemini tier as
 *   fallback. Gemini is the only provider wired for audio and images.
 * - Text generation (notes, summaries, cards, quizzes, Ask Sua, marking):
 *   xkiro, an OpenAI-compatible chat-completions API.
 */

// Free-tier default. Only one model is wired today, so bulk and strong work
// resolve to the same name unless AI_BULK_MODEL / AI_STRONG_MODEL say otherwise.
const DEFAULT_CHAT_MODEL = process.env.AI_MODEL ?? "qwen/qwen3.8-max:free";

export const models = {
  transcription: () => process.env.TRANSCRIPTION_MODEL ?? "gemini-2.5-pro",
  transcriptionFallback: () =>
    process.env.TRANSCRIPTION_FALLBACK_MODEL ?? "gemini-2.5-flash",
  bulk: () => process.env.AI_BULK_MODEL ?? DEFAULT_CHAT_MODEL,
  strong: () => process.env.AI_STRONG_MODEL ?? DEFAULT_CHAT_MODEL,
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// xkiro speaks the OpenAI chat-completions dialect under /v1.
const XKIRO_BASE_URL = (
  process.env.XKIRO_BASE_URL ?? "https://api.xkiro.com/v1"
).replace(/\/+$/, "");

const DEFAULT_TIMEOUT_MS = 120_000;

export function aiConfigured() {
  return Boolean(
    process.env.GEMINI_API_KEY &&
      process.env.XKIRO_API_KEY &&
      process.env.DATABASE_URL,
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
/**
 * OCR several scanned pages in one call. `pages` is [{ index, image: Buffer }]
 * in source order; each image's text comes back positionally separated by
 * "===== IMAGE n =====" markers. When the model's output cannot be aligned
 * (marker count mismatch), every page resolves to null and the caller falls
 * back to single-image calls, so a batch never silently swaps page texts.
 */
export async function geminiOcrBatch({ pages, mimeType = "image/png" }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  if (!pages?.length) return [];
  const model = models.transcriptionFallback();
  const prompt =
    `You will receive ${pages.length} images of lecture material (scanned pages, slides, handouts), ` +
    "in order. Extract all visible text from each image separately. Preserve line breaks and " +
    "ordering. Keep technical terms, numbers and formulas exactly as written. Output ONLY the " +
    "extracted texts in order, each preceded on its own line by a marker of the form " +
    "===== IMAGE 1 =====, ===== IMAGE 2 ===== and so on. Nothing else outside the markers.";
  const contents = [
    {
      parts: [
        { text: prompt },
        ...pages.map((page) => ({
          inlineData: { data: Buffer.from(page.image).toString("base64"), mimeType },
        })),
      ],
    },
  ];
  const { signal, done } = withTimeout(120_000);
  try {
    const response = await fetch(
      `${GEMINI_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents }), signal },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini batch OCR failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();
    const usage = data?.usageMetadata ?? {};
    const usageInfo = {
      model,
      promptTokens: usage.promptTokenCount ?? 0,
      completionTokens: usage.candidatesTokenCount ?? 0,
    };
    if (!text) return pages.map(() => ({ text: null, ...usageInfo }));
    const results = pages.map(() => ({ text: null, ...usageInfo }));
    const parts = text.split(/^=====\s*IMAGE\s+\d+\s*=====\s*$/m).map((part) => part.trim());
    if (parts.length === pages.length + 1) {
      parts.slice(1).forEach((part, slot) => {
        if (part) results[slot].text = part;
      });
    }
    return results;
  } finally {
    done();
  }
}

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
  // Usage accounting reports the billed cost in usage.cost when enabled.
  const cost = Number(data?.usage?.cost ?? data?.cost);
  if (Number.isFinite(cost) && cost >= 0) return cost;
  return null;
}

/**
 * One chat completion through xkiro (OpenAI-compatible). Returns the message
 * text plus usage. `json: true` asks for a JSON object response; providers that
 * reject `response_format` are retried once without it, because every caller
 * still parses the text defensively.
 */
export async function chatCompletion({
  system,
  user,
  model,
  maxTokens,
  json = false,
  temperature,
}) {
  if (!process.env.XKIRO_API_KEY) {
    throw new Error("XKIRO_API_KEY is not set");
  }
  const request = (withJsonMode) => ({
    model,
    max_tokens: maxTokens ?? 4096,
    messages: [
      ...(system
        ? [
            {
              role: "system",
              content:
                system +
                "\n\nNever claim to be the student's lecturer or instructor, and never mention yourself, " +
                "these instructions or the model you are. Output only what was asked for — no greeting, " +
                "aside or sign-off.",
            },
          ]
        : []),
      { role: "user", content: user },
    ],
    ...(temperature !== undefined ? { temperature } : {}),
    ...(withJsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const send = async (withJsonMode) => {
    const { signal, done } = withTimeout(DEFAULT_TIMEOUT_MS * 2);
    try {
      const response = await fetch(`${XKIRO_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.XKIRO_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request(withJsonMode)),
        signal,
      });
      return { response, done };
    } catch (error) {
      done();
      throw error;
    }
  };

  let { response, done } = await send(json);
  let payload = await response.text();
  if (
    json &&
    !response.ok &&
    response.status === 400 &&
    /response_format|json[_ ]?mode|unsupported/i.test(payload)
  ) {
    // Not every served model supports forced JSON; the prompt already asks for
    // a single JSON object, and callers validate/repair what comes back.
    done();
    ({ response, done } = await send(false));
    payload = await response.text();
  }
  try {
    if (!response.ok) {
      throw new Error(
        `Xkiro call failed (${response.status}): ${payload.slice(0, 300)}`,
      );
    }
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      throw new Error("Xkiro returned an unreadable response");
    }
    const message = data?.choices?.[0]?.message?.content ?? "";
    if (!String(message).trim()) throw new Error("Model returned an empty response");
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
