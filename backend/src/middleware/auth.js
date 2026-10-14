import { getAuth } from "@clerk/express";

/**
 * API-safe authentication middleware. `requireAuth()` is intended for
 * full-stack Express pages and may redirect unauthenticated requests. The
 * mobile client needs a JSON 401 instead.
 */
export function authenticate(req, res, next) {
  const auth = getAuth(req);
  if (!auth.userId) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  return next();
}

export function clerkId(req) {
  const { userId } = getAuth(req);
  if (!userId) {
    const err = new Error("Unauthenticated");
    err.status = 401;
    throw err;
  }
  return userId;
}
