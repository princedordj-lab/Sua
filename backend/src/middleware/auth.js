import { getAuth } from "@clerk/express";
import { ensureUser } from "../lib/users.js";

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
  try {
    req.suaUser = await ensureUser({
      id: auth.userId,
      email: claims.email ?? claims.primary_email ?? claims.primary_email_address,
      name: claims.name ?? ([claims.first_name, claims.last_name].filter(Boolean).join(" ") || null),
      imageUrl: claims.image_url ?? claims.picture ?? null,
    });
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
