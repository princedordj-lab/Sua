import { useEffect } from "react";
import { router, Stack, usePathname } from "expo-router";
import { useApp } from "../../state/AppContext";
import { Pressable, Text, View } from "react-native";
import { Logo } from "../../components/ui";
import { ChatFab } from "../../components/chat-fab";

const TAB_ROUTES = ["/home", "/courses", "/create", "/study", "/profile"];

// The <Stack> must stay mounted. An early return that swaps it for a loading
// view or <Redirect> tears down every screen at once, and hooks such as
// useFocusEffect then throws "Couldn't find a navigation context" while the
// tree rebuilds (crashes when typing in Ask Sua or retrying a failed AI
// generation). Blocking states now draw over the navigator; sign-out exits
// with router.replace instead of an early-return <Redirect>.
export default function AppLayout() {
  const { isLoaded, isHydrating, isSignedIn, hydrationIssue, retryHydration } = useApp();
  const pathname = usePathname();
  const blocked = !isLoaded || isHydrating || !isSignedIn;

  useEffect(() => {
    if (isLoaded && !isSignedIn) router.replace("/welcome");
  }, [isLoaded, isSignedIn]);

  const isChat = pathname === "/ask-sua";
  const bottom = TAB_ROUTES.includes(pathname) ? 112 : 28;
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
      {!blocked && !isChat ? <ChatFab bottom={bottom} /> : null}
      {blocked ? (
        <View className="absolute inset-0 items-center justify-center bg-cream">
          <Logo />
        </View>
      ) : null}
    </View>
  );
}
