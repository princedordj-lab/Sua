import { getAuth } from "@clerk/express";
import {
  claimsChanged,
  claimsPatchFor,
  ensureUser,
  findUserByClerkId,
} from "../lib/users.js";

/**
 * API-safe authentication middleware. `requireAuth()` is intended for
 * full-stack Express pages and may redirect unauthenticated requests. The
 * mobile client needs a JSON 401 instead.
 */
export async function authenticate(req, res, next) {
  const auth = getAuth(req);
  if (!auth.userId) {
    return res.status(401).json({ error: "Unauthenticated" });
  }
  const claims = auth.sessionClaims ?? {};
  const candidate = {
    id: auth.userId,
    email: claims.email ?? claims.primary_email ?? claims.primary_email_address,
    name: claims.name ?? ([claims.first_name, claims.last_name].filter(Boolean).join(" ") || null),
    imageUrl: claims.image_url ?? claims.picture ?? null,
  };
  try {
    // Steady state is a read, not a transaction. The row is keyed by the Clerk
    // id this request's already-verified token carries, so answering "who is
    // calling" used to cost an interactive transaction here plus the route's
    // own — two per request, four to five for a first-seen account. Under the
    // burst a client fires right after sign-in that doubled the demand on
    // Neon's pooled connections and surfaced as P2028 on GET /api/me. Only a
    // missing row or a claim that genuinely changed pays for withUser now.
    const existing = await findUserByClerkId(auth.userId);
    if (existing && !claimsChanged(existing, claimsPatchFor(candidate))) {
      req.suaUser = existing;
      return next();
    }
    req.suaUser = await ensureUser(candidate);
    return next();
  } catch (error) {
    if (error?.status === 409) {
      return res.status(409).json({ error: "ACCOUNT_CONFLICT", message: error.message });
    }
    return next(error);
  }
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
