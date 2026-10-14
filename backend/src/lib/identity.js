import { clerkClient, getAuth } from "@clerk/express";

/**
 * Resolve { clerkId, email, name } for the signed-in request. Session claims
 * are used when present; otherwise the Clerk backend API is queried.
 */
export async function identityFromRequest(req) {
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
  if (email) return { clerkId: userId, email, name };
  const user = await clerkClient.users.getUser(userId);
  const resolvedEmail =
    user.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ??
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses?.[0]?.emailAddress ??
    null;
  return {
    clerkId: userId,
    email: resolvedEmail,
    name:
      name ?? ([user.firstName, user.lastName].filter(Boolean).join(" ") || null),
  };
}
