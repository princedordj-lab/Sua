import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowLeft, ShieldAlert } from "lucide-react-native";
import { router } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { useApp } from "../../../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";
import { wipeLocalData } from "../../../lib/notes";

let deleting = false;

export default function DeleteAccount() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const { profile, deleteAccount, signOut } = useApp();
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);

  const perform = async () => {
    if (busy || deleting) return;
    deleting = true;
    setBusy(true);
    try {
      // Server wipe first: rows + storage objects + the Clerk account (which
      // revokes sessions). If it fails nothing local is touched, so the
      // device stays consistent with the Play Store promise of deletion.
      await deleteAccount();
      await wipeLocalData(db).catch(() => {});
      await signOut().catch(() => {});
      router.replace("/welcome");
    } catch {
      Alert.alert(
        "Couldn't delete the account",
        "The server is unreachable. Your data was not deleted — try again when you're back online.",
      );
      setBusy(false);
      deleting = false;
    }
  };

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
          Delete account
        </Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-8">
        <View className="mt-4 rounded-card border border-danger bg-danger-soft p-card">
          <View className="flex-row items-center gap-2">
            <ShieldAlert size={20} color={colors.danger} />
            <Text className="text-body-lg font-sans-extrabold text-danger">
              This is permanent
            </Text>
          </View>
          <Text className="mt-1 text-small leading-5 text-ink-soft">
            For {profile?.email || "your account"} this removes everything, on
            the server and this device:
          </Text>
          <View className="mt-2">
            {(
              [
                "Courses, notes and typed drafts",
                "Recordings, uploads and associated files",
                "Summaries, flashcards, quizzes and review history",
                "Ask Sua conversations",
              ] as const
            ).map((line) => (
              <View key={line} className="mt-1 flex-row items-start gap-2">
                <Text className="text-small text-danger">•</Text>
                <Text className="flex-1 text-small leading-5 text-ink-soft">
                  {line}
                </Text>
              </View>
            ))}
          </View>
        </View>

        <Text className="mt-5 text-small leading-5 text-ink-soft">
          You cannot undo this, and any queued uploads or generations are
          cancelled along with it. To confirm, type DELETE below.
        </Text>
        <TextInput
          value={phrase}
          onChangeText={setPhrase}
          placeholder="Type DELETE"
          placeholderTextColor={pv.ink.faint}
          autoCapitalize="characters"
          autoCorrect={false}
          accessibilityLabel="Type DELETE to confirm account deletion"
          className="mt-3 h-14 rounded-input border border-line bg-surface px-4 text-body text-ink"
        />

        <Pressable
          onPress={() => void perform()}
          disabled={busy || phrase.trim().toUpperCase() !== "DELETE"}
          accessibilityRole="button"
          accessibilityLabel="Delete my account permanently"
          className={`mt-6 min-h-14 items-center justify-center rounded-btn px-5 active:opacity-80 ${
            phrase.trim().toUpperCase() === "DELETE" && !busy
              ? "bg-danger"
              : "bg-danger-soft"
          }`}
        >
          {busy ? (
            <ActivityIndicator color={colors.danger} />
          ) : (
            <Text
              className={`text-base font-sans-bold ${
                phrase.trim().toUpperCase() === "DELETE" ? "text-white" : "text-danger"
              }`}
            >
              Delete my account permanently
            </Text>
          )}
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
