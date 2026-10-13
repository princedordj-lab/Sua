import { clerkClient, getAuth } from "@clerk/express";

/**
 * Resolve { clerkId, email, name } for the signed-in request. Session claims
 * are used when present; otherwise the Clerk backend API is queried.
 */
export async function identityFromRequest(req) {
  const { userId, sessionClaims } = getAuth(req);
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
  if (email) return { clerkId: userId, email, name };
  const user = await clerkClient.users.getUser(userId);
  return {
    clerkId: userId,
    email:
      user.primaryEmailAddress?.emailAddress ??
      user.emailAddresses[0]?.emailAddress ??
      null,
    name:
      name ?? ([user.firstName, user.lastName].filter(Boolean).join(" ") || null),
  };
}
