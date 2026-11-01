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
import { useSignIn, useSignUp } from "@clerk/expo";
// Core 3 SSO: activates the finished session itself and returns the future
// sign-in/sign-up resources, so it matches the signal resources used below for
// email/password. The root `useSSO` export is the Core 2 helper (it drives
// `@clerk/react/legacy` and needs a manual `setActive`).
import { useSSO } from "@clerk/expo/experimental";
import { Apple } from "lucide-react-native";
import { Image } from "expo-image";
import { Field, Logo, PrimaryButton } from "../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePalette } from "../state/appearance";
import { useApp } from "../state/AppContext";

WebBrowser.maybeCompleteAuthSession();

function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong. Please try again.";
}

type SignInChallenge = "email_code" | "phone_code" | "totp" | "backup_code";

// Forgot-password steps: ask for the identifier, verify the emailed code, then
// collect the replacement password (Clerk signs the student in on success).
type ResetStep = "email" | "code" | "password";

export default function SignIn() {
  const pv = usePalette();
  const { signIn } = useSignIn();
  const { signUp } = useSignUp();
  const { startSSOFlow } = useSSO();
  const { authVerdict, isSigningOut } = useApp();

  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [code, setCode] = useState("");
  const [pendingVerification, setPendingVerification] = useState(false);
  const [verificationSubmitted, setVerificationSubmitted] = useState(false);
  const [signInChallenge, setSignInChallenge] = useState<SignInChallenge | null>(null);
  const [resetStep, setResetStep] = useState<ResetStep | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const finalizingVerification = useRef(false);

  useEffect(() => {
    // The session can be restored or finish activating after this screen
    // mounted. A signed-in student should never be left staring at the form,
    // and the guard respects an explicit sign-out in progress.
    if (authVerdict !== "signed-in" || isSigningOut) return;
    const timeout = setTimeout(() => router.replace("/auth-finish"), 800);
    return () => clearTimeout(timeout);
  }, [authVerdict, isSigningOut]);

  /**
   * Drop any half-finished Clerk attempt. A stale attempt would otherwise leak
   * its status into the next one (e.g. a reset left in `needs_new_password`
   * making the next password sign-in fail for no visible reason).
   */
  const resetAttempts = async () => {
    finalizingVerification.current = false;
    await signIn.reset().catch(() => {});
    await signUp.reset().catch(() => {});
  };

  const clearVerification = () => {
    setPendingVerification(false);
    setSignInChallenge(null);
    setVerificationSubmitted(false);
    setCode("");
  };

  const clearReset = () => {
    setResetStep(null);
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
  };

  const switchMode = async (next: "sign-in" | "sign-up") => {
    if (busy) return;
    setMode(next);
    clearVerification();
    clearReset();
    await resetAttempts();
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
    // Sign-in and sign-up both resolve server-side: only the account's
    // onboarding verdict decides between Home and setup.
    router.replace("/auth-finish");
  }, []);

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

  const beginSignInChallenge = async () => {
    const strategies = signIn.supportedSecondFactors ?? [];
    const strategy = (["email_code", "phone_code", "totp", "backup_code"] as const)
      .find((candidate) => strategies.some((factor) => factor.strategy === candidate));

    if (!strategy) {
      const available = strategies.map((factor) => factor.strategy).join(", ");
      throw new Error(
        `Clerk requires another sign-in step${available ? ` (${available})` : ""}, but Sua does not support that verification method yet.`,
      );
    }

    if (strategy === "email_code") {
      const { error } = await signIn.mfa.sendEmailCode();
      if (error) throw error;
    } else if (strategy === "phone_code") {
      const { error } = await signIn.mfa.sendPhoneCode();
      if (error) throw error;
    }
    setCode("");
    setSignInChallenge(strategy);
  };

  const completeSignIn = async () => {
    const { error } = await signIn.finalize({
      navigate: navigateAfterAuth,
    });
    if (error) throw error;
  };

  const submitEmailPassword = async () => {
    if (busy) return;
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
          await completeSignIn();
        } else if (signIn.status === "needs_new_password") {
          // Clerk rejected the password (e.g. it was flagged as compromised) or
          // the account must set a new one. The reset attempt is already in the
          // right state, so go straight to collecting the replacement.
          setNewPassword("");
          setConfirmPassword("");
          setResetStep("password");
          Alert.alert(
            "New password needed",
            "Clerk requires a new password for this account before signing in.",
          );
        } else if (
          signIn.status === "needs_second_factor" ||
          signIn.status === "needs_client_trust"
        ) {
          await beginSignInChallenge();
        } else {
          Alert.alert(
            "Sign in incomplete",
            `Clerk returned status: ${signIn.status ?? "unknown"}.`,
          );
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
    if (busy || !code) return;
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

  const submitSignInChallenge = async () => {
    if (busy || !code || !signInChallenge) return;
    setBusy(true);
    try {
      let error: unknown = null;
      if (signInChallenge === "email_code") {
        ({ error } = await signIn.mfa.verifyEmailCode({ code }));
      } else if (signInChallenge === "phone_code") {
        ({ error } = await signIn.mfa.verifyPhoneCode({ code }));
      } else if (signInChallenge === "totp") {
        ({ error } = await signIn.mfa.verifyTOTP({ code }));
      } else {
        ({ error } = await signIn.mfa.verifyBackupCode({ code }));
      }
      if (error) throw error;
      if (signIn.status === "complete") {
        await completeSignIn();
        return;
      }
      throw new Error(
        `Verification succeeded, but Clerk still reports ${signIn.status ?? "an incomplete sign-in"}.`,
      );
    } catch (error) {
      Alert.alert("Verification failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  /** Resend the sign-up verification code. */
  const resendVerificationCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await signUp.verifications.sendEmailCode();
      if (error) throw error;
      setCode("");
      Alert.alert("Code sent", `We sent a new code to ${email.trim()}.`);
    } catch (error) {
      Alert.alert("Could not resend the code", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  /** Resend the second-factor code (email/phone challenges only). */
  const resendSignInChallenge = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await beginSignInChallenge();
      Alert.alert(
        "Code sent",
        signInChallenge === "phone_code"
          ? "We sent a new code to your phone."
          : `We sent a new code to ${email.trim()}.`,
      );
    } catch (error) {
      Alert.alert("Could not resend the code", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Forgot password, step 1: create a sign-in attempt for the identifier and
   * ask Clerk to email a reset code. `sendCode()` always targets the first email
   * address on the account, so the identifier has to be attached first.
   */
  const beginPasswordReset = async () => {
    if (busy) return;
    if (!email.trim()) {
      return Alert.alert(
        "Enter your email",
        "We need the email you signed up with to send a reset code.",
      );
    }
    setBusy(true);
    try {
      // Start from a clean attempt: a half-finished password sign-in would
      // otherwise carry its status into the reset.
      await signIn.reset().catch(() => {});
      const { error: createError } = await signIn.create({
        identifier: email.trim(),
      });
      if (createError) throw createError;
      const { error: sendError } = await signIn.resetPasswordEmailCode.sendCode();
      if (sendError) throw sendError;
      setCode("");
      setNewPassword("");
      setConfirmPassword("");
      setResetStep("code");
    } catch (error) {
      Alert.alert("Could not send a reset code", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const resendResetCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { error } = await signIn.resetPasswordEmailCode.sendCode();
      if (error) throw error;
      setCode("");
      Alert.alert("Code sent", `We sent a new code to ${email.trim()}.`);
    } catch (error) {
      Alert.alert("Could not resend the code", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  /** Forgot password, step 2: verify the emailed code. */
  const verifyResetCode = async () => {
    if (busy || !code) return;
    setBusy(true);
    try {
      const { error } = await signIn.resetPasswordEmailCode.verifyCode({ code });
      if (error) throw error;
      setNewPassword("");
      setConfirmPassword("");
      setResetStep("password");
    } catch (error) {
      Alert.alert("Verification failed", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Forgot password, step 3: save the new password. Clerk moves the attempt to
   * `complete` (it signs the student in), so the session finalizes like any
   * other successful sign-in. Other sessions are revoked because a reset is the
   * usual response to a compromised password.
   */
  const submitNewPassword = async () => {
    if (busy) return;
    if (newPassword.length < 8) {
      return Alert.alert(
        "Password too short",
        "Use at least 8 characters for your new password.",
      );
    }
    if (newPassword !== confirmPassword) {
      return Alert.alert(
        "Passwords do not match",
        "Re-enter the same password in both fields.",
      );
    }
    setBusy(true);
    try {
      const { error } = await signIn.resetPasswordEmailCode.submitPassword({
        password: newPassword,
        signOutOfOtherSessions: true,
      });
      if (error) throw error;
      setPassword("");
      setNewPassword("");
      setConfirmPassword("");
      if (signIn.status === "complete") {
        setResetStep(null);
        await completeSignIn();
      } else if (
        signIn.status === "needs_second_factor" ||
        signIn.status === "needs_client_trust"
      ) {
        setResetStep(null);
        await beginSignInChallenge();
      } else {
        // Leave a clean form rather than a half-finished attempt.
        clearReset();
        await signIn.reset().catch(() => {});
        Alert.alert(
          "Password not confirmed",
          `Your password may have been saved, but Clerk reports ${signIn.status ?? "an incomplete reset"}. Try signing in with the new password.`,
        );
      }
    } catch (error) {
      Alert.alert("Could not set the new password", messageFromError(error));
    } finally {
      setBusy(false);
    }
  };

  const leaveVerification = async () => {
    if (busy) return;
    clearVerification();
    await resetAttempts();
  };

  const exitReset = async () => {
    if (busy) return;
    clearReset();
    await signIn.reset().catch(() => {});
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
    if (busy) return;
    setBusy(true);
    try {
      const { createdSessionId, authSessionResult, signUp: ssoSignUp } =
        await startSSOFlow({
          strategy: "oauth_google",
          redirectUrl: AuthSession.makeRedirectUri({
            scheme: "sua",
            path: "oauth-callback",
          }),
        });
      // Closing the browser sheet is a decision, not a failure. Alerting here
      // would punish a student for backing out.
      if (
        authSessionResult?.type === "cancel" ||
        authSessionResult?.type === "dismiss"
      ) {
        return;
      }
      if (createdSessionId) {
        // The Core 3 helper finalized the session itself; the verdict effect
        // above routes to /auth-finish once Clerk publishes it.
        return;
      }
      const missing = ssoSignUp?.missingFields?.join(", ");
      throw new Error(
        missing
          ? `Google authentication needs these additional account details: ${missing}. Return to the form and complete them, or try Google again.`
          : "Google authentication needs an additional verification step before a session can start. Return to email sign-in or try Google again.",
      );
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

  // One heading/subheading pair for every state, so the screen cannot show a
  // stale "Welcome back." above a reset form.
  let heading: string;
  let subheading: string;
  if (resetStep === "email") {
    heading = "Reset your password.";
    subheading = "Enter the email you signed up with and we will send a reset code.";
  } else if (resetStep === "code") {
    heading = "Check your email.";
    subheading = `Enter the password reset code sent to ${email.trim()}.`;
  } else if (resetStep === "password") {
    heading = "Choose a new password.";
    subheading = "Use at least 8 characters. We will sign you in once it is saved.";
  } else if (pendingVerification) {
    heading = "Check your email.";
    subheading = `Enter the verification code sent to ${email.trim()}.`;
  } else if (signInChallenge) {
    heading = "Verify your sign-in.";
    subheading =
      signInChallenge === "email_code"
        ? `Enter the verification code sent to ${email.trim()}.`
        : signInChallenge === "phone_code"
          ? "Enter the verification code sent to your phone."
          : signInChallenge === "totp"
            ? "Enter the code from your authenticator app."
            : "Enter one of your backup codes.";
  } else if (mode === "sign-in") {
    heading = "Welcome back.";
    subheading = "Sign in to pick up where you left off.";
  } else {
    heading = "Create your account.";
    subheading = "Start turning lectures into exam-ready study sets.";
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" style={{ flex: 1 }}>
      <View className="flex-1 px-6 pt-5">
        <Logo />
        <View className="flex-1 justify-center gap-6">
          <View>
            <Text className="text-[34px] font-black text-ink">{heading}</Text>
            <Text className="mt-2 text-base text-ink-soft">{subheading}</Text>
          </View>

          {resetStep ? (
            <View className="gap-4">
              {resetStep === "email" ? (
                <>
                  <Field
                    label="Email address"
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@university.edu"
                    autoCapitalize="none"
                    autoComplete="email"
                    textContentType="emailAddress"
                    keyboardType="email-address"
                  />
                  <PrimaryButton onPress={beginPasswordReset}>
                    {busy ? "Sending..." : "Send reset code"}
                  </PrimaryButton>
                </>
              ) : resetStep === "code" ? (
                <>
                  <Field
                    label="Reset code"
                    value={code}
                    onChangeText={setCode}
                    placeholder="123456"
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    textContentType="oneTimeCode"
                  />
                  <PrimaryButton onPress={verifyResetCode}>
                    {busy ? "Verifying..." : "Verify code"}
                  </PrimaryButton>
                  <Pressable
                    onPress={resendResetCode}
                    disabled={busy}
                    className="items-center py-2"
                  >
                    <Text className="font-bold text-brand">Resend code</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  <Field
                    label="New password"
                    value={newPassword}
                    onChangeText={setNewPassword}
                    placeholder="••••••••"
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                  />
                  <Field
                    label="Confirm new password"
                    value={confirmPassword}
                    onChangeText={setConfirmPassword}
                    placeholder="••••••••"
                    secureTextEntry
                    autoComplete="new-password"
                    textContentType="newPassword"
                  />
                  <PrimaryButton onPress={submitNewPassword}>
                    {busy ? "Saving..." : "Set new password"}
                  </PrimaryButton>
                </>
              )}
              <Pressable
                onPress={exitReset}
                disabled={busy}
                className="items-center py-2"
              >
                <Text className="font-bold text-brand">Back to sign in</Text>
              </Pressable>
            </View>
          ) : pendingVerification || signInChallenge ? (
            <View className="gap-4">
              <Field
                label={signInChallenge === "backup_code" ? "Backup code" : "Verification code"}
                value={code}
                onChangeText={setCode}
                placeholder="123456"
                keyboardType={signInChallenge === "backup_code" ? "default" : "number-pad"}
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
              />
              <PrimaryButton
                onPress={pendingVerification ? submitVerificationCode : submitSignInChallenge}
              >
                {busy ? "Verifying..." : "Verify and continue"}
              </PrimaryButton>
              {(pendingVerification ||
                signInChallenge === "email_code" ||
                signInChallenge === "phone_code") && (
                <Pressable
                  onPress={pendingVerification ? resendVerificationCode : resendSignInChallenge}
                  disabled={busy}
                  className="items-center py-2"
                >
                  <Text className="font-bold text-brand">Resend code</Text>
                </Pressable>
              )}
              <Pressable
                onPress={leaveVerification}
                disabled={busy}
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
                    autoComplete="name"
                    textContentType="name"
                  />
                )}
                <Field
                  label="Email address"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@university.edu"
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoComplete="email"
                  textContentType="emailAddress"
                />
                <Field
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry
                  autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                  textContentType={mode === "sign-in" ? "password" : "newPassword"}
                />
                {mode === "sign-in" && (
                  <Pressable
                    onPress={() => {
                      if (busy) return;
                      setResetStep("email");
                    }}
                    disabled={busy}
                    className="items-end py-1"
                  >
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
                <View className="h-px flex-1 bg-line" />
                <Text className="text-ink-faint">or continue with</Text>
                <View className="h-px flex-1 bg-line" />
              </View>
              <View className="flex-row gap-3">
                <Pressable
                  onPress={continueWithGoogle}
                  disabled={busy}
                  className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-full border border-line bg-surface"
                >
                  <Image source={require("@/assets/images/google.svg")} style={{ width: 20, height: 20 }} />
                  <Text className="font-bold text-ink">Google</Text>
                </Pressable>
                {Platform.OS === "ios" && (
                  <Pressable
                    onPress={continueWithApple}
                    disabled={busy}
                    className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-line bg-surface"
                  >
                    <Apple size={18} color={pv.ink.DEFAULT} />
                    <Text className="font-bold text-ink">Apple</Text>
                  </Pressable>
                )}
              </View>
              <Pressable
                onPress={() =>
                  void switchMode(mode === "sign-in" ? "sign-up" : "sign-in")
                }
                disabled={busy}
                className="items-center py-2"
              >
                <Text className="text-ink-soft">
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
