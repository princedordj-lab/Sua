import { useEffect } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";
import { usePalette } from "../state/appearance";

WebBrowser.maybeCompleteAuthSession();

export default function OAuthCallback() {
  const pv = usePalette();
  const { isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      // Cold-start deep links land here too; the resolver reads the account
      // verdict instead of trusting anything remembered from this process.
      router.replace("/auth-finish");
      return;
    }

    // The callback route can render before the originating sign-in screen has
    // consumed the OAuth result and activated its Clerk session.
    const timeout = setTimeout(() => {
      Alert.alert(
        "Google sign-in timed out",
        "Clerk did not activate the session. Try again. If it repeats, check that sua://oauth-callback is allowlisted for this app.",
      );
      router.replace("/sign-in");
    }, 20_000);

    return () => clearTimeout(timeout);
  }, [isLoaded, isSignedIn]);

  return (
    <View className="flex-1 items-center justify-center gap-3 bg-cream">
      <ActivityIndicator color={pv.brand.DEFAULT} />
      <Text className="font-semibold text-ink-soft">Finishing sign in...</Text>
    </View>
  );
}
