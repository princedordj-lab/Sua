import { useEffect } from "react";
import { ImageBackground, Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowRight, Sparkles } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Logo, PrimaryButton } from "../components/ui";
import { useApp } from "../state/AppContext";

export default function Welcome() {
  const { authVerdict, isSigningOut } = useApp();
  const { reason } = useLocalSearchParams<{ reason?: string }>();
  // Only claim the session expired when it really did: a signed-out verdict
  // plus the flag the app layout passes. An explicit sign-out never sets it.
  const sessionExpired = reason === "expired" && authVerdict === "signed-out";

  useEffect(() => {
    // Self-heal. Landing here while signed in means a transient signed-out
    // frame routed the student out, so send them back to the resolver once the
    // session has held for a moment. `isSigningOut` keeps an explicit sign-out
    // from bouncing straight back into the app.
    if (authVerdict !== "signed-in" || isSigningOut) return;
    const timeout = setTimeout(() => router.replace("/auth-finish"), 800);
    return () => clearTimeout(timeout);
  }, [authVerdict, isSigningOut]);

  return (
    <SafeAreaView className="flex-1 bg-[#19152C]" style={{ flex: 1 }}>
      <ImageBackground
        source={require("../../assets/images/screens/welcome2.png")}
        className="flex-1"
        resizeMode="cover"
      >
        <View className="absolute inset-0 bg-[#19152C]/65" />
        <View className="flex-1 px-6 pt-5">
          <Logo light />
          <View className="flex-1 justify-center">
            <View className="mb-3 flex-row items-center gap-2">
              <Sparkles size={18} color="#FFBE1A" />
              <Text className="font-bold text-[#FFBE1A]">
                Study smarter, every day
              </Text>
            </View>
            <Text className="text-[40px] font-black leading-[46px] text-white">
              Your notes.{"\n"}Your edge.
            </Text>
            <Text className="mt-4 text-base leading-6 text-white/85">
              Sua turns lectures into clear study plans, flashcards, and quizzes
              that keep you ready for exam day.
            </Text>
            {sessionExpired ? (
              <View className="mt-5 rounded-2xl bg-white/10 px-4 py-3">
                <Text className="text-sm font-semibold leading-5 text-white">
                  Your session ended. Sign in again to pick up where you left
                  off.
                </Text>
              </View>
            ) : null}
          </View>
          <View className="gap-3 pb-4">
            <PrimaryButton onPress={() => router.push("/onboarding")}>
              Get started <ArrowRight size={16} color="#FFBE1A" />
            </PrimaryButton>
            <Pressable
              onPress={() => router.push("/sign-in")}
              className="items-center py-3"
            >
              <Text className="font-bold text-white">
                I already have an account
              </Text>
            </Pressable>
          </View>
        </View>
      </ImageBackground>
    </SafeAreaView>
  );
}
