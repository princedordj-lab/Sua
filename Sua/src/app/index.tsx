import { useEffect } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Logo } from "../components/ui";
import { useApp } from "../state/AppContext";

export default function Index() {
  const { authVerdict } = useApp();
  useEffect(() => {
    // The verdict waits out a transient signed-out frame (see lib/auth-gate.ts)
    // before it counts, so a session that is still being restored cannot be
    // mistaken for a logout.
    if (authVerdict === "loading") return;
    // The resolver decides between Home, setup and the connect screen; it can
    // read the per-user cache without waiting for the network.
    router.replace(
      authVerdict === "signed-in" ? "/auth-finish" : "/welcome",
    );
  }, [authVerdict]);
  return (
    <View className="flex-1 items-center justify-center bg-cream">
      <Logo />
    </View>
  );
}
