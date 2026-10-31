"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import {
  BellRing,
  ChevronLeft,
  Clock3,
  Monitor,
  Send,
  ShieldAlert,
  Smartphone,
} from "lucide-react";
import { Alert, Button, Card, Chip, Field, PageHeader, Toggle } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import {
  activeSubscription,
  disableWebPush,
  enableWebPush,
  isInstalledApp,
  isIos,
  readPermission,
  type PushPermission,
} from "@/lib/push";
import type { NotificationSettings } from "@/lib/types";

type BrowserPushState = {
  permission: PushPermission;
  ios: boolean;
  installed: boolean;
};

// Browser capabilities are unreadable on the server, so they come through
// `useSyncExternalStore` with a neutral server snapshot instead of state set
// from an effect (which would flash "unsupported" on every first paint).
const SERVER_BROWSER_STATE: BrowserPushState = {
  permission: "default",
  ios: false,
  installed: false,
};

let cachedBrowserState: BrowserPushState | null = null;

function readBrowserState(): BrowserPushState {
  if (!cachedBrowserState) {
    cachedBrowserState = {
      permission: readPermission(),
      ios: isIos(),
      installed: isInstalledApp(),
    };
  }
  return cachedBrowserState;
}

function subscribeBrowserState(onChange: () => void) {
  // Permission changes while the tab is hidden (the student just allowed
  // notifications in site settings), so re-read on focus and on visibility.
  const refresh = () => {
    cachedBrowserState = null;
    onChange();
  };
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

function useBrowserPushState() {
  return useSyncExternalStore(subscribeBrowserState, readBrowserState, () => SERVER_BROWSER_STATE);
}

/**
 * Notification settings for the browser.
 *
 * Web push is opt-in from this page only — nothing asks on load, matching the
 * phone. Reminders are server-driven here: the daily jobs tick looks for due
 * cards and pushes once, while the mobile app schedules its own reminder
 * locally (offline-first).
 */
export default function NotificationsPage() {
  const api = useApi();
  const browser = useBrowserPushState();

  const [serverWeb, setServerWeb] = useState<boolean | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [reminders, setReminders] = useState<NotificationSettings | null>(null);
  const [time, setTime] = useState("18:00");
  const [busy, setBusy] = useState<"push" | "reminders" | "test" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.push
      .status()
      .then((status) => {
        if (cancelled) return;
        setServerWeb(status.web);
        setReminders(status.reminders);
        setTime(status.reminders.reminderTime);
      })
      .catch(() => {
        if (!cancelled) setServerWeb(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Does this browser already hold a subscription? Decided after mount: the
  // service worker is a browser API, and a subscription created in an earlier
  // session should show as "on" without the student touching anything.
  useEffect(() => {
    let cancelled = false;
    activeSubscription()
      .then((subscription) => {
        if (!cancelled) setSubscribed(Boolean(subscription));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const togglePush = useCallback(
    async (next: boolean) => {
      if (busy) return;
      setBusy("push");
      setMessage(null);
      try {
        if (next) {
          const result = await enableWebPush();
          if (!result.ok) {
            setMessage({ tone: "error", text: result.message });
            return;
          }
          try {
            await api.push.subscribe(result.subscription);
            setSubscribed(true);
          } catch {
            // Keep browser and server in step: a subscription the API never
            // stored would silently receive nothing.
            await disableWebPush();
            setSubscribed(false);
            setMessage({
              tone: "error",
              text: "Sua could not save this browser. Check your connection and try again.",
            });
          }
          return;
        }

        const endpoint = await disableWebPush();
        if (endpoint) {
          await api.push.unsubscribe(endpoint).catch(() => {});
        }
        setSubscribed(false);
      } finally {
        setBusy(null);
      }
    },
    [api, busy],
  );

  const saveReminders = useCallback(
    async (changes: Partial<NotificationSettings>) => {
      // Optimistic: the switch should move on tap, not after a round trip.
      const previous = reminders;
      if (previous) setReminders({ ...previous, ...changes });
      setBusy("reminders");
      setMessage(null);
      try {
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const saved = await api.push.updateSettings({ timezone, ...changes });
        setReminders(saved);
        setTime(saved.reminderTime);
        return saved;
      } catch {
        setReminders(previous);
        setMessage({
          tone: "error",
          text: "Couldn't save that. Check your connection and try again.",
        });
        return null;
      } finally {
        setBusy(null);
      }
    },
    [api, reminders],
  );

  const sendTest = useCallback(async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result = await api.push.test();
      setMessage(
        result.delivered.web > 0
          ? { tone: "success", text: "Test sent. It should arrive in a moment." }
          : {
              tone: "error",
              text: "No browser is registered yet. Turn push notifications on first.",
            },
      );
    } catch {
      setMessage({
        tone: "error",
        text: "Couldn't send the test. Check your connection and try again.",
      });
    } finally {
      setBusy(null);
    }
  }, [api]);

  const blocked = browser.permission === "denied";
  const unsupported = browser.permission === "unsupported";
  const unconfigured = browser.permission === "unconfigured";
  const unavailable = unsupported || serverWeb === false;
  const remindersOn = reminders?.remindersEnabled ?? false;

  return (
    <div className="prefs-page">
      <Link href="/app/preferences" className="prefs-back">
        <ChevronLeft size={15} /> Preferences
      </Link>

      <PageHeader
        eyebrow="Stay in the loop"
        title="Notifications"
        description="A push when a study set finishes processing, and one gentle nudge a day when cards are due. Everything is opt-in and can be turned off here at any time."
      />

      {message ? (
        <Alert
          tone={message.tone === "error" ? "danger" : "success"}
          title={message.tone === "error" ? "Not saved" : "Sent"}
        >
          {message.text}
        </Alert>
      ) : null}

      <div className="prefs-grid">
        <Card className="prefs-card prefs-card-wide">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <BellRing size={18} />
            </span>
            <div>
              <h2>Push notifications</h2>
              <p>Arrives on this browser, even when Sua is closed.</p>
            </div>
            {subscribed ? <Chip tone="success">On</Chip> : <Chip tone="muted">Off</Chip>}
          </div>

          {loading ? (
            <p className="prefs-note">Checking this browser…</p>
          ) : unconfigured ? (
            <Alert tone="info" title="Not set up on this server">
              Web push needs a VAPID key pair in the server environment. Until then, only the
              Android app can receive pushes.
            </Alert>
          ) : unavailable ? (
            <Alert tone="info" title="This browser cannot receive pushes">
              {unsupported
                ? "Use a recent version of Chrome, Edge, Firefox or Safari over HTTPS."
                : "Web notifications are disabled for this server. The Android app still delivers them."}
            </Alert>
          ) : (
            <>
              <Toggle
                label="Push notifications on this browser"
                description="You'll get a push when a note finishes generating, plus the daily review reminder."
                checked={subscribed}
                onChange={(next) => void togglePush(next)}
              />
              {busy === "push" ? <p className="prefs-note">Updating this browser…</p> : null}
              {blocked ? (
                <Alert tone="warning" title="Notifications are blocked">
                  Sua cannot ask again. Allow notifications for this site in your browser settings,
                  then switch this back on.
                </Alert>
              ) : null}
              {browser.ios && !browser.installed ? (
                <Alert tone="info" title="Add Sua to your Home Screen">
                  On iPhone and iPad, web push only reaches an installed app. Tap Share, then “Add
                  to Home Screen”, and turn notifications on from there.
                </Alert>
              ) : null}
              {subscribed ? (
                <div className="prefs-data-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Send size={15} />}
                    busy={busy === "test"}
                    onClick={() => void sendTest()}
                  >
                    Send test notification
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </Card>

        <Card className="prefs-card prefs-card-wide">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Clock3 size={18} />
            </span>
            <div>
              <h2>Daily review reminder</h2>
              <p>A nudge when flashcards are due, sent once a day.</p>
            </div>
            {remindersOn ? <Chip tone="success">On</Chip> : <Chip tone="muted">Off</Chip>}
          </div>

          <Toggle
            label="Remind me about due cards"
            description="One push a day on this browser. The phone app schedules its own reminder locally."
            checked={remindersOn}
            onChange={(next) => void saveReminders({ remindersEnabled: next })}
          />

          <div className="prefs-notif-time">
            <Field
              label="Target time"
              htmlFor="reminder-time"
              hint="Sua checks for due cards once a day, so the nudge can arrive before this hour."
            >
              <input
                id="reminder-time"
                type="time"
                className="input"
                value={time}
                disabled={!remindersOn || busy === "reminders"}
                onChange={(event) => setTime(event.target.value)}
                onBlur={() => {
                  if (remindersOn && time !== reminders?.reminderTime) {
                    void saveReminders({ reminderTime: time });
                  }
                }}
              />
            </Field>
            <div className="prefs-row">
              <span className="prefs-row-label">
                <Monitor size={15} /> Time zone
              </span>
              <span className="prefs-row-value">
                {reminders?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
              </span>
            </div>
          </div>

          <p className="prefs-note">
            Reminders stop automatically when nothing is due — no empty “nothing to review”
            messages.
          </p>
        </Card>

        <Card className="prefs-card prefs-card-wide">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Smartphone size={18} />
            </span>
            <div>
              <h2>On your phone</h2>
              <p>The Android app has its own switches, stored on the device.</p>
            </div>
          </div>
          <p className="prefs-note">
            Turn notifications on inside the app under Profile → Notifications. The phone keeps
            working offline, so its daily reminder is scheduled on the device rather than sent from
            here.
          </p>
          <div className="prefs-data-actions">
            <Link href="/download" className="btn btn-secondary btn-sm">
              Get the Android app
            </Link>
          </div>
        </Card>

        <Card className="prefs-card prefs-card-wide prefs-data">
          <div>
            <h2>
              <ShieldAlert size={15} /> What Sua sends
            </h2>
            <p>
              Only two kinds of message: your study set is ready, and cards are due. No marketing,
              and nothing about other students.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
