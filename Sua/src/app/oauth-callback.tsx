import { useEffect } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";

WebBrowser.maybeCompleteAuthSession();

export default function OAuthCallback() {
  const { isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      router.replace("/");
      return;
    }

    // A successful OAuth return should activate a Clerk session quickly. If
    // it does not, the redirect is usually missing from Clerk's native SSO
    // allowlist; do not leave the user on an infinite loading screen.
    const timeout = setTimeout(() => {
      Alert.alert(
        "Google sign-in could not finish",
        "Add sua://oauth-callback to Clerk's mobile SSO redirect allowlist, then try again.",
      );
      router.replace("/sign-in");
    }, 8000);

    return () => clearTimeout(timeout);
  }, [isLoaded, isSignedIn]);

  return (
    <View className="flex-1 items-center justify-center gap-3 bg-cream">
      <ActivityIndicator color="#7C5CFC" />
      <Text className="font-semibold text-[#6E687D]">Finishing sign in...</Text>
    </View>
  );
}
