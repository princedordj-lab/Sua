/**
 * Make sure a User row exists for the signed-in Clerk account.
 * Clerk webhooks normally create the row; this lazy upsert covers webhook lag
 * and any missed events. Must be called with a tx from withUser(clerkId, ...)
 * or with the top-level prisma client inside withUser.
 */
export async function ensureUser(tx, { clerkId, email, name }) {
  const data = {
    clerkId,
    email,
    name: name ?? null,
  };
  return tx.user.upsert({
    where: { clerkId },
    update: {
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    },
    create: data,
  });
}

export function toProfile(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    university: user.university,
    programme: user.programme,
    level: user.level,
    plan: user.plan,
    planExpiresAt: user.planExpiresAt,
    onboardingCompletedAt: user.onboardingCompletedAt,
  };
}
