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
  Trash2,
} from "lucide-react-native";
import { useApp } from "../../../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSQLiteContext } from "expo-sqlite";
import { deleteNote, listNotes, saveNote, type Note } from "../../../lib/notes";
import { stripMarkdown } from "../../../lib/markdown";
import {
  BottomSheet,
  CoursePickerSheet,
  FormSheet,
  SheetAction,
} from "../../../components/sheets";
import { Field, PrimaryButton } from "../../../components/ui";

export default function CourseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { courses, updateCourse, deleteCourse } = useApp();
  const db = useSQLiteContext();
  const [notes, setNotes] = useState<Note[]>([]);
  const [showActions, setShowActions] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [moveNote, setMoveNote] = useState<Note | null>(null);

  // Reload on focus so edits made in the Create editor show up on return.
  const loadNotes = useCallback(() => {
    listNotes(db, id)
      .then(setNotes)
      .catch(() => setNotes([]));
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

  const openActions = () => {
    setName(course.name);
    setCode(course.code);
    setShowActions(true);
  };
  const saveRename = async () => {
    if (!name.trim()) return;
    try {
      await updateCourse(id, { name: name.trim(), code });
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

  const tint =
    course.color === "#17B890"
      ? "bg-[#E9FBF6]"
      : course.color === "#F59E0B"
        ? "bg-[#FFF5E5]"
        : "bg-[#F1EEFF]";
  const ink =
    course.color === "#17B890"
      ? "text-[#17B890]"
      : course.color === "#F59E0B"
        ? "text-[#F59E0B]"
        : "text-[#7C5CFC]";
  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Pressable
          onPress={() => router.back()}
          className="mb-7 flex-row items-center gap-2"
        >
          <ArrowLeft size={20} color="#19152C" />
          <Text className="font-bold text-[#19152C]">Courses</Text>
        </Pressable>
        <View className={`rounded-3xl p-5 ${tint}`}>
          <View className="flex-row items-center justify-between">
            <View>
              <Text className={`font-bold ${ink}`}>{course.code}</Text>
              <Text className="mt-1 text-2xl font-black text-[#19152C]">
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
              <MoreHorizontal size={22} color="#19152C" />
            </Pressable>
          </View>
          <Text className="mt-4 text-sm text-[#6E687D]">
            {course.lecturer || "Add lecturer details from course settings"}
          </Text>
        </View>
        <View className="mt-7 flex-row gap-3">
          <View className="flex-1 rounded-2xl bg-white p-4">
            <Text className="text-sm text-[#8A8498]">Notes</Text>
            <Text className="mt-1 text-2xl font-black text-[#19152C]">
              {studyNotes.length}
            </Text>
          </View>
          <View className="flex-1 rounded-2xl bg-white p-4">
            <Text className="text-sm text-[#8A8498]">Study sets</Text>
            <Text className="mt-1 text-2xl font-black text-[#19152C]">0</Text>
          </View>
        </View>
        <View className="mt-8 flex-row items-center justify-between">
          <Text className="text-lg font-extrabold text-[#19152C]">Notes</Text>
          <Pressable
            onPress={() =>
              router.push({
                pathname: "/(app)/(tabs)/create",
                params: { mode: "typing", courseId: id },
              })
            }
            className="min-h-11 flex-row items-center rounded-btn bg-brand px-4 active:opacity-80"
          >
            <Plus size={17} color="#FFBE1A" />
            <Text className="font-bold text-gold">Add note</Text>
          </Pressable>
        </View>
        {studyNotes.length === 0 ? (
          <View className="mt-3 items-center rounded-3xl border border-dashed border-[#CFC7F8] bg-[#F8F6FF] px-6 py-10">
            <FileText size={28} color="#7C5CFC" />
            <Text className="mt-3 text-base font-extrabold text-[#19152C]">No notes yet</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-[#8A8498]">Record, upload, or type your first note. It stays available offline.</Text>
          </View>
        ) : studyNotes.map((note) => (
          <View key={note.id} className="mt-3 flex-row items-stretch overflow-hidden rounded-2xl bg-white">
            <Pressable
              onPress={() =>
                router.push({
                  pathname: "/(app)/note/[id]",
                  params: { id: note.id },
                })
              }
              className="flex-1 p-4 active:opacity-80"
            >
              <Text className="font-extrabold text-[#19152C]">{note.title || "Untitled note"}</Text>
              <Text numberOfLines={2} className="mt-1 text-sm leading-5 text-[#8A8498]">{stripMarkdown(note.body || note.transcript || "") || "Empty note"}</Text>
              <View className="mt-2 flex-row items-center gap-2">
                <Text className="text-xs text-[#17B890]">{note.syncState === "pending" ? "Waiting to sync" : "Synced"}</Text>
                {note.aiState !== "none" && note.aiState !== "ready" && note.aiState !== "failed" ? (
                  <Text className="text-xs font-semibold text-[#7C5CFC]">AI working…</Text>
                ) : note.aiState === "ready" ? (
                  <Text className="text-xs font-semibold text-[#7C5CFC]">AI ready</Text>
                ) : note.aiState === "failed" ? (
                  <Text className="text-xs font-semibold text-[#D64545]">AI failed</Text>
                ) : null}
              </View>
            </Pressable>
            <Pressable
              onPress={() => setMoveNote(note)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Move ${note.title || "note"} to another course`}
              className="w-12 items-center justify-center border-l border-[#F0EDF9] active:opacity-80"
            >
              <ArrowRightLeft size={17} color="#7C5CFC" />
            </Pressable>
            <Pressable
              onPress={() => confirmDeleteNote(note)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${note.title || "note"}`}
              className="w-12 items-center justify-center border-l border-[#F0EDF9] active:opacity-80"
            >
              <Trash2 size={17} color="#D64545" />
            </Pressable>
          </View>
        ))}

        {references.length ? (
          <View className="mt-8">
            <Text className="text-lg font-extrabold text-[#19152C]">Reference</Text>
            <Text className="mt-0.5 text-sm text-[#8A8498]">
              Condensed key points from your uploaded slides and photos.
            </Text>
            {references.map((note) => (
              <View
                key={note.id}
                className="mt-3 flex-row items-stretch overflow-hidden rounded-2xl border border-[#E5E1F5] bg-[#F3F0FF]"
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
                    <BookOpen size={16} color="#7C5CFC" />
                    <Text className="font-extrabold text-[#19152C]">{note.title || "Untitled reference"}</Text>
                  </View>
                  <Text numberOfLines={3} className="mt-1 text-sm leading-5 text-[#8A8498]">
                    {stripMarkdown(note.body || note.transcript || "") || "Waiting for the AI to summarise this file…"}
                  </Text>
                  {note.aiState !== "none" && note.aiState !== "ready" && note.aiState !== "failed" ? (
                    <Text className="mt-2 text-xs font-semibold text-[#7C5CFC]">AI working…</Text>
                  ) : null}
                </Pressable>
                <Pressable
                  onPress={() => confirmDeleteNote(note)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${note.title || "reference"}`}
                  className="w-12 items-center justify-center border-l border-[#E5E1F5] active:opacity-80"
                >
                  <Trash2 size={17} color="#D64545" />
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
      <BottomSheet
        visible={showActions}
        onClose={() => setShowActions(false)}
        title={course.name}
        subtitle="Course actions"
      >
        <SheetAction
          icon={<Pencil size={18} color="#7C5CFC" />}
          label="Rename"
          onPress={() => {
            setShowActions(false);
            setRenaming(true);
          }}
        />
        <SheetAction
          icon={<Archive size={18} color="#7C5CFC" />}
          label={course.archived ? "Restore" : "Archive"}
          onPress={toggleArchive}
        />
        <SheetAction
          icon={<Trash2 size={18} color="#D94A4A" />}
          label="Delete"
          danger
          onPress={confirmDelete}
        />
        <SheetAction
          icon={<ArrowLeft size={18} color="#8A8498" />}
          label="Cancel"
          onPress={() => setShowActions(false)}
        />
      </BottomSheet>
      <CoursePickerSheet
        visible={!!moveNote}
        courses={courses}
        currentCourseId={moveNote?.courseId}
        heading="Move note to"
        onSelect={move}
        onClose={() => setMoveNote(null)}
      />
      <FormSheet
        visible={renaming}
        onClose={() => setRenaming(false)}
        title="Rename course"
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
        <PrimaryButton onPress={saveRename}>Save changes</PrimaryButton>
      </FormSheet>
    </SafeAreaView>
  );
}
