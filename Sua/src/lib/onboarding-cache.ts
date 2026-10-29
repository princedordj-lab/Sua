import type { SQLiteDatabase } from "expo-sqlite";
import { getSetting, setSetting } from "./notes";

// Per-user on purpose: two accounts can share one phone, and one account's
// verdict must never decide the other's destination.
function keyFor(clerkUserId: string) {
  return `onboarded:${clerkUserId}`;
}

export async function readOnboardedCache(
  db: SQLiteDatabase,
  clerkUserId: string,
): Promise<boolean | null> {
  const value = await getSetting(db, keyFor(clerkUserId)).catch(() => null);
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
}

export async function writeOnboardedCache(
  db: SQLiteDatabase,
  clerkUserId: string,
  onboarded: boolean,
) {
  await setSetting(db, keyFor(clerkUserId), onboarded ? "1" : "0").catch(() => {});
}
