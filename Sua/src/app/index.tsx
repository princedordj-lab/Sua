import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Logo } from "../components/ui";
import { useApp } from "../state/AppContext";

export default function Index() {
  const { isLoaded, isSignedIn } = useApp();
  useEffect(() => {
    // Routing depends on Clerk, not on the network-backed profile/course
    // hydration. The signed-in layout can show cached data while hydration
    // finishes in the background.
    if (!isLoaded) return;
    if (isSignedIn) router.replace("/home");
    else router.replace("/welcome");
  }, [isLoaded, isSignedIn]);
  return (
    <View className="flex-1 items-center justify-center bg-cream">
      <Logo />
    </View>
  );
}
