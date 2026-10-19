import { Router } from "express";
import { withUser } from "../lib/db.js";
import { ensureUser, toProfile } from "../lib/user.js";
import { identityFromRequest } from "../lib/identity.js";

export const meRouter = Router();

meRouter.get("/", async (req, res) => {
  const identity = await identityFromRequest(req);
  const profile = await withUser(identity.clerkId, (tx) =>
    ensureUser(tx, identity),
  );
  res.json(toProfile(profile));
});

// Expo push tokens from the app; last write wins per token.
meRouter.post("/push-token", async (req, res) => {
  const identity = await identityFromRequest(req);
  const token = String(req.body?.token ?? "").trim();
  if (!token.startsWith("ExpoPushToken[")) {
    return res.status(400).json({ error: "A valid Expo push token is required" });
  }
  await withUser(identity.clerkId, async (tx) => {
    await ensureUser(tx, identity);
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
    await ensureUser(tx, identity);
    return tx.user.update({
      where: { clerkId: identity.clerkId },
      data: changes,
    });
  });
  res.json(toProfile(profile));
});
