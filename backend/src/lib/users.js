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

async function readByClerkId(clerkId) {
  return withUser(clerkId, (tx) => tx.user.findUnique({ where: { clerkId } }));
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

/** Provision or refresh the local account from a Clerk user or webhook payload. */
export async function ensureUser(clerkUser, { tx = null, db = prisma, clerk = clerkClient } = {}) {
  const clerkId = clerkUser.clerkId ?? clerkUser.id;
  if (!clerkId) throw new Error("Clerk user id is required.");
  const { email, verified } = emailDetails(clerkUser);
  const name = nameFor(clerkUser);
  const imageUrl = imageFor(clerkUser);

  const current = tx
    ? await tx.user.findUnique({ where: { clerkId } })
    : await readByClerkId(clerkId);
  if (current) {
    try {
      const update = (client) => client.user.update({
        where: { clerkId },
        data: { ...(email ? { email } : {}), ...(name !== null ? { name } : {}), ...(imageUrl !== undefined ? { imageUrl } : {}) },
      });
      return tx ? await update(tx) : await withUser(clerkId, update);
    } catch (error) {
      if (!isP2002(error)) throw error;
      const raced = tx
        ? await tx.user.findUnique({ where: { clerkId } }) ?? (email ? await tx.user.findUnique({ where: { email } }) : null)
        : await reread(clerkId, email);
      if (raced?.clerkId === clerkId) return raced;
      throw conflict();
    }
  }

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
      return tx ? await update(tx) : await db.$transaction(update);
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
export async function requireUser(tx, { clerkId }) {
  const user = await tx.user.findUnique({ where: { clerkId } });
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
