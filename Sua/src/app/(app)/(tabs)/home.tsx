import { useCallback, useMemo, useState } from "react";
import { Image } from "expo-image";
import { router, useFocusEffect } from "expo-router";
import { useUser } from "@clerk/expo";
import { useSQLiteContext } from "expo-sqlite";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  ChevronRight,
  CloudUpload,
  Keyboard,
  Mic,
  Plus,
} from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { listNotes, type Note } from "../../../lib/notes";
import { useApp } from "../../../state/AppContext";

const actionTiles = [
  { label: "Record", icon: Mic, tint: "bg-success-soft", route: "record" },
  { label: "Upload", icon: CloudUpload, tint: "bg-info-soft", route: "upload" },
  { label: "Type", icon: Keyboard, tint: "bg-[#F0EDFC]", route: "type" },
] as const;

function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "S";
}

function relativeDate(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

export default function Home() {
  const { profile, courses } = useApp();
  const { user } = useUser();
  const db = useSQLiteContext();
  const [notes, setNotes] = useState<Note[]>([]);

  // Reload on focus so edits made in the Create editor show up on return.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      async function loadNotes() {
        const noteGroups = await Promise.all(courses.map((course) => listNotes(db, course.id)));
        if (!cancelled) {
          setNotes(noteGroups.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        }
      }

      void loadNotes().catch(() => {
        if (!cancelled) setNotes([]);
      });

      return () => {
        cancelled = true;
      };
    }, [courses, db]),
  );

  const firstName = profile?.name?.split(" ")[0] || "Student";
  const userName = profile?.name || user?.fullName || user?.firstName || "Sua student";
  const cardsDue = notes.length;
  const progress = Math.min(100, courses.length * 20 + notes.length * 10);
  const progressWidth =
    progress >= 100
      ? "w-full"
      : progress >= 75
        ? "w-3/4"
        : progress >= 50
          ? "w-1/2"
          : progress >= 25
            ? "w-1/4"
            : "w-1/12";
  const recentNotes = notes.slice(0, 2);
  const courseById = useMemo(
    () => new Map(courses.map((course) => [course.id, course])),
    [courses],
  );

  const openCreate = (route: (typeof actionTiles)[number]["route"]) => {
    const mode = route === "type" ? "typing" : route === "upload" ? "upload" : "recording";
    router.push({ pathname: "/(app)/(tabs)/create", params: { mode } });
  };

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-screen pb-8 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <View className="flex-row items-center">
          {user?.imageUrl ? (
            <Image
              source={{ uri: user.imageUrl }}
              className="h-16 w-16 rounded-full bg-surface"
              contentFit="cover"
              accessibilityLabel={`${userName}'s profile photo`}
            />
          ) : (
            <View className="h-16 w-16 items-center justify-center rounded-full bg-success-soft">
              <Text className="text-title font-sans-extrabold text-brand">
                {initials(userName)}
              </Text>
            </View>
          )}
          <View className="ml-4 flex-1">
            <View className="flex-row items-center gap-2">
              <Text className="text-h3 font-sans-extrabold text-ink">
                Good morning, {firstName}
              </Text>
              <View className="h-8 w-8 overflow-hidden rounded-lg">
                <Image
                  source={require('@/assets/images/icons/icon.png')}
                  className="-left-2 -top-2 h-12 w-12"
                  contentFit="contain"
                  accessibilityLabel="Sua"
                />
              </View>
            </View>
            <Text className="mt-1 text-body text-ink-soft">Let’s get ready for exams</Text>
          </View>
          <View className="min-h-11 flex-row items-center rounded-chip border border-gold bg-gold-soft px-3">
            <Text className="text-base">🔥</Text>
            <Text className="ml-1 text-small font-sans-bold text-ink">0-day streak</Text>
          </View>
        </View>

        <View className="overflow-hidden rounded-card bg-brand p-card-lg shadow-card">
          <View className="absolute right-4 top-5 opacity-20">
            <BookOpen size={118} color="#FFFFFF" />
          </View>
          <View className="self-start rounded-chip bg-white/15 px-3 py-2">
            <Text className="text-label font-sans-bold text-white">Today’s review</Text>
          </View>
          <View className="mt-5">
            <Text className="text-display font-sans-extrabold text-white">
              {cardsDue}
              <Text className="text-h2"> {cardsDue === 1 ? "card" : "cards"} due</Text>
            </Text>
            <Text className="mt-1 text-body-lg text-white/85">
              {cardsDue ? `About ${Math.max(5, cardsDue * 2)} minutes` : "Create a note to begin reviewing"}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push("/(app)/(tabs)/study")}
            className="mt-6 min-h-12 self-start flex-row items-center rounded-btn border border-gold bg-brand-light px-5 active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Start review"
          >
            <Text className="text-body-lg font-sans-extrabold text-gold">Start review</Text>
            <ArrowRight className="ml-3" size={22} color="#FFBE1A" />
          </Pressable>
        </View>

        <View className="flex-row items-center rounded-card bg-surface p-card shadow-card">
          <View className="h-24 w-24 items-center justify-center rounded-full border-8 border-gold-soft">
            <Text className="text-title font-sans-extrabold text-ink">{progress}%</Text>
          </View>
          <View className="ml-5 flex-1">
            <Text className="text-title font-sans-extrabold text-ink">Your study progress</Text>
            <Text className="mt-2 text-body text-ink-soft">
              {notes.length ? "Keep going, you’re on track" : "Add study material to get started"}
            </Text>
          </View>
        </View>

        <View className="flex-row gap-3">
          {actionTiles.map(({ label, icon: Icon, tint, route }) => (
            <Pressable
              key={label}
              onPress={() => openCreate(route)}
              className="min-h-36 flex-1 items-center justify-center rounded-tile bg-surface px-2 py-4 shadow-card active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel={label === "Type" ? "Type a note" : `${label} content`}
            >
              <View className={`h-14 w-14 items-center justify-center rounded-full ${tint}`}>
                <Icon size={27} color="#005B45" strokeWidth={2.25} />
              </View>
              <Text className="mt-3 text-body-lg font-sans-bold text-ink">{label}</Text>
            </Pressable>
          ))}
        </View>

        <View>
          <View className="mb-3 flex-row items-center justify-between">
            <Text className="text-title font-sans-extrabold text-ink">Recent notes</Text>
            <Pressable
              onPress={() => router.push("/(app)/(tabs)/courses")}
              className="min-h-11 flex-row items-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="See all courses"
            >
              <Text className="text-body font-sans-bold text-brand">See all</Text>
              <ChevronRight className="ml-1" size={20} color="#005B45" />
            </Pressable>
          </View>
          <View className="overflow-hidden rounded-card bg-surface shadow-card">
            {recentNotes.length ? (
              recentNotes.map((note, index) => {
                const course = courseById.get(note.courseId);
                return (
                  <Pressable
                    key={note.id}
                    onPress={() =>
                      router.push({
                        pathname: "/(app)/note/[id]",
                        params: { id: note.id },
                      })
                    }
                    className={`min-h-20 flex-row items-center px-4 active:opacity-80 ${index ? "border-t border-line" : ""}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Open ${note.title || "untitled note"}`}
                  >
                    <View className="h-12 w-12 items-center justify-center rounded-input bg-success-soft">
                      <Text className="text-small font-sans-extrabold text-brand">
                        {(course?.code || course?.name || "NOTE").slice(0, 3).toUpperCase()}
                      </Text>
                    </View>
                    <View className="ml-3 flex-1">
                      <Text className="text-body font-sans-bold text-ink" numberOfLines={1}>
                        {note.title || "Untitled note"}
                      </Text>
                      <Text className="mt-1 text-small text-ink-soft" numberOfLines={1}>
                        {course?.name || "Study note"} · {relativeDate(note.updatedAt)}
                      </Text>
                    </View>
                    <Bookmark size={20} color="#005B45" />
                    <ChevronRight className="ml-3" size={20} color="#8A978F" />
                  </Pressable>
                );
              })
            ) : (
              <Pressable
                onPress={() => openCreate("type")}
                className="min-h-28 items-center justify-center px-5 active:opacity-80"
                accessibilityRole="button"
              >
                <Plus size={22} color="#005B45" />
                <Text className="mt-2 text-body font-sans-bold text-brand">Create your first note</Text>
                <Text className="mt-1 text-center text-small text-ink-soft">
                  Your offline notes will appear here.
                </Text>
              </Pressable>
            )}
          </View>
        </View>

        <View className="rounded-card bg-surface p-card shadow-card">
          <Text className="text-body font-sans-bold text-ink">Your study library</Text>
          <View className="mt-3 h-2 overflow-hidden rounded-chip bg-line">
            <View className={`h-full rounded-chip bg-brand ${progressWidth}`} />
          </View>
          <Text className="mt-3 text-small text-ink-soft">
            {courses.length
              ? `${courses.length} ${courses.length === 1 ? "course" : "courses"} ready for study`
              : "Add a course to organize your study material"}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
