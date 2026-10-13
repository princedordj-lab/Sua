import { useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useSignIn, useSignUp, useSSO } from "@clerk/expo";
import { Apple, Globe2 } from "lucide-react-native";
import { Field, Logo, PrimaryButton } from "../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";

WebBrowser.maybeCompleteAuthSession();

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

export default function SignIn() {
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [busy, setBusy] = useState(false);

  const switchMode = (next: "sign-in" | "sign-up") => {
    setMode(next);
    setPendingVerification(false);
    setCode("");
  };

  const submitEmailPassword = async () => {
    if (!email || !password)
      return Alert.alert(
        "Almost there",
        "Enter your email and password to continue.",
      );
    if (mode === "sign-in") {
      setBusy(true);
      try {
        const { error } = await signIn.password({
          emailAddress: email.trim(),
          password,
        });
        if (error) throw error;
        if (signIn.status === "complete") {
          const { error: finalizeError } = await signIn.finalize();
          if (finalizeError) throw finalizeError;
          router.replace("/");
        } else {
          Alert.alert("Sign in incomplete", "Additional verification is required.");
        }
      } catch (error) {
        Alert.alert("Sign in failed", messageFromError(error));
      } finally {
        setBusy(false);
      }
      return;
    }

    setBusy(true);
    try {
      const [firstName, ...rest] = fullName.trim().split(/\s+/);
      const { error } = await signUp.password({
        emailAddress: email.trim(),
        password,
        firstName: firstName || undefined,
        lastName: rest.length ? rest.join(" ") : undefined,
      });
      if (error) throw error;
      if (signUp.status === "complete") {
        const { error: finalizeError } = await signUp.finalize();
        if (finalizeError) throw finalizeError;
        router.replace("/");
        return;
      }
      const { error: verificationError } =
        await signUp.verifications.sendEmailCode();
      if (verificationError) throw verificationError;
      setPendingVerification(true);
    } catch (error) {
      Alert.alert("Sign up failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const submitVerificationCode = async () => {
    if (!code) return;
    setBusy(true);
    try {
      const { error } = await signUp.verifications.verifyEmailCode({ code });
      if (error) throw error;
      if (signUp.status === "complete") {
        const { error: finalizeError } = await signUp.finalize();
        if (finalizeError) throw finalizeError;
        router.replace("/");
      } else {
        Alert.alert("Check the code", "That code did not verify. Try again.");
      }
    } catch (error) {
      Alert.alert("Verification failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const continueWithGoogle = async () => {
    setBusy(true);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: "oauth_google",
      });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        router.replace("/");
      }
    } catch (error) {
      Alert.alert("Google sign-in failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const continueWithApple = () => {
    Alert.alert(
      "Apple sign-in",
      "Apple sign-in is coming soon. Use email or Google for now.",
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-cream" style={{ flex: 1 }}>
      <View className="flex-1 px-6 pt-5">
        <Logo />
        <View className="flex-1 justify-center gap-6">
          <View>
            <Text className="text-[34px] font-black text-[#19152C]">
              {pendingVerification
                ? "Check your email."
                : mode === "sign-in"
                  ? "Welcome back."
                  : "Create your account."}
            </Text>
            <Text className="mt-2 text-base text-[#6E687D]">
              {pendingVerification
                ? `We sent a verification code to ${email}.`
                : mode === "sign-in"
                  ? "Sign in to pick up where you left off."
                  : "Start turning lectures into exam-ready study sets."}
            </Text>
          </View>

          {pendingVerification ? (
            <View className="gap-4">
              <Field
                label="Verification code"
                value={code}
                onChangeText={setCode}
                placeholder="123456"
                keyboardType="number-pad"
              />
              <PrimaryButton onPress={submitVerificationCode}>
                {busy ? "Verifying..." : "Verify email"}
              </PrimaryButton>
              <Pressable
                onPress={() => setPendingVerification(false)}
                className="items-center py-2"
              >
                <Text className="font-bold text-[#7C5CFC]">
                  Use a different email
                </Text>
              </Pressable>
            </View>
          ) : (
            <>
              <View className="gap-4">
                {mode === "sign-up" && (
                  <Field
                    label="Full name"
                    value={fullName}
                    onChangeText={setFullName}
                    placeholder="e.g. Ama Mensah"
                  />
                )}
                <Field
                  label="Email address"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@university.edu"
                  autoCapitalize="none"
                  keyboardType="email-address"
                />
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry
                />
                {mode === "sign-in" && (
                  <Pressable className="items-end">
                    <Text className="font-semibold text-[#7C5CFC]">
                      Forgot password?
                    </Text>
                  </Pressable>
                )}
              </View>
              <PrimaryButton onPress={submitEmailPassword}>
                {busy
                  ? "Please wait..."
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
              </PrimaryButton>
              <View className="flex-row items-center gap-3">
                <View className="h-px flex-1 bg-[#E7E2F0]" />
                <Text className="text-[#9992A8]">or continue with</Text>
                <View className="h-px flex-1 bg-[#E7E2F0]" />
              </View>
              <View className="flex-row gap-3">
                <Pressable
                  onPress={continueWithGoogle}
                  className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-[#E9E5F2] bg-white"
                >
                  <Globe2 size={18} color="#4285F4" />
                  <Text className="font-bold text-[#393442]">Google</Text>
                </Pressable>
                {Platform.OS === "ios" && (
                  <Pressable
                    onPress={continueWithApple}
                    className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-[#E9E5F2] bg-white"
                  >
                    <Apple size={18} color="#19152C" />
                    <Text className="font-bold text-[#393442]">Apple</Text>
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={() =>
                  switchMode(mode === "sign-in" ? "sign-up" : "sign-in")
                }
                className="items-center py-2"
              >
                <Text className="text-[#6E687D]">
                  {mode === "sign-in"
                    ? "New to Sua? "
                    : "Already have an account? "}
                  <Text className="font-bold text-[#7C5CFC]">
                    {mode === "sign-in" ? "Create account" : "Sign in"}
                  </Text>
                </Text>
              </Pressable>
            </>
          )}
        </View>
      </View>
    </SafeAreaView>
  );
}
