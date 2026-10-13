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
