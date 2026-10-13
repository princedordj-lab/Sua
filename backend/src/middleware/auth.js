import { requireAuth } from "@clerk/express";

/**
 * authenticate() runs clerkMiddleware + requireAuth and rejects with 401
 * unless a valid Clerk session token is present. req.auth() exposes
 * { userId, ... } for handlers downstream.
 */
export const authenticate = requireAuth();

export function clerkId(req) {
  const auth = typeof req.auth === "function" ? req.auth() : req.auth;
  if (!auth?.userId) {
    const err = new Error("Unauthenticated");
    err.status = 401;
    throw err;
  }
  return auth.userId;
}
