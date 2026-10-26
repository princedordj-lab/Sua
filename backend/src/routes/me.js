import { Router } from "express";
import { clerkClient } from "@clerk/express";
import { withUser } from "../lib/db.js";
import { ensureUser, requireUser, toProfile } from "../lib/users.js";
import { identityFromRequest } from "../lib/identity.js";
import { deleteAccountData } from "../lib/account.js";
import { FREE_MONTHLY_LIMITS } from "../lib/pipeline.js";

export const meRouter = Router();

// Free-plan counters are read-only in the web MVP (billing ships with mobile).
// The current month row is created lazily by the pipeline — a missing row means
// zero usage, not an error.
async function shapeWithUsage(tx, profile) {
  const month = new Date().toISOString().slice(0, 7);
  const usage = await tx.usage.findUnique({
    where: { userId_month: { userId: profile.id, month } },
  });
  return {
    ...toProfile(profile),
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

// Expo push tokens from the app; last write wins per token.
meRouter.post("/push-token", async (req, res) => {
  const identity = await identityFromRequest(req);
  const token = String(req.body?.token ?? "").trim();
  if (!token.startsWith("ExpoPushToken[")) {
    return res.status(400).json({ error: "A valid Expo push token is required" });
  }
  await withUser(identity.clerkId, async (tx) => {
    await requireUser(tx, identity);
    const profile = await tx.user.findUnique({ where: { clerkId: identity.clerkId } });
    const existing = await tx.pushToken.findUnique({ where: { token } });
    if (existing) {
      await tx.pushToken.update({
        where: { token },
        data: { userId: profile.id, updatedAt: new Date() },
      });
    } else {
      await tx.pushToken.create({ data: { userId: profile.id, token } });
    }
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
    return shapeWithUsage(tx, updated);
  });
  res.json(toProfile(profile));
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
