import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ArrowLeft, Check, ChevronDown, Trash2 } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSQLiteContext } from "expo-sqlite";
import { deleteNote, getNote, saveNote } from "../../../lib/notes";
import { CoursePickerSheet } from "../../../components/sheets";
import { useApp } from "../../../state/AppContext";

export default function NoteEditor() {
  const db = useSQLiteContext();
  const { courses } = useApp();
  const params = useLocalSearchParams<{ id: string; courseId?: string }>();
  const isNew = params.id === "new";
  const [courseId, setCourseId] = useState(params.courseId ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [noteId] = useState(() => (isNew ? `note-${Date.now()}` : params.id));
  const [ready, setReady] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pickingCourse, setPickingCourse] = useState(false);
  const courseName = useMemo(
    () => courses.find((course) => course.id === courseId)?.name ?? "Course",
    [courseId, courses],
  );

  useEffect(() => {
    if (isNew) return;
    getNote(db, params.id).then((note) => {
      if (note) {
        setTitle(note.title);
        setBody(note.body);
        setCourseId(note.courseId);
      }
      setReady(true);
    });
  }, [db, isNew, params.id]);

  useEffect(() => {
    if (!ready || (!title.trim() && !body.trim())) return;
    const timer = setTimeout(async () => {
      setSaving(true);
      await saveNote(db, {
        id: noteId,
        courseId,
        title: title.trim() || "Untitled note",
        body,
        sourceType: "typed",
      });
      setSaving(false);
      setSavedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    }, 700);
    return () => clearTimeout(timer);
  }, [body, courseId, db, noteId, ready, title]);

  const remove = async () => {
    if (!isNew) await deleteNote(db, noteId);
    router.back();
  };

  if (!ready) return <ActivityIndicator className="flex-1" />;
  return (
    <SafeAreaView className="flex-1 bg-cream">
      <View className="flex-row items-center justify-between border-b border-[#E9E5F2] px-5 py-3">
        <View className="flex-row items-center gap-2">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <ArrowLeft size={20} color="#19152C" />
          </Pressable>
          <Pressable
            onPress={() => setPickingCourse(true)}
            accessibilityRole="button"
            accessibilityLabel={`Course: ${courseName}. Tap to move this note`}
            className="flex-row items-center gap-1 rounded-chip border border-[#E9E5F2] bg-white px-3 py-1.5 active:opacity-80"
          >
            <Text className="max-w-40 text-xs font-bold text-[#19152C]" numberOfLines={1}>
              {courseName}
            </Text>
            <ChevronDown size={14} color="#7C5CFC" />
          </Pressable>
        </View>
        <View className="flex-row items-center gap-3">
          <Text className="text-xs text-[#8A8498]">
            {saving ? "Saving…" : savedAt ? `Saved ${savedAt}` : "Offline note"}
          </Text>
          <Check size={18} color="#17B890" />
          <Pressable onPress={remove} hitSlop={10}>
            <Trash2 size={19} color="#D94A4A" />
          </Pressable>
        </View>
      </View>
      <View className="flex-1 px-5 pt-6">
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Note title"
          placeholderTextColor="#A9A4B8"
          className="text-3xl font-black text-[#19152C]"
          accessibilityLabel="Note title"
        />
        <TextInput
          value={body}
          onChangeText={setBody}
          placeholder="Start writing…\n\nYour changes are saved on this device and queued to sync when you reconnect."
          placeholderTextColor="#A9A4B8"
          multiline
          textAlignVertical="top"
          className="mt-5 flex-1 text-base leading-7 text-[#3C374A]"
          accessibilityLabel="Note body"
        />
      </View>
      <CoursePickerSheet
        visible={pickingCourse}
        courses={courses}
        currentCourseId={courseId}
        heading="Move note to"
        onSelect={(targetId) => {
          setPickingCourse(false);
          if (targetId !== courseId) setCourseId(targetId);
        }}
        onClose={() => setPickingCourse(false)}
      />
    </SafeAreaView>
  );
}
