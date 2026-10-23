import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { router } from "expo-router";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useSignIn, useSignUp, useSSO } from "@clerk/expo";
import { Apple } from "lucide-react-native";
import { Image } from "expo-image";
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
  const [verificationSubmitted, setVerificationSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const finalizingVerification = useRef(false);

  const switchMode = (next: "sign-in" | "sign-up") => {
    setMode(next);
    setPendingVerification(false);
    setVerificationSubmitted(false);
    setCode("");
  };

  const navigateAfterAuth = useCallback((params?: {
    session?: { currentTask?: unknown } | null;
    decorateUrl?: (url: string) => string;
  }) => {
    if (params?.session?.currentTask) {
      // Do not treat an active Clerk task as a completed authentication.
      // Return the user to the auth flow where the task can be addressed.
      router.replace("/sign-in");
      Alert.alert(
        "Additional verification required",
        "Your account needs another verification step before Sua can continue. Complete the step with your identity provider, then sign in again.",
      );
      return;
    }
    if (mode === "sign-in") {
      router.replace("/home");
    } else {
      router.replace("/setup");
    }
  }, [mode]);

  const finalizeVerifiedSignUp = useCallback(async () => {
    if (signUp.status === "missing_requirements") {
      const missingFields = signUp.missingFields ?? [];
      const needsName = missingFields.some((field) =>
        ["first_name", "last_name"].includes(field),
      );

      if (needsName) {
        const [firstName, ...rest] = fullName.trim().split(/\s+/);
        const { error } = await signUp.update({
          firstName: firstName || undefined,
          lastName: rest.length ? rest.join(" ") : undefined,
        });
        if (error) throw error;
      }
    }

    if (signUp.status !== "complete") {
      const missing = signUp.missingFields?.join(", ") || "additional account details";
      throw new Error(`Complete these requirements before continuing: ${missing}.`);
    }

    const { error } = await signUp.finalize({
      navigate: navigateAfterAuth,
    });
    if (error) throw error;
  }, [fullName, navigateAfterAuth, signUp]);

  const submitEmailPassword = async () => {
    if (!email || !password)
      return Alert.alert(
        "Almost there",
        "Enter your email and password to continue.",
      );
    if (mode === "sign-up" && !fullName.trim()) {
      return Alert.alert("Almost there", "Enter your full name to continue.");
    }
    if (mode === "sign-in") {
      setBusy(true);
      try {
        const { error } = await signIn.password({
          emailAddress: email.trim(),
          password,
        });
        if (error) throw error;
        if (signIn.status === "complete") {
          const { error: finalizeError } = await signIn.finalize({
            navigate: () => router.replace("/home"),
          });
          if (finalizeError) throw finalizeError;
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
        const { error: finalizeError } = await signUp.finalize({
          navigate: navigateAfterAuth,
        });
        if (finalizeError) throw finalizeError;
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
      // Clerk can publish the updated status on the next render. Finalize in
      // the effect below so we read the fresh status instead of a stale hook
      // snapshot from this callback.
      setVerificationSubmitted(true);
    } catch (error) {
      Alert.alert("Verification failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!verificationSubmitted || busy) return;
    if (finalizingVerification.current) return;
    if (signUp.status !== "complete" && signUp.status !== "missing_requirements") {
      return;
    }

    finalizingVerification.current = true;
    void finalizeVerifiedSignUp()
      .catch((error: unknown) => {
        Alert.alert("Verification failed", messageFromError(error));
      })
      .finally(() => {
        finalizingVerification.current = false;
        setVerificationSubmitted(false);
      });
  }, [busy, finalizeVerifiedSignUp, signUp.status, verificationSubmitted]);

  const continueWithGoogle = async () => {
    const authMode = mode;
    setBusy(true);
    try {
      const result = await startSSOFlow({
        strategy: "oauth_google",
        redirectUrl: AuthSession.makeRedirectUri({
          scheme: "sua",
          path: "oauth-callback",
          queryParams: { flow: authMode },
        }),
      });
      const { createdSessionId, setActive } = result;
      if (createdSessionId && setActive) {
        // Clerk can complete OAuth by creating an account even when the user
        // started from the sign-in tab. Prefer the actual returned flow when
        // it is available, then fall back to the selected tab.
        const destination =
          result.signUp || authMode === "sign-up" ? "/setup" : "/home";
        await setActive({
          session: createdSessionId,
          navigate: (params) => {
            if (params?.session?.currentTask) {
              router.replace("/sign-in");
              Alert.alert(
                "Additional verification required",
                "Your account needs another verification step before Sua can continue. Complete the step with your identity provider, then sign in again.",
              );
              return;
            }
            router.replace(destination);
          },
        });
      } else {
        const missing = result.signUp?.missingFields?.join(", ");
        if (result.signUp?.status === "missing_requirements") {
          setMode("sign-up");
        }
        throw new Error(
          missing
            ? `Google authentication needs these additional account details: ${missing}. Return to the form and complete them, or try Google again.`
            : "Google authentication needs an additional verification step before a session can start. Return to email sign-in or try Google again.",
        );
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
                <Text className="font-bold text-brand">
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
                    <Text className="font-semibold text-brand">
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
                    className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-full border border-[#E9E5F2] bg-white "
                  >
                  <Image source={require("@/assets/images/google.svg")} style={{ width: 20, height: 20 }} />
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
                  <Text className="font-bold text-brand">
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
