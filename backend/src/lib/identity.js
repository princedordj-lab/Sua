import { getAuth } from "@clerk/express";

/**
 * Resolve { clerkId, email, name, user } for the signed-in request. Session
 * claims are used when present. Account provisioning and first-seen Clerk
 * lookups are handled by authenticate middleware.
 *
 * `user` is the row `authenticate` already read (`req.suaUser`), so a route's
 * `requireUser` does not have to spend a WAN round trip inside its transaction
 * re-fetching the same row.
 */
export function identityFromRequest(req) {
  const { userId, sessionClaims } = getAuth(req);
  if (!userId) {
    const err = new Error("Unauthenticated");
    err.status = 401;
    throw err;
  }
  const email =
    sessionClaims?.email ??
    sessionClaims?.primary_email ??
    sessionClaims?.primary_email_address ??
    null;
  const name =
    sessionClaims?.name ??
    ([sessionClaims?.first_name, sessionClaims?.last_name]
      .filter(Boolean)
      .join(" ") || null);
  return {
    clerkId: userId,
    email,
    name,
    user: req.suaUser ?? null,
  };
}
