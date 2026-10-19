import { Redirect, Stack, usePathname } from "expo-router";
import { useApp } from "../../state/AppContext";
import { View } from "react-native";
import { Logo } from "../../components/ui";
import { ChatFab } from "../../components/chat-fab";

const TAB_ROUTES = ["/home", "/courses", "/create", "/study", "/profile"];


export default function AppLayout() {
  const { isLoaded, isHydrating, isSignedIn } = useApp();
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
      <Stack screenOptions={{ headerShown: false }} />
      {!isChat ? <ChatFab bottom={bottom} /> : null}
    </View>
  );
}
