import { useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import { router, type Href } from "expo-router";
import { useApp } from "../state/AppContext";

/**
 * Routes a tapped push to the screen it belongs to.
 *
 * The server sends `data.path` (e.g. "/note/<id>"). Handles both the cold-start
 * response and taps while the app is running, and ignores a response that has
 * already been handled so a re-render cannot push the same screen twice.
 *
 * Waits for the session: a signed-out tap is left alone (the auth gate already
 * routes to sign-in).
 */
export function NotificationObserver() {
  const { isLoaded, isSignedIn } = useApp();
  const handled = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    let cancelled = false;

    const redirect = (notification: Notifications.Notification) => {
      const id = notification.request.identifier;
      if (handled.current.has(id)) return;
      const path = notification.request.content.data?.path;
      if (typeof path !== "string" || !path.startsWith("/")) return;
      handled.current.add(id);
      router.push(path as Href);
    };

    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!cancelled && response?.notification) redirect(response.notification);
      })
      .catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      redirect(response.notification);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isLoaded, isSignedIn]);

  return null;
}
