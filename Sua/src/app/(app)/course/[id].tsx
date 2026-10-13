import { Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { ArrowLeft, FileText, MoreHorizontal, Plus } from "lucide-react-native";
import { useApp } from "../../../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSQLiteContext } from "expo-sqlite";
import { listNotes, type Note } from "../../../lib/notes";
export default function CourseDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { courses } = useApp();
  const db = useSQLiteContext();
  const [notes, setNotes] = useState<Note[]>([]);
  useEffect(() => {
    listNotes(db, id).then(setNotes);
  }, [db, id]);
  const course = courses.find((item) => item.id === id);
  if (!course)
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-[#FCFBFF]">
        <Text>Course not found.</Text>
      </SafeAreaView>
    );
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
    <SafeAreaView className="flex-1 bg-[#FCFBFF]">
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
            <Pressable>
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
              {notes.length}
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
            onPress={() => router.push({ pathname: "/note/[id]" as never, params: { id: "new", courseId: id } })}
            className="flex-row items-center gap-1"
          >
            <Plus size={17} color="#7C5CFC" />
            <Text className="font-bold text-[#7C5CFC]">Add note</Text>
          </Pressable>
        </View>
        {notes.length === 0 ? (
          <View className="mt-3 items-center rounded-3xl border border-dashed border-[#CFC7F8] bg-[#F8F6FF] px-6 py-10">
            <FileText size={28} color="#7C5CFC" />
            <Text className="mt-3 text-base font-extrabold text-[#19152C]">No notes yet</Text>
            <Text className="mt-2 text-center text-sm leading-5 text-[#8A8498]">Record, upload, or type your first note. It stays available offline.</Text>
          </View>
        ) : notes.map((note) => (
          <Pressable key={note.id} onPress={() => router.push({ pathname: "/note/[id]" as never, params: { id: note.id, courseId: id } })} className="mt-3 rounded-2xl bg-white p-4">
            <Text className="font-extrabold text-[#19152C]">{note.title || "Untitled note"}</Text>
            <Text numberOfLines={2} className="mt-1 text-sm leading-5 text-[#8A8498]">{note.body || "Empty note"}</Text>
            <Text className="mt-2 text-xs text-[#17B890]">{note.syncState === "pending" ? "Waiting to sync" : "Synced"}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}
