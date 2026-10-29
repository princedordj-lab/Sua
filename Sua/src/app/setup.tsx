import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { CalendarDays, ChevronRight } from "lucide-react-native";
import { Field, Logo, PrimaryButton } from "../components/ui";
import { useApp } from "../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePalette } from "../state/appearance";

const levels = [
  "Level 100",
  "Level 200",
  "Level 300",
  "Level 400",
  "Postgraduate",
];
export default function Setup() {
  const pv = usePalette();
  const { profile, completeOnboarding, hasCompletedOnboarding } = useApp();
  const [university, setUniversity] = useState("");
  const [programme, setProgramme] = useState("");
  const [level, setLevel] = useState("");
  const [course, setCourse] = useState("");
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  // Setup is only for accounts the server confirmed as new. If a stale link
  // or a cached verdict lands an onboarded student here, send them home.
  useEffect(() => {
    if (hasCompletedOnboarding) router.replace("/home");
  }, [hasCompletedOnboarding]);

  const finish = async (skip = false) => {
    if (saving) return;
    setSaving(true);
    try {
      await completeOnboarding(
        {
          name: profile?.name ?? "Student",
          email: profile?.email ?? "",
          university: skip ? "" : university,
          programme: skip ? "" : programme,
          level: skip ? "" : level,
        },
        {
          code: code || "COURSE 101",
          name: course || "My first course",
          lecturer: "",
          color: "#005B45",
          noteCount: 0,
        },
      );
      router.replace("/home");
    } catch (error) {
      const msg =
        error instanceof Error &&
        error.message &&
        !/failed \(|\bstatus\b|prisma|sql|constraint/i.test(error.message)
          ? error.message
          : "Check your connection and try again.";
      Alert.alert("Could not finish setup", msg);
    } finally {
      setSaving(false);
    }
  };
  return (
    <SafeAreaView className="flex-1 bg-cream" style={{ flex: 1 }}>
      <ScrollView contentContainerClassName="px-6 pb-8 pt-5">
        <Logo />
        <View className="mt-10">
          <Text className="text-[32px] font-black text-ink">
            Make Sua yours.
          </Text>
          <Text className="mt-2 text-base leading-6 text-ink-soft">
            A few quick details help us build your first study space.
          </Text>
        </View>
        <View className="mt-8 gap-4">
          <Field
            label="University"
            value={university}
            onChangeText={setUniversity}
            placeholder="e.g. University of Ghana"
          />
          <Field
            label="Programme"
            value={programme}
            onChangeText={setProgramme}
            placeholder="e.g. Computer Science"
          />
          <View className="gap-2">
            <Text className="text-sm font-semibold text-ink-soft">
              Current level
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {levels.map((item) => (
                <Pressable
                  key={item}
                  onPress={() => setLevel(item)}
                  className={`min-h-11 rounded-input px-4 py-3 ${level === item ? "bg-brand-strong" : "bg-surface"} border border-line active:opacity-80`}
                >
                  <Text
                    className={`font-semibold ${level === item ? "text-gold" : "text-ink-soft"}`}
                  >
                    {item}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View className="mt-3 rounded-card bg-success-soft p-5">
            <View className="flex-row items-center gap-2">
              <CalendarDays size={18} color={pv.brand.DEFAULT} />
              <Text className="font-extrabold text-brand">
                Add your first course
              </Text>
            </View>
            <Text className="mt-1 text-sm leading-5 text-ink-soft">
              You can add more courses anytime from Courses.
            </Text>
            <View className="mt-4 gap-3">
              <Field
                label="Course name"
                value={course}
                onChangeText={setCourse}
                placeholder="e.g. Data Structures"
              />
              <Field
                label="Course code (optional)"
                value={code}
                onChangeText={setCode}
                placeholder="e.g. CS 241"
              />
            </View>
          </View>
        </View>
        <View className="mt-8 gap-3">
          <PrimaryButton onPress={() => finish(false)}>
            {saving ? "Saving..." : "Go to my Home"}{" "}
            <ChevronRight size={16} color={pv.gold.DEFAULT} />
          </PrimaryButton>
          <Pressable
            onPress={() => finish(true)}
            disabled={saving}
            className="items-center py-3"
          >
            <Text className="font-bold text-brand">Skip for now</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
