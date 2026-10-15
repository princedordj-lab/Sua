import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import {
  Archive,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react-native";
import { router } from "expo-router";
import { Field, PrimaryButton } from "../../../components/ui";
import { FormSheet } from "../../../components/sheets";
import { colors } from "../../../config/theme";
import { useApp } from "../../../state/AppContext";
import type { Course } from "../../../lib/types";
import { SafeAreaView } from "react-native-safe-area-context";

type FilterKey = "all" | "active" | "archived";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All" },
  { key: "active", label: "This semester" },
  { key: "archived", label: "Archived" },
];

// Known course colours map to token tints; unknown server colours fall back to
// the raw value with a translucent tint so any colour renders safely.
const COURSE_STYLES: Record<string, { accent: string; tint: string }> = {
  [colors.course.ocean]: {
    accent: colors.course.ocean,
    tint: colors.courseTint.ocean,
  },
  [colors.course.forest]: {
    accent: colors.course.forest,
    tint: colors.courseTint.forest,
  },
  [colors.course.gold]: {
    accent: colors.course.gold,
    tint: colors.courseTint.gold,
  },
  [colors.course.coral]: {
    accent: colors.course.coral,
    tint: colors.courseTint.coral,
  },
  [colors.course.violet]: {
    accent: colors.course.violet,
    tint: colors.courseTint.violet,
  },
  [colors.course.sky]: {
    accent: colors.course.sky,
    tint: colors.courseTint.sky,
  },
  [colors.course.plum]: {
    accent: colors.course.plum,
    tint: colors.courseTint.plum,
  },
  [colors.course.slate]: {
    accent: colors.course.slate,
    tint: colors.courseTint.slate,
  },
  [colors.brand.DEFAULT]: {
    accent: colors.brand.DEFAULT,
    tint: colors.successSoft,
  },
};

function courseStyle(color: string) {
  return COURSE_STYLES[color] ?? { accent: color, tint: `${color}1F` };
}

function courseInitials(course: Course) {
  const source = course.code.trim() || course.name.trim();
  return source.slice(0, 2).toUpperCase() || "—";
}

function noteLabel(count: number) {
  if (count === 0) return "No notes yet";
  return `${count} ${count === 1 ? "note" : "notes"}`;
}

export default function Courses() {
  const { courses, addCourse, updateCourse, deleteCourse } = useApp();
  const db = useSQLiteContext();
  const [editing, setEditing] = useState<Course | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [actionsFor, setActionsFor] = useState<Course | null>(null);
  const [noteCounts, setNoteCounts] = useState<Record<string, number>>({});

  // Real per-course note counts from SQLite; the server Course payload carries
  // no count, so the stored noteCount is only a fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await db.getAllAsync<{ course_id: string; total: number }>(
          "SELECT course_id, COUNT(*) AS total FROM notes GROUP BY course_id",
        );
        if (!cancelled) {
          setNoteCounts(
            Object.fromEntries(rows.map((row) => [row.course_id, row.total])),
          );
        }
      } catch {
        if (!cancelled) setNoteCounts({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [courses, db]);

  const visibleCourses = useMemo(() => {
    const q = query.trim().toLowerCase();
    return courses.filter((course) => {
      const archived = Boolean(course.archived);
      if (filter === "active" && archived) return false;
      if (filter === "archived" && !archived) return false;
      if (!q) return true;
      return (
        course.name.toLowerCase().includes(q) ||
        course.code.toLowerCase().includes(q) ||
        course.lecturer.toLowerCase().includes(q)
      );
    });
  }, [courses, filter, query]);

  const openNew = () => {
    setName("");
    setCode("");
    setShowNew(true);
  };
  const save = async () => {
    if (!name.trim()) return;
    try {
      if (editing) await updateCourse(editing.id, { name, code });
      else
        await addCourse({
          name,
          code: code || "COURSE",
          lecturer: "",
          color: colors.brand.DEFAULT,
          noteCount: 0,
        });
      setEditing(null);
      setShowNew(false);
    } catch (error) {
      Alert.alert(
        "Could not save course",
        error instanceof Error && error.message
          ? error.message
          : "Check your connection and try again.",
      );
    }
  };
  const remove = (course: Course) =>
    Alert.alert(
      `Delete ${course.name}?`,
      "Notes and study sets in this course will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleteCourse(course.id).catch(() =>
              Alert.alert(
                "Could not delete course",
                "Check your connection and try again.",
              ),
            );
          },
        },
      ],
    );
  const startRename = () => {
    if (!actionsFor) return;
    setEditing(actionsFor);
    setName(actionsFor.name);
    setCode(actionsFor.code);
    setActionsFor(null);
  };
  const toggleArchive = () => {
    if (!actionsFor) return;
    const target = actionsFor;
    setActionsFor(null);
    updateCourse(target.id, { archived: !target.archived }).catch(() =>
      Alert.alert(
        "Could not update course",
        "Check your connection and try again.",
      ),
    );
  };
  const confirmRemove = () => {
    if (!actionsFor) return;
    const target = actionsFor;
    setActionsFor(null);
    remove(target);
  };
  return (
      <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerClassName="px-screen pb-8 pt-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-h1 font-sans-extrabold text-brand">
            My Courses
          </Text>
          <Pressable
            onPress={openNew}
            accessibilityRole="button"
            accessibilityLabel="Add course"
            className="h-12 w-12 items-center justify-center rounded-btn bg-brand active:opacity-80"
          >
            <Plus color={colors.gold.DEFAULT} size={22} />
          </Pressable>
        </View>
        <View className="mt-5 h-12 flex-row items-center gap-2 rounded-input border border-line bg-surface px-3">
          <Search size={18} color={colors.ink.faint} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search courses"
            placeholderTextColor={colors.ink.faint}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Search courses"
            className="h-full flex-1 text-body text-ink"
          />
          {query.length > 0 && (
            <Pressable
              onPress={() => setQuery("")}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              className="h-11 w-11 items-center justify-center active:opacity-80"
            >
              <X size={18} color={colors.ink.faint} />
            </Pressable>
          )}
        </View>
        <View className="mt-4 flex-row gap-2">
          {FILTERS.map((item) => {
            const selected = filter === item.key;
            return (
              <Pressable
                key={item.key}
                onPress={() => setFilter(item.key)}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                className={`min-h-12 flex-row items-center justify-center rounded-chip border px-4 active:opacity-80 ${
                  selected ? "border-brand bg-brand" : "border-line bg-surface"
                }`}
              >
                <Text
                  className={`text-label font-sans-bold ${
                    selected ? "text-ink-inverse" : "text-ink-soft"
                  }`}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
        <View className="mt-5 gap-4">
          {visibleCourses.length === 0 ? (
            <View className="items-center rounded-card bg-surface p-card-lg shadow-card">
              <Text className="text-body-lg font-sans-bold text-ink">
                {query.trim()
                  ? "No matching courses"
                  : filter === "archived"
                    ? "No archived courses"
                    : "No courses yet"}
              </Text>
              <Text className="mt-2 text-center text-small text-ink-soft">
                {query.trim()
                  ? `Nothing matches "${query.trim()}". Try a different name or code.`
                  : filter === "archived"
                    ? "Courses you archive will appear here."
                    : "Add your first course to start organizing notes."}
              </Text>
              {query.trim() ? (
                <Pressable
                  onPress={() => setQuery("")}
                  className="mt-4 min-h-12 flex-row items-center justify-center gap-1 rounded-btn border border-line bg-cream px-5 active:opacity-80"
                  accessibilityRole="button"
                >
                  <X size={16} color={colors.brand.DEFAULT} />
                  <Text className="text-label font-sans-bold text-brand">
                    Clear search
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            visibleCourses.map((course) => {
              const { accent, tint } = courseStyle(course.color);
              const noteCount = noteCounts[course.id] ?? course.noteCount;
              return (
                <View
                  key={course.id}
                  className="overflow-hidden rounded-card bg-surface shadow-card"
                >
                  <View className="flex-row">
                    <View
                      style={{ backgroundColor: accent }}
                      className="w-1.5 self-stretch"
                    />
                    <Pressable
                      onPress={() => router.push(`/course/${course.id}`)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${course.name}`}
                      className="flex-1 flex-row items-center p-card active:opacity-80"
                    >
                      <View
                        style={{ backgroundColor: tint }}
                        className="h-14 w-14 items-center justify-center rounded-tile"
                      >
                        <Text
                          style={{ color: accent }}
                          className="text-body-lg font-sans-extrabold"
                        >
                          {courseInitials(course)}
                        </Text>
                      </View>
                      <View className="ml-3 flex-1">
                        {course.code ? (
                          <Text
                            style={{ color: accent }}
                            className="text-label font-sans-extrabold"
                            numberOfLines={1}
                          >
                            {course.code}
                          </Text>
                        ) : null}
                        <Text
                          className={`text-body-lg font-sans-bold text-ink ${
                            course.code ? "mt-0.5" : ""
                          }`}
                          numberOfLines={2}
                        >
                          {course.name}
                        </Text>
                        <View className="mt-1.5 flex-row items-center">
                          <FileText size={14} color={colors.ink.faint} />
                          <Text className="ml-1.5 text-small text-ink-soft">
                            {noteLabel(noteCount)}
                          </Text>
                          {course.archived ? (
                            <View className="ml-2 rounded-chip border border-line px-2 py-0.5">
                              <Text className="text-caption font-sans-bold text-ink-faint">
                                ARCHIVED
                              </Text>
                            </View>
                          ) : null}
                        </View>
                      </View>
                      <Pressable
                        onPress={() => setActionsFor(course)}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Actions for ${course.name}`}
                        className="ml-2 h-11 w-11 items-center justify-center rounded-full active:opacity-80"
                      >
                        <MoreHorizontal size={20} color={colors.ink.faint} />
                      </Pressable>
                    </Pressable>
                  </View>
                </View>
              );
            })
          )}
        </View>
        <Pressable
          onPress={openNew}
          className="mt-5 min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand px-5 active:opacity-80"
        >
          <Plus size={18} color={colors.gold.DEFAULT} />
          <Text className="font-bold text-gold">Add another course</Text>
        </Pressable>
        <Modal
          visible={!!actionsFor}
          transparent
          animationType="fade"
          onRequestClose={() => setActionsFor(null)}
        >
          <Pressable
            onPress={() => setActionsFor(null)}
            className="flex-1 justify-end bg-black/30"
          >
            <Pressable
              onPress={() => {}}
              className="rounded-t-sheet bg-cream p-6 pb-10"
            >
              <Text
                className="text-title font-sans-extrabold text-ink"
                numberOfLines={1}
              >
                {actionsFor?.name}
              </Text>
              <Text className="mt-1 text-small text-ink-soft">
                Course actions
              </Text>
              <View className="mt-4 gap-3">
                <Pressable
                  onPress={startRename}
                  className="min-h-12 flex-row items-center gap-3 rounded-input border border-line bg-surface px-4 active:opacity-80"
                  accessibilityRole="button"
                >
                  <Pencil size={18} color={colors.brand.DEFAULT} />
                  <Text className="text-body font-sans-semibold text-ink">
                    Rename
                  </Text>
                </Pressable>
                <Pressable
                  onPress={toggleArchive}
                  className="min-h-12 flex-row items-center gap-3 rounded-input border border-line bg-surface px-4 active:opacity-80"
                  accessibilityRole="button"
                >
                  <Archive size={18} color={colors.brand.DEFAULT} />
                  <Text className="text-body font-sans-semibold text-ink">
                    {actionsFor?.archived ? "Restore" : "Archive"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={confirmRemove}
                  className="min-h-12 flex-row items-center gap-3 rounded-input border border-danger-soft bg-danger-soft px-4 active:opacity-80"
                  accessibilityRole="button"
                >
                  <Trash2 size={18} color={colors.danger} />
                  <Text className="text-body font-sans-semibold text-danger">
                    Delete
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setActionsFor(null)}
                  className="min-h-12 flex-row items-center justify-center rounded-input border border-line bg-surface px-4 active:opacity-80"
                  accessibilityRole="button"
                >
                  <Text className="text-body font-sans-semibold text-ink-soft">
                    Cancel
                  </Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>
        <FormSheet
          visible={showNew || !!editing}
          onClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
          title={editing ? "Rename course" : "New course"}
        >
          <Field
            label="Course name"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Data Structures"
          />
          <Field
            label="Course code"
            value={code}
            onChangeText={setCode}
            placeholder="e.g. CS 241"
          />
          <PrimaryButton onPress={save}>
            {editing ? "Save changes" : "Create course"}
          </PrimaryButton>
        </FormSheet>
      </ScrollView>
    </SafeAreaView>
  );
}
