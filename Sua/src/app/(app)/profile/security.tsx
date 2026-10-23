import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  ArrowLeft,
  KeyRound,
  LogOut,
  ShieldCheck,
} from "lucide-react-native";
import { router } from "expo-router";
import { useApp } from "../../../state/AppContext";
import { SettingsRow } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";

// Clerk owns passwords and session devices; the portal URL is configured per
// instance. Without it the row stays out of the way instead of 404-ing.
const clerkPortalUrl = process.env.EXPO_PUBLIC_CLERK_ACCOUNT_PORTAL_URL;

export default function SecuritySettings() {
  const pv = usePalette();
  const { profile, signOut } = useApp();

  const leave = () =>
    Alert.alert("Sign out?", "You can sign back in anytime.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void signOut().finally(() => router.replace("/welcome"));
        },
      },
    ]);

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-row items-center gap-2 px-4 py-2">
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
        >
          <ArrowLeft size={20} color={pv.ink.DEFAULT} />
        </Pressable>
        <Text className="flex-1 text-body-lg font-sans-extrabold text-ink">
          Security
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-8">
        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SettingsRow
            Icon={KeyRound}
            title="Password & active sessions"
            subtitle={
              clerkPortalUrl
                ? "Managed by Clerk in the account portal."
                : "Currently unavailable in the app."
            }
            nextValue={clerkPortalUrl ? undefined : "—"}
            onPress={() => {
              if (clerkPortalUrl) {
                void Linking.openURL(clerkPortalUrl).catch(() =>
                  Alert.alert("Link failed", "Open this in a browser later."),
                );
              } else {
                Alert.alert(
                  "Clerk Account Portal",
                  "Set EXPO_PUBLIC_CLERK_ACCOUNT_PORTAL_URL in your app env to enable this.",
                );
              }
            }}
          />
        </View>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SettingsRow Icon={LogOut} title="Sign out" onPress={leave} danger />
        </View>

        <View className="mt-4 rounded-card bg-surface p-card shadow-card">
          <View className="flex-row items-center gap-2">
            <ShieldCheck size={19} color={colors.success} />
            <Text className="text-body font-sans-bold text-ink">
              Encrypted and access-controlled
            </Text>
          </View>
          <Text className="mt-1 text-small leading-5 text-ink-soft">
            Traffic is encrypted in transit, API access is authenticated per
            student, and your notes, recordings and study sets are visible only
            to your account. {profile?.email ? `Signed in as ${profile.email}.` : ""}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
