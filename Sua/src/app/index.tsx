import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Logo } from "../components/ui";
import { useApp } from "../state/AppContext";

export default function Index() {
  const { isLoaded, isSignedIn } = useApp();
  useEffect(() => {
    // The resolver decides between Home, setup and the connect screen; it can
    // read the per-user cache without waiting for the network.
    if (!isLoaded) return;
    router.replace(isSignedIn ? "/auth-finish" : "/welcome");
  }, [isLoaded, isSignedIn]);
  return (
    <View className="flex-1 items-center justify-center bg-cream">
      <Logo />
    </View>
  );
}
