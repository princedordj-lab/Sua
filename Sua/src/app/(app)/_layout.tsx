import { useEffect } from "react";
import { router, Stack, usePathname } from "expo-router";
import { useApp } from "../../state/AppContext";
import { Pressable, Text, View } from "react-native";
import { Logo } from "../../components/ui";
import { ChatFab } from "../../components/chat-fab";

// The <Stack> must stay mounted. An early return that swaps it for a loading
// view or <Redirect> tears down every screen at once, and hooks such as
// useFocusEffect then throws "Couldn't find a navigation context" while the
// tree rebuilds (crashes when typing in Ask Sua or retrying a failed AI
// generation). Blocking states now draw over the navigator; sign-out exits
// with router.replace instead of an early-return <Redirect>.
export default function AppLayout() {
  const {
    authVerdict,
    isHydrating,
    isSignedOut,
    isSigningOut,
    hydrationIssue,
    retryHydration,
    isProfileResolved,
    hasCompletedOnboarding,
  } = useApp();
  const pathname = usePathname();
  // Only a stable verdict blocks the app: a signed-out frame during a token
  // refresh or native client sync must not unmount the screens.
  const blocked = isHydrating || authVerdict !== "signed-in";

  useEffect(() => {
    if (!isSignedOut) return;
    // Signing out on purpose already routes to Welcome; labelling that as an
    // expiry would tell the student their session ended when they ended it.
    router.replace(
      isSigningOut
        ? { pathname: "/welcome" }
        : { pathname: "/welcome", params: { reason: "expired" } },
    );
  }, [isSignedOut, isSigningOut]);

  useEffect(() => {
    if (authVerdict !== "signed-in") return;
    // A positive server verdict only: an unresolved or degraded profile
    // (offline, timeout, error) must never be mistaken for a new account.
    if (
      !isHydrating &&
      !hydrationIssue &&
      isProfileResolved &&
      !hasCompletedOnboarding
    ) {
      router.replace("/setup");
    }
  }, [
    authVerdict,
    hasCompletedOnboarding,
    hydrationIssue,
    isHydrating,
    isProfileResolved,
  ]);

  const isChat = pathname === "/ask-sua";
  return (
    <View className="flex-1 bg-cream">
      {hydrationIssue ? (
        <View className="flex-row items-center justify-between bg-surface px-4 py-2">
          <Text className="flex-1 text-xs text-ink-soft">
            Using saved data while Sua reconnects.
          </Text>
          <Pressable onPress={retryHydration} className="px-2 py-1">
            <Text className="text-xs font-bold text-brand">Retry</Text>
          </Pressable>
        </View>
      ) : null}
      <Stack screenOptions={{ headerShown: false }} />
      {!blocked && !isChat ? <ChatFab /> : null}
      {blocked ? (
        <View className="absolute inset-0 items-center justify-center bg-cream">
          <Logo />
        </View>
      ) : null}
    </View>
  );
}
