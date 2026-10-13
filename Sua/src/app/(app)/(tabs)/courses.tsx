import { useState } from "react";
import { Alert, Modal, Pressable, ScrollView, Text, View } from "react-native";
import {
  Archive,
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react-native";
import { router } from "expo-router";
import { Field, PrimaryButton } from "../../../components/ui";
import { useApp } from "../../../state/AppContext";
import type { Course } from "../../../lib/types";
import { SafeAreaView } from "react-native-safe-area-context";

export default function Courses() {
  const { courses, addCourse, updateCourse, deleteCourse } = useApp();
  const [editing, setEditing] = useState<Course | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const openNew = () => {
    setName("");
    setCode("");
    setShowNew(true);
  };
  const save = () => {
    if (!name.trim()) return;
    if (editing) updateCourse(editing.id, { name, code });
    else
      addCourse({
        name,
        code: code || "COURSE",
        lecturer: "",
        color: "#7C5CFC",
        noteCount: 0,
      });
    setEditing(null);
    setShowNew(false);
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
          onPress: () => deleteCourse(course.id),
        },
      ],
    );
  return (
    <SafeAreaView className="flex-1 bg-[#FCFBFF]">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <View className="flex-row items-end justify-between">
          <View>
            <Text className="text-sm font-semibold text-[#8A8498]">
              Your library
            </Text>
            <Text className="mt-1 text-3xl font-black text-[#19152C]">
              Courses
            </Text>
          </View>
          <Pressable
            onPress={openNew}
            className="h-12 w-12 items-center justify-center rounded-2xl bg-[#7C5CFC]"
          >
            <Plus color="white" size={22} />
          </Pressable>
        </View>
        <Text className="mb-6 mt-3 text-base text-[#6E687D]">
          Keep every note, deck, and quiz in one place.
        </Text>
        <View className="gap-3">
          {courses.map((course) => {
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
              <View key={course.id} className="rounded-3xl bg-white p-4">
                <Pressable
                  onPress={() => router.push(`/course/${course.id}`)}
                  className="flex-row items-center"
                >
                  <View
                    className={`h-12 w-12 items-center justify-center rounded-2xl ${tint}`}
                  >
                    <Text className={`font-black ${ink}`}>
                      {course.code.slice(0, 2)}
                    </Text>
                  </View>
                  <View className="ml-3 flex-1">
                    <Text className="font-extrabold text-[#19152C]">
                      {course.name}
                    </Text>
                    <Text className="mt-1 text-sm text-[#8A8498]">
                      {course.code} · {course.noteCount} notes
                    </Text>
                  </View>
                  <ChevronRight size={20} color="#A9A4B8" />
                </Pressable>
                <View className="mt-4 flex-row gap-2 border-t border-[#F2EFF7] pt-3">
                  <Pressable
                    onPress={() => {
                      setEditing(course);
                      setName(course.name);
                      setCode(course.code);
                    }}
                    className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-[#F8F6FF] py-3"
                  >
                    <Pencil size={15} color="#7C5CFC" />
                    <Text className="text-sm font-bold text-[#6045D8]">
                      Rename
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      updateCourse(course.id, { archived: !course.archived })
                    }
                    className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-[#F8F6FF] py-3"
                  >
                    <Archive size={15} color="#7C5CFC" />
                    <Text className="text-sm font-bold text-[#6045D8]">
                      {course.archived ? "Restore" : "Archive"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => remove(course)}
                    className="w-12 items-center justify-center rounded-xl bg-[#FFF3F3]"
                  >
                    <Trash2 size={15} color="#D94A4A" />
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
        <Pressable
          onPress={openNew}
          className="mt-5 flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-[#CFC7F8] bg-[#F8F6FF] p-5"
        >
          <Plus size={18} color="#7C5CFC" />
          <Text className="font-bold text-[#6045D8]">Add another course</Text>
        </Pressable>
        <Modal
          visible={showNew || !!editing}
          transparent
          animationType="slide"
          onRequestClose={() => {
            setShowNew(false);
            setEditing(null);
          }}
        >
          <View className="flex-1 justify-end bg-black/30">
            <View className="rounded-t-[32px] bg-[#FCFBFF] p-6">
              <View className="mb-6 flex-row items-center justify-between">
                <Text className="text-2xl font-black text-[#19152C]">
                  {editing ? "Rename course" : "New course"}
                </Text>
                <Pressable
                  onPress={() => {
                    setShowNew(false);
                    setEditing(null);
                  }}
                >
                  <MoreHorizontal color="#8A8498" />
                </Pressable>
              </View>
              <View className="gap-4">
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
              </View>
            </View>
          </View>
        </Modal>
      </ScrollView>
    </SafeAreaView>
  );
}
