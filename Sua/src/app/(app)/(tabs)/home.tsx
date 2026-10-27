import { useCallback, useMemo, useState } from "react";
import { Image } from "expo-image";
import { router, useFocusEffect } from "expo-router";
import { useUser } from "@clerk/expo";
import { useSQLiteContext } from "expo-sqlite";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import {
  ArrowRight,
  BookOpen,
  Brain,
  ChevronRight,
  CloudUpload,
  Flame,
  Keyboard,
  Layers,
  Mic,
  Plus,
  Sparkles,
} from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { courseStyle } from "../../../lib/course-style";
import {
  listNotes,
  loadHomeStats,
  type HomeStats,
  type Note,
} from "../../../lib/notes";
import { useApp } from "../../../state/AppContext";
import { usePalette } from "../../../state/appearance";
import type { Course } from "../../../lib/types";

const actionTiles = [
  {
    label: "Record",
    hint: "Lecture audio",
    icon: Mic,
    tint: "bg-success-soft",
    route: "record",
  },
  {
    label: "Upload",
    hint: "PDF or slides",
    icon: CloudUpload,
    tint: "bg-info-soft",
    route: "upload",
  },
  {
    label: "Type",
    hint: "Write it out",
    icon: Keyboard,
    tint: "bg-courseTint-violet",
    route: "type",
  },
] as const;

const DAY_MS = 86_400_000;

function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "S"
  );
}

function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function relativeDate(value: string) {
  const days = Math.floor((Date.now() - new Date(value).getTime()) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

function weekdayLabel(dateKey: string) {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

/** Nearest exam that has not happened yet, across active courses. */
function nextExam(courses: Course[]) {
  if (!courses.length) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let nearest: { course: Course; days: number } | null = null;
  for (const course of courses) {
    if (course.archived || !course.examDate) continue;
    const exam = new Date(course.examDate);
    if (Number.isNaN(exam.getTime())) continue;
    exam.setHours(0, 0, 0, 0);
    const days = Math.round((exam.getTime() - today.getTime()) / DAY_MS);
    if (days < 0) continue;
    if (!nearest || days < nearest.days) nearest = { course, days };
  }
  return nearest;
}

function cardsLabel(count: number) {
  return `${count} ${count === 1 ? "card" : "cards"}`;
}

export default function Home() {
  const { profile, courses, retryHydration } = useApp();
  const pv = usePalette();
  const { user } = useUser();
  const db = useSQLiteContext();
  const [notes, setNotes] = useState<Note[]>([]);
  const [stats, setStats] = useState<HomeStats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const activeCourses = useMemo(
    () => courses.filter((course) => !course.archived),
    [courses],
  );

  const load = useCallback(async () => {
    const [noteGroups, homeStats] = await Promise.all([
      Promise.all(activeCourses.map((course) => listNotes(db, course.id))),
      loadHomeStats(db),
    ]);
    setNotes(
      noteGroups.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
    setStats(homeStats);
  }, [activeCourses, db]);

  // Reload on focus so edits made in the Create editor show up on return.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void load().catch(() => {
        if (!cancelled) setNotes([]);
      });
      return () => {
        cancelled = true;
      };
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
      // Pull the server profile (and its usage counters) back in while online.
      retryHydration();
    } catch {
      // The local data already on screen stays usable offline.
    } finally {
      setRefreshing(false);
    }
  }, [load, retryHydration]);

  // Scope the global card aggregates to notes the student can still see (an
  // archived course's decks no longer count toward Home).
  const noteIds = useMemo(() => new Set(notes.map((note) => note.id)), [notes]);
  const due = useMemo(() => {
    if (!stats) return 0;
    let total = 0;
    for (const noteId of noteIds) total += stats.dueCardsByNote.get(noteId) ?? 0;
    return total;
  }, [noteIds, stats]);
  const cardsInNotes = useMemo(() => {
    if (!stats) return 0;
    let total = 0;
    for (const noteId of noteIds) total += stats.cardsByNote.get(noteId) ?? 0;
    return total;
  }, [noteIds, stats]);
  const studySetCount = useMemo(() => {
    if (!stats) return 0;
    let total = 0;
    for (const noteId of noteIds) {
      if (
        (stats.cardsByNote.get(noteId) ?? 0) > 0 ||
        stats.quizNoteIds.has(noteId)
      ) {
        total += 1;
      }
    }
    return total;
  }, [noteIds, stats]);

  const reviewedToday = stats?.reviewedToday ?? 0;
  const quizAttemptsToday = stats?.quizAttemptsToday ?? 0;
  const streak = stats?.streakDays ?? 0;
  const weekly = stats?.weekly ?? [];
  const weekTotal = weekly.reduce((sum, day) => sum + day.reviewed, 0);
  const weekPeak = Math.max(1, ...weekly.map((day) => day.reviewed));
  const todayKey = weekly[weekly.length - 1]?.date;
  const dailyProgress =
    reviewedToday + due > 0
      ? Math.round((reviewedToday / (reviewedToday + due)) * 100)
      : 0;
  const coverage =
    notes.length > 0 ? Math.round((studySetCount / notes.length) * 100) : 0;
  const exam = useMemo(() => nextExam(activeCourses), [activeCourses]);
  const recentNotes = notes.slice(0, 3);
  const courseById = useMemo(
    () => new Map(courses.map((course) => [course.id, course])),
    [courses],
  );

  const firstName = profile?.name?.split(" ")[0] || "";
  const userName = profile?.name || user?.fullName || user?.firstName || "Sua student";
  const usage = profile?.usage;
  const studySetsUsed = usage?.studySets ?? 0;
  const studySetsLimit = usage?.limits.studySets ?? 0;
  const usagePercent =
    studySetsLimit > 0
      ? Math.min(100, Math.round((studySetsUsed / studySetsLimit) * 100))
      : 0;

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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        <View className="flex-row items-center">
          <Pressable
            onPress={() => router.push("/(app)/(tabs)/profile")}
            accessibilityRole="button"
            accessibilityLabel="Open your profile"
            className="rounded-full active:opacity-80"
          >
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
          </Pressable>
          <View className="ml-4 flex-1">
            <Text className="text-h3 font-sans-extrabold text-ink" numberOfLines={1}>
              {greetingFor()}
              {firstName ? `, ${firstName}` : ""}
            </Text>
            <Text className="mt-1 text-body text-ink-soft" numberOfLines={1}>
              {exam
                ? `${exam.course.code || exam.course.name} exam ${
                    exam.days === 0
                      ? "is today"
                      : `in ${exam.days} ${exam.days === 1 ? "day" : "days"}`
                  }`
                : "Let’s get ready for exams"}
            </Text>
          </View>
          <Pressable
            onPress={() => router.push("/(app)/(tabs)/study")}
            className="min-h-11 flex-row items-center rounded-chip border border-gold bg-gold-soft px-3 active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel={
              streak > 0
                ? `${streak}-day study streak. Open the study tab`
                : "No study streak yet. Open the study tab to start one"
            }
          >
            <Flame size={16} color={pv.warning} />
            <Text className="ml-1 text-small font-sans-bold text-ink">
              {streak > 0 ? `${streak}-day streak` : "Start a streak"}
            </Text>
          </Pressable>
        </View>

        <View className="overflow-hidden rounded-card bg-brand-strong p-card-lg shadow-card">
          <View className="absolute right-4 top-5 opacity-20">
            <BookOpen size={118} color="#FFFFFF" />
          </View>
          <View className="self-start rounded-chip bg-white/15 px-3 py-2">
            <Text className="text-label font-sans-bold text-white">Today’s review</Text>
          </View>
          <View className="mt-5">
            <Text className="text-display font-sans-extrabold text-white">
              {stats ? due : "—"}
              <Text className="text-h2">
                {due === 1 ? " card due" : " cards due"}
              </Text>
            </Text>
            <Text className="mt-1 text-body-lg text-white/85">
              {due > 0
                ? `About ${Math.max(5, due * 2)} minutes of focused recall`
                : reviewedToday > 0
                  ? `You reviewed ${cardsLabel(reviewedToday)} today`
                  : "Create a study set to begin reviewing"}
            </Text>
          </View>

          <View className="mt-5">
            <View className="flex-row items-center justify-between">
              <Text className="text-caption font-sans-bold text-white/70">
                Today’s goal
              </Text>
              <Text className="text-caption font-sans-bold text-white/70">
                {reviewedToday} reviewed
              </Text>
            </View>
            <View className="mt-2 h-2 overflow-hidden rounded-chip bg-white/20">
              <View
                className="h-full rounded-chip bg-gold"
                style={{ width: `${dailyProgress}%` }}
              />
            </View>
          </View>

          <View className="mt-5 flex-row items-center gap-4">
            <Pressable
              onPress={() => router.push("/review")}
              className="min-h-12 flex-row items-center rounded-btn border border-gold bg-brand-light px-5 active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel={due > 0 ? "Start review" : "Review anyway"}
            >
              <Text className="text-body-lg font-sans-extrabold text-gold">
                {due > 0 ? "Start review" : "Review anyway"}
              </Text>
              <ArrowRight className="ml-3" size={22} color="#FFBE1A" />
            </Pressable>
            <Pressable
              onPress={() => router.push("/(app)/(tabs)/study")}
              className="min-h-11 flex-row items-center active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel="Open study space"
            >
              <Text className="text-body font-sans-bold text-white/85">
                Study space
              </Text>
              <ChevronRight size={18} color="rgba(255,255,255,0.7)" />
            </Pressable>
          </View>
        </View>

        <View className="flex-row gap-3">
          {[
            {
              label: "DUE NOW",
              value: due,
              caption: due === 1 ? "flashcard waiting" : "flashcards waiting",
              onPress: () => router.push("/review"),
              a11y: `Open review. ${cardsLabel(due)} due`,
            },
            {
              label: "7-DAY CARDS",
              value: weekTotal,
              caption: "cards reviewed",
              onPress: () => router.push("/(app)/(tabs)/study"),
              a11y: `Open study space. ${cardsLabel(weekTotal)} reviewed this week`,
            },
            {
              label: "QUIZZES TODAY",
              value: quizAttemptsToday,
              caption: quizAttemptsToday === 1 ? "quiz taken" : "quizzes taken",
              onPress: () => router.push("/(app)/(tabs)/study"),
              a11y: `Open study space. ${quizAttemptsToday} quizzes taken today`,
            },
          ].map((stat) => (
            <Pressable
              key={stat.label}
              onPress={stat.onPress}
              accessibilityRole="button"
              accessibilityLabel={stat.a11y}
              className="flex-1 items-center rounded-card bg-surface p-3 shadow-card active:opacity-80"
            >
              <Text className="text-caption font-sans-extrabold text-ink-soft">
                {stat.label}
              </Text>
              <Text className="mt-1 text-h3 font-sans-black text-ink">
                {stats ? stat.value : "—"}
              </Text>
              <Text className="mt-1 text-center text-caption text-ink-soft">
                {stat.caption}
              </Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          onPress={() => router.push("/(app)/(tabs)/study")}
          accessibilityRole="button"
          accessibilityLabel={
            exam
              ? `${exam.course.code || exam.course.name} exam in ${exam.days} days. ${studySetCount} of ${notes.length} notes have study sets. Open study space`
              : `${studySetCount} of ${notes.length} notes have study sets. Open study space`
          }
          className="flex-row items-center rounded-card bg-surface p-card shadow-card active:opacity-80"
        >
          <View className="h-24 w-24 items-center justify-center rounded-full border-8 border-gold-soft">
            <Text className="text-title font-sans-extrabold text-ink">{coverage}%</Text>
          </View>
          <View className="ml-5 flex-1">
            <Text className="text-title font-sans-extrabold text-ink" numberOfLines={2}>
              {exam
                ? `${exam.course.code || exam.course.name} exam ${
                    exam.days === 0
                      ? "is today"
                      : `in ${exam.days} ${exam.days === 1 ? "day" : "days"}`
                  }`
                : "Study set coverage"}
            </Text>
            <Text className="mt-2 text-body text-ink-soft">
              {notes.length
                ? `${studySetCount} of ${notes.length} ${
                    notes.length === 1 ? "note has" : "notes have"
                  } a study set`
                : "Add a note to start building study sets"}
            </Text>
          </View>
          <ChevronRight size={20} color={pv.ink.faint} />
        </Pressable>

        <View className="flex-row gap-3">
          {actionTiles.map(({ label, hint, icon: Icon, tint, route }) => (
            <Pressable
              key={label}
              onPress={() => openCreate(route)}
              className="min-h-36 flex-1 items-center justify-center rounded-tile bg-surface px-2 py-4 shadow-card active:opacity-80"
              accessibilityRole="button"
              accessibilityLabel={label === "Type" ? "Type a note" : `${label} content`}
            >
              <View className={`h-14 w-14 items-center justify-center rounded-full ${tint}`}>
                <Icon size={27} color={pv.brand.DEFAULT} strokeWidth={2.25} />
              </View>
              <Text className="mt-3 text-body-lg font-sans-bold text-ink">{label}</Text>
              <Text className="mt-0.5 text-caption text-ink-soft">{hint}</Text>
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
              <ChevronRight className="ml-1" size={20} color={pv.brand.DEFAULT} />
            </Pressable>
          </View>
          <View className="overflow-hidden rounded-card bg-surface shadow-card">
            {recentNotes.length ? (
              recentNotes.map((note, index) => {
                const course = courseById.get(note.courseId);
                const style = courseStyle(course?.color ?? "", pv);
                const cards = stats?.cardsByNote.get(note.id) ?? 0;
                const noteDue = stats?.dueCardsByNote.get(note.id) ?? 0;
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
                    accessibilityLabel={`Open ${note.title || "untitled note"}. ${cardsLabel(cards)}, ${noteDue} due`}
                  >
                    <View
                      className="h-12 w-12 items-center justify-center rounded-input"
                      style={{ backgroundColor: style.tint }}
                    >
                      <Text
                        className="text-small font-sans-extrabold"
                        style={{ color: style.accent }}
                      >
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
                    <View className="items-end">
                      <View className="flex-row items-center gap-1">
                        <Layers size={13} color={pv.ink.faint} />
                        <Text className="text-caption font-sans-bold text-ink-soft">
                          {cards ? cardsLabel(cards) : "No cards"}
                        </Text>
                      </View>
                      {noteDue > 0 ? (
                        <Text className="mt-1 text-caption font-sans-extrabold text-brand">
                          {noteDue} due
                        </Text>
                      ) : null}
                    </View>
                    <ChevronRight className="ml-2" size={20} color={pv.ink.faint} />
                  </Pressable>
                );
              })
            ) : (
              <Pressable
                onPress={() => openCreate("type")}
                className="min-h-28 items-center justify-center px-5 active:opacity-80"
                accessibilityRole="button"
                accessibilityLabel="Create your first note"
              >
                <Plus size={22} color={pv.brand.DEFAULT} />
                <Text className="mt-2 text-body font-sans-bold text-brand">
                  Create your first note
                </Text>
                <Text className="mt-1 text-center text-small text-ink-soft">
                  Type, record or upload study material — it appears here.
                </Text>
              </Pressable>
            )}
          </View>
        </View>

        <View className="rounded-card bg-surface p-card shadow-card">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-title font-sans-extrabold text-ink">7-day rhythm</Text>
              <Text className="mt-1 text-small text-ink-soft">
                Cards you reviewed each day.
              </Text>
            </View>
            <View className="rounded-chip bg-success-soft px-3 py-1.5">
              <Text className="text-caption font-sans-extrabold text-brand">
                {weekTotal} total
              </Text>
            </View>
          </View>
          <View className="mt-5 flex-row items-end justify-between gap-2">
            {weekly.map((day) => {
              const height = Math.max(6, Math.round((day.reviewed / weekPeak) * 64));
              const isToday = day.date === todayKey;
              return (
                <View key={day.date} className="flex-1 items-center">
                  <Text className="mb-1 text-caption font-sans-bold text-ink-soft">
                    {day.reviewed}
                  </Text>
                  <View className="h-16 w-full justify-end">
                    <View
                      className="w-full rounded-chip bg-brand-strong"
                      style={{ height }}
                    />
                  </View>
                  <Text
                    className={`mt-2 text-caption ${isToday ? "font-sans-extrabold text-brand" : "font-sans-medium text-ink-soft"}`}
                  >
                    {weekdayLabel(day.date)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>

        <View className="rounded-card bg-surface p-card shadow-card">
          <View className="flex-row items-center justify-between">
            <Text className="text-body font-sans-bold text-ink">Your study library</Text>
            <View className="flex-row items-center gap-1">
              <Brain size={14} color={pv.brand.DEFAULT} />
              <Text className="text-caption font-sans-bold text-brand">
                {cardsLabel(cardsInNotes)}
              </Text>
            </View>
          </View>
          <Text className="mt-2 text-small text-ink-soft">
            {notes.length
              ? `${notes.length} ${notes.length === 1 ? "note" : "notes"} · ${studySetCount} ${
                  studySetCount === 1 ? "study set" : "study sets"
                } · ${courses.length} ${courses.length === 1 ? "course" : "courses"}`
              : "Add a course and a note to organize your study material"}
          </Text>

          {usage && studySetsLimit > 0 ? (
            <View className="mt-4">
              <View className="flex-row items-center justify-between">
                <Text className="text-caption font-sans-bold text-ink-soft">
                  Study sets this month
                </Text>
                <Text className="text-caption font-sans-extrabold text-ink">
                  {studySetsUsed}/{studySetsLimit}
                </Text>
              </View>
              <View className="mt-2 h-2 overflow-hidden rounded-chip bg-line">
                <View
                  className="h-full rounded-chip bg-brand-strong"
                  style={{ width: `${usagePercent}%` }}
                />
              </View>
              <Pressable
                onPress={() => router.push("/(app)/(tabs)/profile")}
                className="mt-3 min-h-11 flex-row items-center active:opacity-80"
                accessibilityRole="button"
                accessibilityLabel="View plan and usage in your profile"
              >
                <Sparkles size={14} color={pv.gold.DEFAULT} />
                <Text className="ml-2 flex-1 text-small text-ink-soft">
                  {usagePercent >= 100
                    ? "Limit reached — upgrade for unlimited study sets"
                    : "Free plan usage"}
                </Text>
                <Text className="text-small font-sans-bold text-brand">Profile</Text>
                <ChevronRight size={16} color={pv.brand.DEFAULT} />
              </Pressable>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
