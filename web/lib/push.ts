"use client";

import type { WebPushSubscriptionInput } from "./types";

/**
 * Browser-side Web Push plumbing.
 *
 * The server sends with VAPID; the browser holds the subscription (endpoint +
 * keys) and a service worker (`public/sw.js`) renders the notification. This
 * file only touches browser APIs — the API calls that persist the subscription
 * live in `lib/api.ts` so auth stays in one place.
 *
 * iOS only delivers web push to a site added to the Home Screen (16.4+), hence
 * `isInstalledApp()` — the settings page uses it to explain why nothing arrived.
 */

/** Public VAPID key. Absent in the build means the server cannot send web push. */
export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

const SERVICE_WORKER_URL = "/sw.js";
const REGISTER_TIMEOUT_MS = 8_000;

export type PushPermission =
  | "unsupported" // this browser has no Push API
  | "unconfigured" // the build has no VAPID key
  | "default" // never asked
  | "denied" // blocked in browser settings
  | "granted"; // allowed

export type EnableResult =
  | { ok: true; subscription: WebPushSubscriptionInput }
  | { ok: false; reason: "denied" | "unsupported" | "error"; message: string };

export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function readPermission(): PushPermission {
  if (!pushSupported()) return "unsupported";
  if (!VAPID_PUBLIC_KEY) return "unconfigured";
  if (Notification.permission === "granted") return "granted";
  if (Notification.permission === "denied") return "denied";
  return "default";
}

/** iOS/iPadOS deliver web push only to an installed Home Screen app. */
export function isInstalledApp() {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  // Safari predates the display-mode media query and reports its own flag.
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;
  return standalone || iosStandalone === true;
}

export function isIos() {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Register the service worker and wait for it to control push. Registering is
 * idempotent, so every entry point can call this.
 */
async function ensureRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
    const registration = existing ?? (await navigator.serviceWorker.register(SERVICE_WORKER_URL));
    if (registration.active) return registration;
    // `ready` resolves once a worker is active for this scope; the timeout keeps
    // a stuck install from leaving the toggle spinning forever.
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), REGISTER_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

function toInput(subscription: PushSubscription): WebPushSubscriptionInput | null {
  const json = subscription.toJSON();
  const endpoint = json.endpoint ?? subscription.endpoint;
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!endpoint || !p256dh || !auth) return null;
  return {
    endpoint,
    keys: { p256dh, auth },
    expirationTime: subscription.expirationTime ?? null,
    userAgent: navigator.userAgent.slice(0, 300),
  };
}

/** The subscription this browser already has, if any. */
export async function activeSubscription(): Promise<PushSubscription | null> {
  const registration = await ensureRegistration();
  if (!registration) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Ask for permission, subscribe, and return the row to persist. Nothing here
 * talks to the API: the caller decides what to do when the request fails.
 */
export async function enableWebPush(): Promise<EnableResult> {
  const permission = readPermission();
  if (permission === "unsupported") {
    return {
      ok: false,
      reason: "unsupported",
      message: "This browser cannot receive web notifications.",
    };
  }
  if (permission === "unconfigured") {
    return {
      ok: false,
      reason: "unsupported",
      message: "Web notifications are not configured for this build.",
    };
  }

  const asked =
    permission === "granted" ? "granted" : await Notification.requestPermission().catch(() => "denied");
  if (asked !== "granted") {
    return {
      ok: false,
      reason: "denied",
      message: "Your browser blocked notifications. Allow them for Sua in site settings.",
    };
  }

  const registration = await ensureRegistration();
  if (!registration) {
    return {
      ok: false,
      reason: "error",
      message: "The notification worker could not start. Reload the page and try again.",
    };
  }

  try {
    // Reuse an existing endpoint: re-subscribing with the same key returns it,
    // and a key mismatch throws InvalidStateError, which we recover from below.
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }
    const input = toInput(subscription);
    if (!input) {
      return {
        ok: false,
        reason: "error",
        message: "The browser returned an incomplete subscription. Try another browser.",
      };
    }
    return { ok: true, subscription: input };
  } catch {
    return {
      ok: false,
      reason: "error",
      message: "Could not create a push subscription. Reload the page and try again.",
    };
  }
}

/** Drop the browser subscription. Returns the endpoint that was removed. */
export async function disableWebPush(): Promise<string | null> {
  const subscription = await activeSubscription();
  if (!subscription) return null;
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    return endpoint;
  }
  return endpoint;
}
