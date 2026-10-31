import webpush from "web-push";
import { prisma } from "../config/prisma.js";

/**
 * Push delivery for both clients.
 *
 * - Mobile: Expo Push Service (`https://exp.host/--/api/v2/push/send`), using
 *   the ExpoPushToken rows registered by the app.
 * - Web: the browser Web Push API with VAPID, using WebPushSubscription rows
 *   created from the service worker subscription.
 *
 * Delivery is best-effort: a failed push must never fail a job or a request.
 * Rows are read directly (infra work, like lib/pipeline.js) and the network
 * calls happen *outside* any withUser transaction, which times out at 15s.
 */

const EXPO_ENDPOINT = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN = /^Expo(nent)?PushToken\[[^\]]{8,}\]$/;
const EXPO_BATCH = 100;
const REQUEST_TIMEOUT_MS = 8000;
const WEB_TTL_SECONDS = 3600;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:support@sua.app";

let vapidReady = false;
function ensureVapid() {
  if (vapidReady) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    vapidReady = true;
    return true;
  } catch (error) {
    console.warn(`Web push VAPID config invalid: ${error?.message ?? error}`);
    return false;
  }
}

/** Which transports the server can actually deliver on right now. */
export function pushConfigured() {
  return { mobile: true, web: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) };
}

export function isValidExpoToken(token) {
  return typeof token === "string" && EXPO_TOKEN.test(token);
}

function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Drop tokens Expo says can never receive again. */
async function forgetExpoTokens(tokens) {
  if (!tokens.length) return;
  try {
    await prisma.pushToken.deleteMany({ where: { token: { in: tokens } } });
  } catch (error) {
    console.warn(`Push token cleanup failed: ${error?.message ?? error}`);
  }
}

async function sendExpoBatch(messages) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(EXPO_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status >= 500) {
        lastError = `status ${response.status}`;
        if (attempt === 0) {
          await sleep(750);
          continue;
        }
        console.warn(`Expo push failed (${response.status})`);
        return;
      }
      if (!response.ok) {
        console.warn(`Expo push failed (${response.status})`);
        return;
      }
      const body = await response.json().catch(() => null);
      const tickets = Array.isArray(body?.data) ? body.data : [];
      const dead = [];
      tickets.forEach((ticket, index) => {
        if (ticket?.status !== "error") return;
        if (ticket?.details?.error === "DeviceNotRegistered") {
          const token = messages[index]?.to;
          if (typeof token === "string") dead.push(token);
        }
      });
      await forgetExpoTokens(dead);
      return;
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (attempt === 0) {
        await sleep(750);
        continue;
      }
    }
  }
  console.warn(`Expo push errored (job still complete): ${lastError ?? "unknown"}`);
}

async function sendExpo(rows, payload) {
  const tokens = [
    ...new Set(
      rows
        .map((row) => row.token)
        .filter((token) => isValidExpoToken(token)),
    ),
  ];
  if (!tokens.length) return;
  for (const batch of chunks(tokens, EXPO_BATCH)) {
    await sendExpoBatch(
      batch.map((token) => ({
        to: token,
        title: payload.title,
        body: payload.body,
        sound: "default",
        channelId: "study",
        priority: payload.priority ?? "default",
        ttl: payload.ttl ?? WEB_TTL_SECONDS,
        data: { path: payload.mobilePath, tag: payload.tag },
      })),
    );
  }
}

/** 404/410 mean the subscription is gone for good. */
async function forgetWebSubscriptions(ids) {
  if (!ids.length) return;
  try {
    await prisma.webPushSubscription.deleteMany({ where: { id: { in: ids } } });
  } catch (error) {
    console.warn(`Web push subscription cleanup failed: ${error?.message ?? error}`);
  }
}

async function sendWeb(rows, payload) {
  if (!rows.length || !ensureVapid()) return;
  const dead = [];
  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
            expirationTime: row.expirationTime ? row.expirationTime.getTime() : null,
          },
          JSON.stringify({
            title: payload.title,
            body: payload.body,
            url: payload.webPath,
            tag: payload.tag,
            icon: "/icon-192.png",
          }),
          { TTL: payload.ttl ?? WEB_TTL_SECONDS, urgency: payload.priority === "high" ? "high" : "normal" },
        );
      } catch (error) {
        const status = error?.statusCode;
        if (status === 404 || status === 410) {
          dead.push(row.id);
          return;
        }
        // 401/403 usually means a VAPID mismatch — a config problem, not a
        // dead device; keep the row so delivery resumes after a fix.
        console.warn(`Web push failed for a device (${status ?? "network"})`);
      }
    }),
  );
  await forgetWebSubscriptions(dead);
}

/**
 * Send one notification to every device the student registered.
 *
 * `transports` narrows delivery (e.g. reminders go to web only because mobile
 * schedules its daily reminder locally).
 */
export async function notifyUser(
  userId,
  {
    title,
    body,
    path,
    mobilePath,
    webPath,
    tag = "sua",
    priority = "default",
    ttl = WEB_TTL_SECONDS,
    transports = ["mobile", "web"],
  } = {},
) {
  if (!userId || !title) return { mobile: 0, web: 0 };
  const wantsMobile = transports.includes("mobile");
  const wantsWeb = transports.includes("web");

  try {
    const [tokens, subscriptions] = await Promise.all([
      wantsMobile
        ? prisma.pushToken.findMany({ where: { userId } })
        : Promise.resolve([]),
      wantsWeb
        ? prisma.webPushSubscription.findMany({ where: { userId } })
        : Promise.resolve([]),
    ]);

    const payload = {
      title,
      body: body ?? "",
      mobilePath: mobilePath ?? path ?? "/home",
      webPath: webPath ?? path ?? "/app/home",
      tag,
      priority,
      ttl,
    };

    await Promise.allSettled([sendExpo(tokens, payload), sendWeb(subscriptions, payload)]);
    return { mobile: tokens.length, web: subscriptions.length };
  } catch (error) {
    console.warn(`Push dispatch failed (request still succeeded): ${error?.message ?? error}`);
    return { mobile: 0, web: 0 };
  }
}
