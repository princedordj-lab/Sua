import { Redirect, Stack, usePathname } from "expo-router";
import { useApp } from "../../state/AppContext";
import { Pressable, Text, View } from "react-native";
import { Logo } from "../../components/ui";
import { ChatFab } from "../../components/chat-fab";

const TAB_ROUTES = ["/home", "/courses", "/create", "/study", "/profile"];


export default function AppLayout() {
  const { isLoaded, isHydrating, isSignedIn, hydrationIssue, retryHydration } = useApp();
  const pathname = usePathname();
  if (!isLoaded || isHydrating) {
    return (
      <View className="flex-1 items-center justify-center bg-cream">
        <Logo />
      </View>
    );
  }
  if (!isSignedIn) return <Redirect href="/welcome" />;
  const isChat = pathname === "/ask-sua";
  const bottom = TAB_ROUTES.includes(pathname) ? 112 : 28;
  return (
    <View className="flex-1">
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
      {!isChat ? <ChatFab bottom={bottom} /> : null}
    </View>
  );
}
