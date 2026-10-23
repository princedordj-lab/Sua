import { useState } from "react";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Pressable, ScrollView, Text, View } from "react-native";
import { ArrowLeft } from "lucide-react-native";
import { router } from "expo-router";
import { useApp } from "../../../state/AppContext";
import { Field } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";

/**
 * Account details editor. Writes go straight to PATCH /api/me (fields arrive
 * server-side with this platform); a failure keeps the form mounted with a
 * retry banner instead of losing the typed values.
 */

type FieldKey = "name" | "university" | "programme" | "level";

export default function EditProfile() {
  const pv = usePalette();
  const { profile, updateProfile } = useApp();
  // Typed values overlay the hydrated profile: the form renders immediately
  // and never needs an effect to copy profile into local state.
  const [draft, setDraft] = useState<Partial<Record<FieldKey, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = (field: FieldKey) =>
    draft[field] ?? profile?.[field] ?? "";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProfile({
        name: value("name").trim(),
        university: value("university").trim(),
        programme: value("programme").trim(),
        level: value("level").trim(),
      });
      Keyboard.dismiss();
      router.back();
    } catch {
      setError("Couldn't save while offline. Try again when you're connected.");
    } finally {
      setSaving(false);
    }
  };

  const dirty = (["name", "university", "programme", "level"] as const).some(
    (field) => draft[field] !== undefined && value(field).trim() !== (profile?.[field] ?? ""),
  );

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <KeyboardAvoidingView behavior="padding" className="flex-1">
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
            Account details
          </Text>
        </View>

        <ScrollView contentContainerClassName="px-5 pb-8" keyboardShouldPersistTaps="handled">
          <View className="gap-5 rounded-card bg-surface p-card shadow-card">
            <Field
              label="Full name"
              value={value("name")}
              onChangeText={(next) => setDraft((prev) => ({ ...prev, name: next }))}
              placeholder="Ama Mensah"
              autoCapitalize="words"
            />
            <Field
              label="University"
              value={value("university")}
              onChangeText={(next) => setDraft((prev) => ({ ...prev, university: next }))}
              placeholder="University of Ghana"
            />
            <Field
              label="Programme"
              value={value("programme")}
              onChangeText={(next) => setDraft((prev) => ({ ...prev, programme: next }))}
              placeholder="BSc Computer Science"
            />
            <Field
              label="Year / Level"
              value={value("level")}
              onChangeText={(next) => setDraft((prev) => ({ ...prev, level: next }))}
              placeholder="Level 200"
            />
          </View>

          {error ? (
            <View className="mt-4 rounded-card border border-danger bg-danger-soft p-card">
              <Text className="text-small leading-5 text-danger">{error}</Text>
            </View>
          ) : null}

          <Pressable
            onPress={() => void save()}
            disabled={saving || !dirty}
            accessibilityRole="button"
            accessibilityLabel="Save account details"
            className={`mt-6 min-h-14 items-center justify-center rounded-btn px-5 active:opacity-80 ${
              saving || !dirty ? "bg-ink-faint/30" : "bg-brand"
            }`}
          >
            {saving ? (
              <ActivityIndicator color={colors.gold.DEFAULT} />
            ) : (
              <Text className="font-sans-bold text-base text-gold">
                Save changes
              </Text>
            )}
          </Pressable>
          <Text className="mt-3 text-center text-caption text-ink-faint">
            Email and sign-in settings live in Security.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
