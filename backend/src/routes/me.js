import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { withUser } from "../lib/db.js";
import { ensureUser, requireUser, toProfile } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import { deleteAccountData } from "../lib/account.js";
import { FREE_MONTHLY_LIMITS } from "../lib/pipeline.js";
import { isValidExpoToken, notifyUser, pushConfigured } from "../lib/push.js";

export const meRouter = Router();

// The single onboarding verdict clients may route on. A flagless account that
// already owns a course is an existing student (accounts predate the flag), so
// it must never be treated as new. Every note and job hangs off a course.
async function shapeProfile(tx, profile) {
  const hasData = (await tx.course.count({ where: { userId: profile.id } })) > 0;
  return {
    ...toProfile(profile),
    onboarded: Boolean(profile.onboardingCompletedAt) || hasData,
    hasData,
  };
}

// Free-plan counters are read-only in the web MVP (billing ships with mobile).
// The current month row is created lazily by the pipeline — a missing row means
// zero usage, not an error.
async function shapeWithUsage(tx, profile) {
  const month = new Date().toISOString().slice(0, 7);
  const [base, usage] = await Promise.all([
    shapeProfile(tx, profile),
    tx.usage.findUnique({
      where: { userId_month: { userId: profile.id, month } },
    }),
  ]);
  return {
    ...base,
    usage: {
      month,
      summaries: usage?.summaries ?? 0,
      studySets: usage?.studySets ?? 0,
      references: usage?.references ?? 0,
      assistantQueries: usage?.assistantQueries ?? 0,
      limits: {
        summaries: FREE_MONTHLY_LIMITS.summaries,
        studySets: FREE_MONTHLY_LIMITS.studySets,
        references: FREE_MONTHLY_LIMITS.references,
        assistantQueries: Number(process.env.FREE_ASSISTANT_QUERIES ?? 15),
      },
    },
  };
}

meRouter.get("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const profile = await withUser(identity.clerkId, async (tx) => {
    return shapeWithUsage(tx, req.suaUser);
  });
  res.json(profile);
});

// Expo push tokens from the app; last write wins per token. `platform` is
// required by the schema and drives per-platform copy later.
meRouter.post("/push-token", async (req, res) => {
  const identity = await identityFromRequest(req);
  const token = String(req.body?.token ?? "").trim();
  const platform = String(req.body?.platform ?? "").trim().toLowerCase();
  if (!isValidExpoToken(token)) {
    return res.status(400).json({ error: "A valid Expo push token is required" });
  }
  if (platform !== "ios" && platform !== "android") {
    return res.status(400).json({ error: "platform must be ios or android" });
  }
  await withUser(identity.clerkId, async (tx) => {
    const profile = await requireUser(tx, identity);
    await tx.pushToken.upsert({
      where: { token },
      create: { userId: profile.id, token, platform },
      update: { userId: profile.id, platform, updatedAt: new Date() },
    });
  });
  res.status(201).json({ ok: true });
});

// The device opts out of server pushes (notification settings); the Expo
// token arrives in the body (or query for transport quirks).
meRouter.delete("/push-token", async (req, res) => {
  const identity = await identityFromRequest(req);
  const token = String(req.body?.token ?? req.query?.token ?? "").trim();
  if (!token) {
    return res.status(400).json({ error: "A push token is required" });
  }
  await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    await tx.pushToken.deleteMany({ where: { token, user: { clerkId: identity.clerkId } } });
  });
  res.status(200).json({ ok: true });
});

// Web Push: the browser subscription is the credential. Endpoint is unique, so
// signing in on a shared browser re-owns the row (same rule as Expo tokens).
function readSubscription(body) {
  const endpoint = String(body?.endpoint ?? "").trim();
  const p256dh = String(body?.keys?.p256dh ?? "").trim();
  const auth = String(body?.keys?.auth ?? "").trim();
  if (!endpoint || !p256dh || !auth) return null;
  if (endpoint.length > 2048 || p256dh.length > 512 || auth.length > 256) return null;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const expiry = body?.expirationTime;
  const expirationTime =
    typeof expiry === "number" && Number.isFinite(expiry) ? new Date(expiry) : null;
  const userAgent = String(body?.userAgent ?? "").slice(0, 300) || null;
  return { endpoint, p256dh, auth, expirationTime, userAgent };
}

meRouter.post("/push-subscription", async (req, res) => {
  const identity = await identityFromRequest(req);
  const subscription = readSubscription(req.body);
  if (!subscription) {
    return res.status(400).json({ error: "A valid push subscription is required" });
  }
  const { endpoint, p256dh, auth, expirationTime, userAgent } = subscription;
  await withUser(identity.clerkId, async (tx) => {
    const profile = await requireUser(tx, identity);
    await tx.webPushSubscription.upsert({
      where: { endpoint },
      create: { userId: profile.id, endpoint, p256dh, auth, expirationTime, userAgent },
      update: { userId: profile.id, p256dh, auth, expirationTime, userAgent, updatedAt: new Date() },
    });
  });
  res.status(201).json({ ok: true });
});

meRouter.delete("/push-subscription", async (req, res) => {
  const identity = await identityFromRequest(req);
  const endpoint = String(req.body?.endpoint ?? req.query?.endpoint ?? "").trim();
  if (!endpoint) {
    return res.status(400).json({ error: "A push endpoint is required" });
  }
  await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    await tx.webPushSubscription.deleteMany({
      where: { endpoint, user: { clerkId: identity.clerkId } },
    });
  });
  res.status(200).json({ ok: true });
});

function shapeNotificationSettings(row) {
  return {
    remindersEnabled: row?.remindersEnabled ?? false,
    reminderTime: row?.reminderTime ?? "18:00",
    timezone: row?.timezone ?? "UTC",
  };
}

// Transport availability for the settings UI. VAPID absence hides the web
// toggle instead of offering a button that cannot work.
meRouter.get("/push-status", async (req, res) => {
  const identity = await identityFromRequest(req);
  const settings = await withUser(identity.clerkId, async (tx) => {
    const profile = await requireUser(tx, identity);
    return tx.notificationSetting.findUnique({ where: { userId: profile.id } });
  });
  res.json({
    ...pushConfigured(),
    reminders: shapeNotificationSettings(settings),
  });
});

meRouter.get("/notification-settings", async (req, res) => {
  const identity = await identityFromRequest(req);
  const settings = await withUser(identity.clerkId, async (tx) => {
    const profile = await requireUser(tx, identity);
    return tx.notificationSetting.findUnique({ where: { userId: profile.id } });
  });
  res.json(shapeNotificationSettings(settings));
});

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
function validTimezone(value) {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

meRouter.patch("/notification-settings", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = {};
  if ("remindersEnabled" in req.body) changes.remindersEnabled = Boolean(req.body.remindersEnabled);
  if ("reminderTime" in req.body) {
    const time = String(req.body.reminderTime ?? "").trim();
    if (!TIME_PATTERN.test(time)) {
      return res.status(400).json({ error: "Use a 24-hour time like 18:00" });
    }
    changes.reminderTime = time;
  }
  if ("timezone" in req.body) {
    const timezone = String(req.body.timezone ?? "").trim();
    if (!validTimezone(timezone)) {
      return res.status(400).json({ error: "Unknown timezone" });
    }
    changes.timezone = timezone;
  }
  const settings = await withUser(identity.clerkId, async (tx) => {
    const profile = await requireUser(tx, identity);
    return tx.notificationSetting.upsert({
      where: { userId: profile.id },
      create: { userId: profile.id, ...changes },
      update: changes,
    });
  });
  res.json(shapeNotificationSettings(settings));
});

// Proves the whole credential chain (FCM/APNs for mobile, VAPID for web)
// without waiting for a generation to finish.
meRouter.post("/push-test", async (req, res) => {
  const identity = await identityFromRequest(req);
  const transport = String(req.body?.transport ?? "").trim();
  const transports =
    transport === "mobile" || transport === "web" ? [transport] : ["mobile", "web"];
  const profile = await withUser(identity.clerkId, (tx) => requireUser(tx, identity));
  const result = await notifyUser(profile.id, {
    title: "Test notification",
    body: "If you can read this, Sua can reach this device.",
    mobilePath: "/profile/notifications",
    webPath: "/app/notifications",
    tag: "sua-test",
    transports,
  });
  res.json({ ok: result.mobile + result.web > 0, delivered: result });
});

const updatable = ["name", "university", "programme", "level"];

meRouter.patch("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const changes = {};
  for (const key of updatable) {
    if (key in req.body) changes[key] = req.body[key] || null;
  }
  if ("onboardingCompleted" in req.body && req.body.onboardingCompleted) {
    changes.onboardingCompletedAt = new Date();
  }
  const profile = await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    const updated = await tx.user.update({
      where: { clerkId: identity.clerkId },
      data: changes,
    });
    // PATCH still omits `usage` (the client keeps its hydrated counters).
    return shapeProfile(tx, updated);
  });
  res.json(profile);
});

// Delete the student's account and data: our rows + storage objects first,
// then the Clerk user itself (which revokes every session and triggers the
// user.deleted webhook for an idempotent second pass). A Clerk API failure is
// best-effort logged — the student's data is already gone, and the next sign
// in would simply start a fresh profile.
meRouter.post("/delete", async (req, res) => {
  const identity = await identityFromRequest(req);
  await deleteAccountData(identity.clerkId);
  try {
    await clerkClient.users.deleteUser(identity.clerkId);
    res.status(204).end();
  } catch (err) {
    console.error(`[clerk-user-delete-error] name=${String(err?.name ?? "Error")}`);
    res.status(204).end();
  }
});
