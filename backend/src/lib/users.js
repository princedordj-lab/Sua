import { clerkClient } from "@clerk/express";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";
import { withUser } from "./db.js";

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase();
const nameFor = (user) => user.name ?? (
  [user.firstName ?? user.first_name, user.lastName ?? user.last_name]
    .filter(Boolean).join(" ") || null
);
function imageFor(user) {
  if ("imageUrl" in user) return user.imageUrl;
  if ("image_url" in user) return user.image_url;
  if ("profileImageUrl" in user) return user.profileImageUrl;
  return undefined;
}

function emailDetails(user) {
  const addresses = user.emailAddresses ?? user.email_addresses ?? [];
  const primaryId = user.primaryEmailAddressId ?? user.primary_email_address_id;
  const primary = (primaryId ? addresses.find((entry) => entry.id === primaryId) : null) ??
    user.primaryEmailAddress ?? null;
  return {
    email: normalizeEmail(primary?.emailAddress ?? primary?.email_address ?? user.email),
    verified: primary?.verification?.status === "verified",
  };
}

function isP2002(error) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" ||
    error?.code === "P2002";
}

function conflict() {
  const error = new Error("This email is already associated with another account.");
  error.status = 409;
  error.code = "ACCOUNT_CONFLICT";
  return error;
}

// The first requests from a brand-new account all miss the local row, and each
// one used to make its own Clerk Backend fetch, its own INSERT and its own
// P2002 re-read — five transactions apiece, stacked. Concurrent provisions for
// one Clerk id share a single attempt inside this instance; the P2002 handling
// below stays as the safety net across Vercel instances.
const provisioning = new Map();

async function readUserByClerkId(client, clerkId) {
  return client.user.findUnique({ where: { clerkId } });
}

function readByClerkId(clerkId) {
  return withUser(clerkId, (tx) => readUserByClerkId(tx, clerkId));
}

async function reread(clerkId, email) {
  const current = await readByClerkId(clerkId).catch(() => null);
  if (current) return current;
  return email ? prisma.user.findUnique({ where: { email } }) : null;
}

async function oldClerkIdIsStale(clerkId, clerkApi = clerkClient) {
  try {
    await clerkApi.users.getUser(clerkId);
    return false;
  } catch (error) {
    if (error?.status === 404 || error?.statusCode === 404) return true;
    throw error;
  }
}

/**
 * The stored fields this request's claims say should be true. A claim the token
 * does not carry is not a change request: `imageUrl: null` means "this session
 * token has no picture", not "clear the stored avatar".
 */
export function claimsPatchFor(clerkUser) {
  const { email } = emailDetails(clerkUser);
  const name = nameFor(clerkUser);
  const imageUrl = imageFor(clerkUser);
  return {
    ...(email ? { email } : {}),
    ...(name !== null ? { name } : {}),
    ...(imageUrl != null ? { imageUrl } : {}),
  };
}

/** True when the stored row no longer matches the claims on this request. */
export function claimsChanged(profile, patch) {
  return Object.keys(patch).some((key) => profile[key] !== patch[key]);
}

/**
 * Steady-state authenticated lookup, deliberately outside `withUser`. The row is
 * keyed by the Clerk id already verified from the session JWT, so this answers
 * "who is calling" without spending a transaction on it. Provisioning and every
 * write still go through `withUser`.
 *
 * Load-bearing caveat: no transaction means no `app.current_user_id`, so this
 * reads as BYPASSRLS today's `neondb_owner` does. If that role ever loses
 * BYPASSRLS, this returns null for every caller and every request silently falls
 * back to the transactional provisioning path — slower, never wrong.
 */
export function findUserByClerkId(clerkId) {
  return prisma.user.findUnique({ where: { clerkId } });
}

/** Provision or refresh the local account from a Clerk user or webhook payload. */
export function ensureUser(clerkUser, options = {}) {
  const clerkId = clerkUser.clerkId ?? clerkUser.id;
  if (!clerkId) throw new Error("Clerk user id is required.");
  // A caller that already holds a transaction owns its connection and its own
  // commit, so it must never be folded into another request's in-flight work.
  if (options.tx) return provisionUser(clerkUser, options);
  const pending = provisioning.get(clerkId);
  if (pending) return pending;
  const attempt = provisionUser(clerkUser, options).finally(() => {
    if (provisioning.get(clerkId) === attempt) provisioning.delete(clerkId);
  });
  provisioning.set(clerkId, attempt);
  return attempt;
}

async function provisionUser(clerkUser, { tx = null, db = prisma, clerk = clerkClient } = {}) {
  const clerkId = clerkUser.clerkId ?? clerkUser.id;
  const { email, verified } = emailDetails(clerkUser);
  const name = nameFor(clerkUser);
  const patch = claimsPatchFor(clerkUser);

  // Read and (only if a claim actually differs) write inside ONE transaction.
  // Every statement is a WAN round trip to Neon, so the old unconditional
  // UPDATE in a second transaction charged this path an extra
  // BEGIN/set_config/UPDATE/COMMIT. Reached only for a first-seen account or a
  // claim that changed — the steady-state request never gets here.
  const readOrRefresh = async (client) => {
    const current = await client.user.findUnique({ where: { clerkId } });
    if (!current) return null;
    return claimsChanged(current, patch)
      ? client.user.update({ where: { clerkId }, data: patch })
      : current;
  };

  let current = null;
  try {
    current = tx
      ? await readOrRefresh(tx)
      : await withUser(clerkId, readOrRefresh);
  } catch (error) {
    if (!isP2002(error)) throw error;
    const raced = tx
      ? await tx.user.findUnique({ where: { clerkId } }) ?? (email ? await tx.user.findUnique({ where: { email } }) : null)
      : await reread(clerkId, email);
    if (raced?.clerkId === clerkId) return raced;
    throw conflict();
  }
  if (current) return current;

  // Only first-seen accounts need the full Clerk Backend User and old-id check.
  let fullUser = clerkUser.emailAddresses || clerkUser.email_addresses ? clerkUser : null;
  if (!fullUser) {
    try {
      fullUser = await clerk.users.getUser(clerkId);
    } catch (err) {
      console.error(`[clerk-fetch-user-error] clerkId=${clerkId} status=${err?.status ?? err?.statusCode} message=${err?.message}`);
      throw err;
    }
  }
  const details = emailDetails(fullUser);
  const normalizedEmail = details.email || email;
  const normalizedName = nameFor(fullUser) ?? name;
  if (!normalizedEmail) throw conflict();

  // This is a first-seen cross-account ownership check by exact email. It is
  // outside withUser because the new Clerk id cannot see the old owner via RLS.
  const matchingEmail = await (tx?.user ?? db.user).findUnique({ where: { email: normalizedEmail } });
  try {
    if (matchingEmail) {
      if (!details.verified || !(await oldClerkIdIsStale(matchingEmail.clerkId, clerk))) {
        throw conflict();
      }
      const update = (client) => client.user.update({
        where: { id: matchingEmail.id },
        data: { clerkId, email: normalizedEmail, name: normalizedName, imageUrl: imageFor(fullUser) },
      });
      // Same budget as `withUser`: only `maxWait` is configured globally, so
      // this would otherwise run on Prisma's 5 s default timeout — less than
      // one cold WAN round trip can cost.
      return tx
        ? await update(tx)
        : await db.$transaction(update, { maxWait: 10_000, timeout: 15_000 });
    }
    const create = (client) => client.user.create({ data: { clerkId, email: normalizedEmail, name: normalizedName, imageUrl: imageFor(fullUser) } });
    return tx ? await create(tx) : await withUser(clerkId, create);
  } catch (error) {
    if (error?.code === "ACCOUNT_CONFLICT") throw error;
    if (!isP2002(error)) throw error;
    const raced = tx
      ? await tx.user.findUnique({ where: { clerkId } }) ?? await tx.user.findUnique({ where: { email: normalizedEmail } })
      : await reread(clerkId, normalizedEmail);
    if (raced?.clerkId === clerkId) return raced;
    if (raced) throw conflict();
    throw error;
  }
}

/** Existing authenticated route helper; provisioning happens in authenticate. */
export async function requireUser(client, identity) {
  // `authenticate` already read this row outside a transaction, so the steady
  // state is a hand-off, not a query. The read below stays for callers without
  // a preloaded identity (and for the day the Neon role loses BYPASSRLS, which
  // makes `findUserByClerkId` return null and every request take this path).
  if (identity.user) return identity.user;
  const user = await readUserByClerkId(client, identity.clerkId);
  if (!user) throw new Error("Authenticated user was not provisioned.");
  return user;
}

export function toProfile(user) {
  return {
    id: user.id, name: user.name, email: user.email, imageUrl: user.imageUrl,
    university: user.university, programme: user.programme, level: user.level,
    plan: user.plan, planExpiresAt: user.planExpiresAt,
    onboardingCompletedAt: user.onboardingCompletedAt,
  };
}
