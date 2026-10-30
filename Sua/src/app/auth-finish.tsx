import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { useAuth } from "@clerk/expo";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { Logo, PrimaryButton } from "../components/ui";
import { useApp } from "../state/AppContext";
import {
  readOnboardedCache,
  writeOnboardedCache,
} from "../lib/onboarding-cache";
import { usePalette } from "../state/appearance";

// Every completed authentication lands here. The destination comes from the
// server profile (or a per-user cache for offline returning users), never from
// the SSO result: Clerk always hands back a signUp resource object, so its
// truthiness says nothing about whether the account is new.
export default function AuthFinish() {
  const pv = usePalette();
  // Clerk is the source for the account id; the *routing* verdict comes from
  // AppContext, which waits out a transient signed-out frame before acting.
  const { userId } = useAuth();
  const {
    authVerdict,
    isHydrating,
    isProfileResolved,
    hasCompletedOnboarding,
    hydrationError,
    retryHydration,
    signOut,
  } = useApp();
  const db = useSQLiteContext();

  const [cache, setCache] = useState<{
    userId: string;
    value: boolean | null;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const routed = useRef(false);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    routed.current = false;
    if (!userId) return;
    let cancelled = false;
    void readOnboardedCache(db, userId).then((value) => {
      if (cancelled) return;
      setCache({ userId, value });
    });
    return () => {
      cancelled = true;
    };
  }, [db, userId]);

  const cacheLoaded = !userId || cache?.userId === userId;
  const cachedOnboarded = cacheLoaded ? (cache?.value ?? null) : null;

  useEffect(
    () => () => {
      if (checkTimer.current) clearTimeout(checkTimer.current);
    },
    [],
  );

  useEffect(() => {
    // The verdict already waited for a stable reading; no local debounce here.
    if (authVerdict === "loading") return;
    if (authVerdict === "signed-out") {
      router.replace("/welcome");
      return;
    }
    if (!userId || !cacheLoaded) return;
    if (routed.current) return;

    // A returning user can start offline; the cache only ever shortens the
    // wait, it never sends anyone to onboarding.
    if (cachedOnboarded === true) {
      routed.current = true;
      router.replace("/home");
      return;
    }
    // No verdict yet. AppContext bounds this wait, then the connect screen
    // below takes over instead of guessing.
    if (isHydrating) return;

    if (!isProfileResolved) return;

    routed.current = true;
    void writeOnboardedCache(db, userId, hasCompletedOnboarding);
    router.replace(hasCompletedOnboarding ? "/home" : "/setup");
  }, [
    authVerdict,
    cacheLoaded,
    cachedOnboarded,
    db,
    hasCompletedOnboarding,
    isHydrating,
    isProfileResolved,
    userId,
  ]);

  const retry = useCallback(() => {
    if (checking) return;
    setChecking(true);
    retryHydration();
    if (checkTimer.current) clearTimeout(checkTimer.current);
    // AppContext has no second "gave up" signal once it is in fallback, so the
    // screen comes back on its own if the retry does not resolve.
    checkTimer.current = setTimeout(() => {
      checkTimer.current = null;
      setChecking(false);
    }, 12_000);
  }, [checking, retryHydration]);

  const leave = useCallback(() => {
    void signOut()
      .catch(() => {})
      .finally(() => router.replace("/welcome"));
  }, [signOut]);

  const unresolved =
    authVerdict === "signed-in" &&
    Boolean(userId) &&
    cacheLoaded &&
    cachedOnboarded !== true &&
    !isHydrating &&
    !isProfileResolved;

  return (
    <SafeAreaView className="flex-1 bg-cream" style={{ flex: 1 }}>
      <View className="flex-1 items-center justify-center gap-6 px-6">
        <Logo />
        {unresolved && !checking ? (
          <View className="w-full items-center gap-3">
            <Text className="text-center text-[26px] font-black text-ink">
              Connect to finish signing in
            </Text>
            <Text className="text-center text-base leading-6 text-ink-soft">
              Sua needs a connection once to check your account on this device.
            </Text>
            {hydrationError ? (
              <Text className="text-center text-sm text-ink-faint">
                {hydrationError}
              </Text>
            ) : null}
            <View className="mt-2 w-full gap-2">
              <PrimaryButton onPress={retry}>Try again</PrimaryButton>
              <Pressable
                onPress={leave}
                className="min-h-12 items-center justify-center"
              >
                <Text className="font-bold text-brand">Sign out</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View className="items-center gap-3">
            <ActivityIndicator color={pv.brand.DEFAULT} />
            <Text className="font-semibold text-ink-soft">
              Finishing sign in...
            </Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}
