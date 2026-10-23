import { Pressable, ScrollView, Text, View } from "react-native";
import { ArrowLeft, Compass, SunMoon, Type, Hourglass } from "lucide-react-native";
import { router } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAppearance, type AppearancePref } from "../../../state/appearance";
import { useBooleanSetting, useStringSetting } from "../../../state/settings";
import { SwitchRow } from "../../../components/ui";
import { colors } from "../../../config/theme";
import { usePalette } from "../../../state/appearance";

const APPEARANCE_OPTIONS: { value: AppearancePref; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const LENGTH_OPTIONS = [
  { value: "10", label: "10 cards" },
  { value: "20", label: "20 cards" },
  { value: "30", label: "30 cards" },
];

const SCALE_OPTIONS = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

function SegSelect({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (next: string) => void;
  label: string;
}){
  return (
    <View
      className="flex-row gap-1 rounded-input border border-line bg-cream p-1"
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            accessibilityLabel={`${label}: ${option.label}`}
            className="min-h-9 flex-1 items-center justify-center rounded-chip px-2 active:opacity-80"
            style={selected ? { backgroundColor: colors.brand.DEFAULT } : undefined}
          >
            <Text
              className={`text-caption font-sans-bold ${
                selected ? "text-ink-inverse" : "text-ink-soft"
              }`}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function OptionBlock({
  Icon,
  title,
  subtitle,
  children,
}: {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  const pv = usePalette();
  return (
    <View>
      <View className="flex-row items-center gap-2 px-card py-2">
        <Icon size={19} color={colors.brand.DEFAULT} />
        <Text className="font-sans-bold text-body" style={{ color: pv.ink.DEFAULT }}>
          {title}
        </Text>
      </View>
      <View className="px-card pb-3">
        <Text className="text-small leading-5 text-ink-soft">{subtitle}</Text>
        <View className="mt-2">{children}</View>
      </View>
    </View>
  );
}

function PreferencesContent() {
  const db = useSQLiteContext();
  const { pref, setPref, loaded } = useAppearance();
  const sessionLength = useStringSetting(db, "review_session_length", "30");
  const textScale = useStringSetting(db, "note_text_scale", "medium");
  const rememberCourse = useBooleanSetting(db, "remember_capture_course");

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
          <ArrowLeft size={20} color={colors.ink.DEFAULT} />
        </Pressable>
        <Text className="flex-1 text-body-lg font-sans-extrabold text-ink">Preferences</Text>
      </View>

      <ScrollView contentContainerClassName="px-5 pb-8">
        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <OptionBlock
            Icon={SunMoon}
            title="Appearance"
            subtitle="Follow the device or pick a scheme. Sua's warm grid and ink swap to a charcoal at night — accents stay brand green."
          >
            <SegSelect
              label="Appearance"
              options={APPEARANCE_OPTIONS}
              value={loaded ? pref : "system"}
              onChange={(next) => void setPref(next as AppearancePref)}
            />
          </OptionBlock>
        </View>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <OptionBlock
            Icon={Hourglass}
            title="Review session length"
            subtitle="How many cards a review session covers, mixing what's due with a short look-ahead."
          >
            <SegSelect
              label="Review session length"
              options={LENGTH_OPTIONS}
              value={["10", "20", "30"].includes(sessionLength.value) ? sessionLength.value : "30"}
              onChange={(next) => void sessionLength.update(next)}
            />
          </OptionBlock>
          <OptionBlock
            Icon={Type}
            title="Note text size"
            subtitle="Reading size for note bodies, transcripts and summaries."
          >
            <SegSelect
              label="Note text size"
              options={SCALE_OPTIONS}
              value={["small", "medium", "large"].includes(textScale.value) ? textScale.value : "medium"}
              onChange={(next) => void textScale.update(next)}
            />
          </OptionBlock>
        </View>

        <View className="mt-4 gap-2 rounded-card bg-surface p-2 shadow-card">
          <SwitchRow
            Icon={Compass}
            title="Remember last capture course"
            subtitle="Start recording, typing and uploads in the course of your most recent capture. Off always starts with the course picker."
            value={rememberCourse.value}
            onChange={(next) => void rememberCourse.update(next)}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export default function Preferences() {
  return <PreferencesContent />;
}
