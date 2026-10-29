import { Buffer } from "node:buffer";
import { documentRead as documentReadConfig } from "../config/ai-pipeline.js";

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
  // Native document reading (PDFs/images read as files, not OCR'd page by
  // page). Model names live in config/ai-pipeline.js with every other knob; the
  // fallback covers "model overloaded or retired" (404/503), which was observed
  // live — it never covers quota, which is per project.
  documentRead: () => documentReadConfig.model,
  documentReadFallback: () => documentReadConfig.fallbackModel,
  bulk: () => process.env.AI_BULK_MODEL ?? DEFAULT_CHAT_MODEL,
  strong: () => process.env.AI_STRONG_MODEL ?? DEFAULT_CHAT_MODEL,
};

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_FILES_BASE = "https://generativelanguage.googleapis.com/v1beta";

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

/**
 * One Gemini `generateContent` request over arbitrary parts (documents, images,
 * text). Model routing and the fallback hop live here: the read model is the
 * documented one, but a 404/503 means "this model is gone or overloaded", not
 * "this file cannot be read", so one retry on the fallback model is worth it.
 * A 429 is never retried — the quota is per project, so a second model would
 * fail the same way and only burn time.
 */
async function geminiPartsRequest({
  parts,
  schema = null,
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature = 0,
  thinkingBudget = 0,
  label = "Gemini document read",
}) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature,
      ...(schema
        ? { responseMimeType: "application/json", responseSchema: schema }
        : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      ...(thinkingBudget != null
        ? { thinkingConfig: { thinkingBudget } }
        : {}),
    },
  };

  const primary = models.documentRead();
  const candidates = [primary, models.documentReadFallback()].filter(
    (model, index, all) => model && all.indexOf(model) === index,
  );

  let lastError = null;
  const deadline = Date.now() + timeoutMs;
  for (const model of candidates) {
    // A fallback hop must not double the caller's budget: the retry gets what
    // is left, and a hop with no time left is skipped.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const { signal, done } = withTimeout(remaining);
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
      const payload = await response.text();
      if (!response.ok) {
        const error = new Error(
          `${label} failed (${response.status}): ${payload.slice(0, 300)}`,
        );
        error.status = response.status;
        lastError = error;
        // Overloaded / unknown model: try the next candidate. Anything else
        // (quota, bad request) is final.
        if (response.status === 404 || response.status === 503) {
          const next = candidates[candidates.indexOf(model) + 1];
          if (next) {
            console.warn(
              `[ai] ${label}: ${model} unavailable (${response.status}); retrying with ${next}`,
            );
          }
          continue;
        }
        throw error;
      }
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        throw new Error(`${label} returned an unreadable response`);
      }
      const text = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();
      if (!text) throw new Error(`${label} returned an empty response`);
      const usage = data?.usageMetadata ?? {};
      return {
        text,
        model,
        promptTokens: usage.promptTokenCount ?? 0,
        completionTokens: usage.candidatesTokenCount ?? 0,
      };
    } finally {
      done();
    }
  }
  throw lastError ?? new Error(`${label} is unavailable`);
}

/**
 * Read a PDF natively with Gemini — the document itself is the input, so
 * charts, tables and scanned pages are read by the model instead of being
 * OCR'd page by page. `fileUri` comes from geminiUploadFile for large files;
 * otherwise the bytes go inline. Returns the JSON text plus usage.
 */
export async function geminiReadDocument({
  bytes,
  fileUri = null,
  mimeType,
  prompt,
  schema = null,
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature = 0,
  thinkingBudget = 0,
}) {
  if (!fileUri && !bytes?.length) throw new Error("Gemini document read got no document");
  const documentPart = fileUri
    ? { fileData: { fileUri, mimeType } }
    : { inlineData: { data: Buffer.from(bytes).toString("base64"), mimeType } };
  return geminiPartsRequest({
    parts: [{ text: prompt }, documentPart],
    schema,
    maxOutputTokens,
    timeoutMs,
    temperature,
    thinkingBudget,
    label: "Gemini document read",
  });
}

/**
 * Read several images in one request (a deck's slides, a document's figures).
 * Each image is prefixed with its id so the response can be mapped back
 * without relying on order alone. Returns the JSON text plus usage.
 */
export async function geminiReadImages({
  images,
  prompt,
  schema = null,
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  temperature = 0,
  thinkingBudget = 0,
}) {
  if (!images?.length) throw new Error("Gemini image read got no images");
  const parts = [{ text: prompt }];
  for (const image of images) {
    parts.push({ text: `Image id: ${image.id}` });
    parts.push({
      inlineData: {
        data: Buffer.from(image.bytes).toString("base64"),
        mimeType: image.mimeType,
      },
    });
  }
  return geminiPartsRequest({
    parts,
    schema,
    maxOutputTokens,
    timeoutMs,
    temperature,
    thinkingBudget,
    label: "Gemini image read",
  });
}


/**
 * Upload a file to Gemini's Files API (resumable protocol). Used when the
 * base64-inline request would exceed the request size limit. Files are free to
 * store and are deleted by Google after 48h; the caller deletes them sooner.
 */
export async function geminiUploadFile({
  bytes,
  mimeType,
  displayName = "document",
}) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
  if (!bytes?.length) throw new Error("Gemini file upload got no bytes");
  const key = process.env.GEMINI_API_KEY;
  const start = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${key}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.length),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );
  if (!start.ok) {
    const detail = await start.text();
    throw new Error(
      `Gemini file upload failed (${start.status}): ${detail.slice(0, 300)}`,
    );
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini file upload returned no upload URL");

  const finalize = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  const payload = await finalize.text();
  if (!finalize.ok) {
    throw new Error(
      `Gemini file upload finalize failed (${finalize.status}): ${payload.slice(0, 300)}`,
    );
  }
  let file = null;
  try {
    file = JSON.parse(payload)?.file ?? null;
  } catch {
    file = null;
  }
  if (!file?.name || !file?.uri) {
    throw new Error("Gemini file upload returned no file reference");
  }
  // Ingestion is asynchronous: a large PDF can stay PROCESSING for a few
  // seconds, and reading it too early fails.
  for (let attempt = 0; attempt < 15 && file.state === "PROCESSING"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    try {
      const status = await fetch(`${GEMINI_FILES_BASE}/${file.name}?key=${key}`);
      if (status.ok) file = { ...file, ...(await status.json()) };
    } catch {
      // One failed poll must not abort an upload that is probably fine.
    }
  }
  if (file.state === "FAILED") {
    throw new Error("Gemini could not process the uploaded file");
  }
  return { name: file.name, uri: file.uri, mimeType: file.mimeType ?? mimeType };
}

/** Best-effort cleanup; Google also removes uploaded files after 48h. */
export async function geminiDeleteFile(name) {
  if (!name || !process.env.GEMINI_API_KEY) return;
  try {
    await fetch(`${GEMINI_FILES_BASE}/${name}?key=${process.env.GEMINI_API_KEY}`, {
      method: "DELETE",
    });
  } catch {
    // Cleanup is best-effort.
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
// Test seam: harnesses and tests can substitute a deterministic handler for
// every model call — offline, free, repeatable. Production never sets it.
let aiMock = null;
export function setAiMock(handler) {
  aiMock = handler;
}

export async function chatCompletion({
  system,
  user,
  model,
  maxTokens,
  json = false,
  temperature,
}) {
  if (aiMock) {
    return aiMock({ system, user, model, maxTokens, json, temperature });
  }
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
