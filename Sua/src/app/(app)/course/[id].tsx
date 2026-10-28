import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  FileText,
  MoreHorizontal,
  Pencil,
  Plus,
  Play,
  Trash2,
} from "lucide-react-native";
import { useApp } from "../../../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSQLiteContext } from "expo-sqlite";
import {
  deleteNote,
  listNotes,
  listStudySetNotes,
  saveNote,
  type LocalStudySetRef,
  type Note,
} from "../../../lib/notes";
import { stripMarkdown } from "../../../lib/markdown";
import {
  BottomSheet,
  CoursePickerSheet,
  FormSheet,
  SheetAction,
} from "../../../components/sheets";
import { Field, PrimaryButton } from "../../../components/ui";
import { usePalette } from "../../../state/appearance";
import { courseStyle } from "../../../lib/course-style";

export default function CourseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { courses, updateCourse, deleteCourse } = useApp();
  const pv = usePalette();
  const db = useSQLiteContext();
  const [notes, setNotes] = useState<Note[]>([]);
  const [showActions, setShowActions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [lecturer, setLecturer] = useState("");
  const [examDate, setExamDate] = useState("");
  const [moveNote, setMoveNote] = useState<Note | null>(null);
  const [courseToDelete, setCourseToDelete] = useState(false);
  const [studySets, setStudySets] = useState<LocalStudySetRef[]>([]);
  const [activeTab, setActiveTab] = useState<"notes" | "study">("notes");
  const [showAdd, setShowAdd] = useState(false);

  // Reload on focus so edits made in the Create editor show up on return.
  const loadNotes = useCallback(() => {
    void Promise.all([listNotes(db, id), listStudySetNotes(db)])
      .then(([courseNotes, allStudySets]) => {
        setNotes(courseNotes);
        setStudySets(allStudySets.filter((item) => item.courseId === id));
      })
      .catch(() => {
        setNotes([]);
        setStudySets([]);
      });
  }, [db, id]);
  useFocusEffect(loadNotes);
  const course = courses.find((item) => item.id === id);
  if (!course)
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-cream">
        <Text>Course not found.</Text>
      </SafeAreaView>
    );

  const references = notes.filter((note) => note.noteKind === "reference");
  const studyNotes = notes.filter((note) => note.noteKind !== "reference");
  const studySetCount = studySets.reduce(
    (total, item) => total + item.flashcardCount + item.quizCount,
    0,
  );
  const { accent } = courseStyle(course.color, pv);

  const openActions = () => {
    setName(course.name);
    setCode(course.code);
    setLecturer(course.lecturer);
    setExamDate(course.examDate?.slice(0, 10) ?? "");
    setShowActions(true);
  };
  const saveRename = async () => {
    if (!name.trim()) return;
    const normalizedExamDate = examDate.trim();
    if (normalizedExamDate && Number.isNaN(new Date(normalizedExamDate).getTime())) {
      Alert.alert("Invalid exam date", "Use a valid date such as 2026-12-15.");
      return;
    }
    try {
      await updateCourse(id, {
        name: name.trim(),
        code: code.trim(),
        lecturer: lecturer.trim(),
        examDate: normalizedExamDate || null,
      });
      setRenaming(false);
      setShowActions(false);
    } catch {
      Alert.alert(
        "Could not rename course",
        "Check your connection and try again.",
      );
    }
  };
  const toggleArchive = async () => {
    setShowActions(false);
    try {
      await updateCourse(id, { archived: !course.archived });
    } catch {
      Alert.alert(
        "Could not update course",
        "Check your connection and try again.",
      );
    }
  };
  const confirmDelete = () => {
    setShowActions(false);
    if (notes.length > 0) {
      Alert.alert(
        `Delete ${course.name}?`,
        "Move its notes to another course, or permanently delete them.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete all",
            style: "destructive",
            onPress: () => {
              void deleteCourse(id)
                .then(() => router.replace("/courses"))
                .catch(() => Alert.alert("Could not delete course", "Check your connection and try again."));
            },
          },
          { text: "Move notes", onPress: () => setCourseToDelete(true) },
        ],
      );
      return;
    }
    Alert.alert(
      `Delete ${course.name}?`,
      "Notes and study sets in this course will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            deleteCourse(id)
              .then(() => router.replace("/courses"))
              .catch(() =>
                Alert.alert(
                  "Could not delete course",
                  "Check your connection and try again.",
                ),
              );
          },
        },
      ],
    );
  };
  const move = async (targetId: string) => {
    const note = moveNote;
    setMoveNote(null);
    if (!note || note.courseId === targetId) return;
    try {
      await saveNote(db, {
        id: note.id,
        courseId: targetId,
        title: note.title,
        body: note.body,
        sourceType: note.sourceType,
      });
      loadNotes();
    } catch {
      Alert.alert("Could not move note", "Please try again.");
    }
  };

  const confirmDeleteNote = (note: Note) => {
    const label = note.title.trim() || "this note";
    Alert.alert(
      `Delete ${label.length > 28 ? `${label.slice(0, 28)}…` : label}?`,
      "The note and its uploads will be removed from this device and your account.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteNote(db, note.id);
                setNotes((prev) => prev.filter((item) => item.id !== note.id));
              } catch {
                Alert.alert("Couldn’t delete note", "Try again in a moment.");
              }
            })();
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Pressable
          onPress={() => router.back()}
          className="mb-7 flex-row items-center gap-2"
        >
          <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          <Text className="font-bold text-ink">Courses</Text>
        </Pressable>
        <View className="rounded-3xl border-l-4 border-brand bg-surface p-5" style={{ borderLeftColor: accent }}>
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="font-bold" style={{ color: accent }}>{course.code}</Text>
              <Text className="mt-1 text-2xl font-black text-ink">
                {course.name}
              </Text>
            </View>
            <Pressable
              onPress={openActions}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Actions for ${course.name}`}
              className="h-11 w-11 items-center justify-center rounded-full active:opacity-80"
            >
              <MoreHorizontal size={22} color={pv.ink.DEFAULT} />
            </Pressable>
          </View>
          <Text className="mt-4 text-sm text-ink-soft">
            {course.lecturer || "Add lecturer details from course settings"}
          </Text>
        </View>
        <View className="mt-7 flex-row gap-3">
          <View className="flex-1 rounded-2xl bg-surface p-4">
            <Text className="text-sm text-ink-soft">Notes</Text>
            <Text className="mt-1 text-2xl font-black text-ink">
              {studyNotes.length}
            </Text>
          </View>
          <View className="flex-1 rounded-2xl bg-surface p-4">
            <Text className="text-sm text-ink-soft">Study sets</Text>
            <Text className="mt-1 text-2xl font-black text-ink">{studySetCount}</Text>
          </View>
        </View>
        <View className="mt-7 flex-row rounded-btn border border-line bg-surface p-1">
          {(["notes", "study"] as const).map((tab) => (
            <Pressable
              key={tab}
              onPress={() => setActiveTab(tab)}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === tab }}
              className={`min-h-11 flex-1 items-center justify-center rounded-btn ${activeTab === tab ? "bg-brand-strong" : ""}`}
            >
              <Text className={`font-sans-bold ${activeTab === tab ? "text-ink-inverse" : "text-ink-soft"}`}>
                {tab === "notes" ? "Notes" : "Study sets"}
              </Text>
            </Pressable>
          ))}
        </View>
        {activeTab === "study" ? (
          <View className="mt-5">
            <Pressable
              onPress={() => router.push({ pathname: "/(app)/review", params: { courseId: id } })}
              className="min-h-14 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong px-5 active:opacity-80"
            >
              <Play size={17} color={pv.gold.DEFAULT} />
              <Text className="font-sans-bold text-gold">Review course deck</Text>
            </Pressable>
            {studySets.length === 0 ? (
              <View className="mt-4 items-center rounded-card border border-dashed border-line bg-surface px-6 py-10">
                <BookOpen size={28} color={accent} />
                <Text className="mt-3 text-base font-extrabold text-ink">No study sets yet</Text>
                <Text className="mt-2 text-center text-sm leading-5 text-ink-soft">Generate flashcards and quizzes from a note to review them here.</Text>
              </View>
            ) : studySets.map((studySet) => (
              <Pressable
                key={studySet.noteId}
                onPress={() => router.push({ pathname: "/(app)/deck/[id]", params: { id: studySet.noteId } })}
                className="mt-3 rounded-tile border border-line bg-surface p-4 active:opacity-80"
              >
                <Text className="font-sans-extrabold text-ink">{studySet.noteTitle || "Untitled note"}</Text>
                <Text className="mt-1 text-small text-ink-soft">{studySet.flashcardCount} cards · {studySet.quizCount} quizzes</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <>
        <View className="mt-8 flex-row items-center justify-between">
          <Text className="text-lg font-extrabold text-ink">Notes</Text>
          <Pressable
            onPress={() => setShowAdd(true)}
            className="min-h-11 flex-row items-center rounded-btn bg-brand-strong px-4 active:opacity-80"
          >
            <Plus size={17} color={pv.gold.DEFAULT} />
            <Text className="font-bold text-gold">Add note</Text>
          </Pressable>
        </View>
        {studyNotes.length === 0 ? (
          <View className="mt-3 items-center rounded-3xl border border-dashed border-line bg-surface px-6 py-10">
            <FileText size={28} color={accent} />
            <Text className="mt-3 text-base font-extrabold text-ink">No notes yet</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-ink-soft">Record, upload, or type your first note. It stays available offline.</Text>
          </View>
        ) : studyNotes.map((note) => (
          <View key={note.id} className="mt-3 flex-row items-stretch overflow-hidden rounded-2xl bg-surface">
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(app)/note/[id]",
                  params: { id: note.id },
                })
              }
              className="flex-1 p-4 active:opacity-80"
            >
              <Text className="font-extrabold text-ink">{note.title || "Untitled note"}</Text>
              <Text numberOfLines={2} className="mt-1 text-sm leading-5 text-ink-soft">{stripMarkdown(note.body || note.transcript || "") || "Empty note"}</Text>
              <View className="mt-2 flex-row items-center gap-2">
                {note.partIndex != null && note.groupId ? (
                  <Text className="text-xs font-semibold text-brand">
                    {note.partIndex === 0 ? "Overview" : `Part ${note.partIndex}`}
                  </Text>
                ) : null}
                <Text className="text-xs text-success">{note.syncState === "pending" ? "Waiting to sync" : "Synced"}</Text>
                {note.aiState !== "none" && note.aiState !== "ready" && note.aiState !== "failed" ? (
                  <Text className="text-xs font-semibold text-brand">AI working…</Text>
                ) : note.aiState === "ready" ? (
                  <Text className="text-xs font-semibold text-brand">AI ready</Text>
                ) : note.aiState === "failed" ? (
                  <Text className="text-xs font-semibold text-danger">AI failed</Text>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              onPress={() => setMoveNote(note)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Move ${note.title || "note"} to another course`}
              className="w-12 items-center justify-center border-l border-line active:opacity-80"
            >
              <ArrowRightLeft size={17} color={pv.brand.DEFAULT} />
            </Pressable>
            <Pressable
              onPress={() => confirmDeleteNote(note)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${note.title || "note"}`}
              className="w-12 items-center justify-center border-l border-line active:opacity-80"
            >
              <Trash2 size={17} color={pv.danger} />
            </Pressable>
          </View>
        ))}

        {references.length ? (
          <View className="mt-8">
            <Text className="text-lg font-extrabold text-ink">Reference</Text>
            <Text className="mt-0.5 text-sm text-ink-soft">
              Condensed key points from your uploaded slides and photos.
            </Text>
            {references.map((note) => (
              <View
                key={note.id}
                className="mt-3 flex-row items-stretch overflow-hidden rounded-2xl border border-line bg-info-soft"
              >
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/(app)/note/[id]",
                      params: { id: note.id },
                    })
                  }
                  className="flex-1 p-4 active:opacity-80"
                >
                  <View className="flex-row items-center gap-2">
                    <BookOpen size={16} color={pv.brand.DEFAULT} />
                    <Text className="font-extrabold text-ink">{note.title || "Untitled reference"}</Text>
                  </View>
                  <Text numberOfLines={3} className="mt-1 text-sm leading-5 text-ink-soft">
                    {stripMarkdown(note.body || note.transcript || "") || "Waiting for the AI to summarise this file…"}
                  </Text>
                  {note.aiState !== "none" && note.aiState !== "ready" && note.aiState !== "failed" ? (
                    <Text className="mt-2 text-xs font-semibold text-brand">AI working…</Text>
                  ) : null}
                </Pressable>
                <Pressable
                  onPress={() => confirmDeleteNote(note)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${note.title || "reference"}`}
                  className="w-12 items-center justify-center border-l border-line active:opacity-80"
                >
                  <Trash2 size={17} color={pv.danger} />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
          </>
        )}
      </ScrollView>
      <BottomSheet
        visible={showActions}
        onClose={() => setShowActions(false)}
        title={course.name}
        subtitle="Course actions"
      >
        <SheetAction
          icon={<Pencil size={18} color={pv.brand.DEFAULT} />}
          label="Rename"
          onPress={() => {
            setShowActions(false);
            setRenaming(true);
          }}
        />
        <SheetAction
          icon={<Archive size={18} color={pv.brand.DEFAULT} />}
          label={course.archived ? "Restore" : "Archive"}
          onPress={toggleArchive}
        />
        <SheetAction
          icon={<Trash2 size={18} color={pv.danger} />}
          label="Delete"
          danger
          onPress={confirmDelete}
        />
        <SheetAction
          icon={<ArrowLeft size={18} color={pv.ink.faint} />}
          label="Cancel"
          onPress={() => setShowActions(false)}
        />
      </BottomSheet>
      <BottomSheet
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add to course"
        subtitle={course.name}
      >
        {[
          ["recording", "Record lecture"],
          ["upload", "Upload slides or notes"],
          ["typing", "Type note"],
        ].map(([mode, label]) => (
          <SheetAction
            key={mode}
            icon={<Plus size={18} color={accent} />}
            label={label}
            onPress={() => {
              setShowAdd(false);
              router.push({ pathname: "/(app)/(tabs)/create", params: { mode, courseId: id } });
            }}
          />
        ))}
      </BottomSheet>
      <CoursePickerSheet
        visible={!!moveNote}
        courses={courses}
        currentCourseId={moveNote?.courseId}
        heading="Move note to"
        onSelect={move}
        onClose={() => setMoveNote(null)}
      />
      <CoursePickerSheet
        visible={courseToDelete}
        courses={courses}
        excludeCourseId={id}
        heading="Move notes to"
        onSelect={(targetId) => {
          setCourseToDelete(false);
          void deleteCourse(id, targetId)
            .then(() => router.replace("/courses"))
            .catch(() => Alert.alert("Could not move notes", "Check your connection and try again."));
        }}
        onClose={() => setCourseToDelete(false)}
      />
      <FormSheet
        visible={renaming}
        onClose={() => setRenaming(false)}
        title="Edit course"
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
        <Field
          label="Lecturer (optional)"
          value={lecturer}
          onChangeText={setLecturer}
          placeholder="e.g. Dr. Mensah"
        />
        <Field
          label="Exam date (optional)"
          value={examDate}
          onChangeText={setExamDate}
          placeholder="YYYY-MM-DD"
          autoCapitalize="none"
        />
        <PrimaryButton onPress={saveRename}>Save changes</PrimaryButton>
      </FormSheet>
    </SafeAreaView>
  );
}
