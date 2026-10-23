import { useEffect, useState } from "react";
import { Alert, Image, Pressable, ScrollView, Text, View } from "react-native";
import {
  Bell,
  ChevronRight,
  Database,
  LogOut,
  ShieldCheck,
  Sliders,
  Trash2,
  UserRound,
} from "lucide-react-native";
import { router } from "expo-router";
import { useUser } from "@clerk/expo";
import { useSQLiteContext } from "expo-sqlite";
import { useApp } from "../../../state/AppContext";
import { SettingsRow } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePalette } from "../../../state/appearance";
import { countAudioNotesThisMonth } from "../../../lib/notes";

const isPro = (plan?: string) => plan === "PRO";

export default function Profile() {
  const pv = usePalette();
  const { profile, signOut } = useApp();
  const { user } = useUser();
  const db = useSQLiteContext();
  const [monthlyRecordings, setMonthlyRecordings] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    countAudioNotesThisMonth(db)
      .then((count) => {
        if (!cancelled) setMonthlyRecordings(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [db]);

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

  const pro = isPro(profile?.plan);
  const avatar = user?.imageUrl;

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Text className="text-title font-black text-ink">Profile</Text>

        <Pressable
          onPress={() => router.push("/profile/edit")}
          className="mt-6 flex-row items-center rounded-card bg-surface p-card-lg shadow-card active:opacity-80"
          accessibilityRole="button"
          accessibilityLabel="Open account details"
        >
          {avatar ? (
            <Image
              source={{ uri: avatar }}
              className="h-16 w-16 rounded-full"
              accessibilityLabel="Profile photo"
            />
          ) : (
            <View className="h-16 w-16 items-center justify-center rounded-full bg-success-soft">
              <Text className="text-2xl font-black text-brand">
                {profile?.name?.charAt(0).toUpperCase() ?? "S"}
              </Text>
            </View>
          )}
          <View className="ml-4 flex-1">
            <Text className="text-body-lg font-extrabold text-ink">
              {profile?.name ?? "Sua student"}
            </Text>
            <Text className="mt-1 text-small text-ink-soft">
              {profile?.email ?? "student@sua.app"}
            </Text>
            <View
              className={`mt-2 self-start rounded-chip px-2.5 py-1 ${
                pro ? "bg-gold-soft" : "bg-success-soft"
              }`}
            >
              <Text
                className={`text-caption font-sans-extrabold ${
                  pro ? "text-warning" : "text-success"
                }`}
              >
                {pro ? "PRO" : "FREE PLAN"}
              </Text>
            </View>
          </View>
          <ChevronRight size={19} color={pv.ink.faint} />
        </Pressable>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SettingsRow
            Icon={UserRound}
            title="Account details"
            onPress={() => router.push("/profile/edit")}
          />
          <SettingsRow
            Icon={Bell}
            title="Notifications"
            onPress={() => router.push("/profile/notifications")}
          />
          <SettingsRow
            Icon={Sliders}
            title="Preferences"
            onPress={() => router.push("/profile/preferences")}
          />
          <SettingsRow
            Icon={Database}
            title="Data & AI"
            onPress={() => router.push("/profile/data")}
          />
          <SettingsRow
            Icon={ShieldCheck}
            title="Security"
            onPress={() => router.push("/profile/security")}
          />
        </View>

        <View className="mt-4 rounded-card bg-brand p-card-lg">
          <View className="flex-row items-center justify-between">
            <Text className="text-body-lg font-sans-extrabold text-ink-inverse">
              {pro ? "Sua Pro" : "Free plan"}
            </Text>
            {monthlyRecordings !== null ? (
              <Text className="text-small font-sans-bold text-gold">
                {monthlyRecordings} recordings this month
              </Text>
            ) : null}
          </View>
          <Text className="mt-1 text-small leading-5 text-white/85">
            {pro
              ? "All V1 features unlocked. Thanks for supporting Sua."
              : "Unlimited study sets, Exam Mode, and faster AI help. Pay with MTN MoMo, Telecel Cash or AirtelTigo Money — billing launches with V1."}
          </Text>
        </View>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SettingsRow Icon={LogOut} title="Sign out" onPress={leave} danger />
        </View>

        <View className="mt-3 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SettingsRow
            Icon={Trash2}
            title="Delete account & data"
            onPress={() => router.push("/profile/delete")}
            danger
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
