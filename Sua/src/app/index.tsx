import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Logo } from "../components/ui";
import { useApp } from "../state/AppContext";

export default function Index() {
  const { isLoaded, isHydrating, isSignedIn } = useApp();
  useEffect(() => {
    if (!isLoaded || isHydrating) return;
    if (isSignedIn) router.replace("/home");
    else router.replace("/welcome");
  }, [isHydrating, isLoaded, isSignedIn]);
  return (
    <View className="flex-1 items-center justify-center bg-cream">
      <Logo />
    </View>
  );
}
