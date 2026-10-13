import { Pressable, ScrollView, Text, View } from "react-native";
import { BookOpen, FileUp, Mic, PenLine } from "lucide-react-native";
import { SectionHeader } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import { useApp } from "../../../state/AppContext";

const actions = [
  {
    title: "Record a lecture",
    body: "Capture audio and get a clear summary later.",
    icon: Mic,
    color: "bg-[#F1EEFF]",
    iconColor: "#7C5CFC",
  },
  {
    title: "Upload a file",
    body: "Bring in slides, PDFs, or a photo of the board.",
    icon: FileUp,
    color: "bg-[#E9FBF6]",
    iconColor: "#17B890",
  },
  {
    title: "Type a note",
    body: "Start with an idea, a question, or a quick recap.",
    icon: PenLine,
    color: "bg-[#FFF5E5]",
    iconColor: "#F59E0B",
  },
];
export default function Create() {
  const { courses } = useApp();
  const openTypedNote = () => {
    const courseId = courses[0]?.id;
    if (courseId) router.push({ pathname: "/note/[id]" as never, params: { id: "new", courseId } });
  };
  return (
    <SafeAreaView className="flex-1 bg-[#FCFBFF]">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Text className="text-sm font-semibold text-[#8A8498]">
          Make something useful
        </Text>
        <Text className="mt-1 text-3xl font-black text-[#19152C]">Create</Text>
        <Text className="mt-3 text-base leading-6 text-[#6E687D]">
          Sua does the heavy lifting. Choose how you want to bring your next
          lesson in.
        </Text>
        <View className="mt-7 gap-3">
          {actions.map(({ title, body, icon: Icon, color, iconColor }) => (
            <Pressable
              key={title}
              onPress={title === "Type a note" ? openTypedNote : undefined}
              className="flex-row items-center rounded-3xl bg-white p-5"
            >
              <View
                className={`h-14 w-14 items-center justify-center rounded-2xl ${color}`}
              >
                <Icon size={24} color={iconColor} />
              </View>
              <View className="ml-4 flex-1">
                <Text className="text-base font-extrabold text-[#19152C]">
                  {title}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-[#8A8498]">
                  {body}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
        <View className="mt-8">
          <SectionHeader title="Recent notes" />
          <View className="items-center rounded-3xl border border-[#E9E5F2] bg-white px-6 py-10">
            <View className="h-14 w-14 items-center justify-center rounded-2xl bg-[#F1EEFF]">
              <BookOpen size={25} color="#7C5CFC" />
            </View>
            <Text className="mt-4 text-lg font-extrabold text-[#19152C]">
              Your notes will live here
            </Text>
            <Text className="mt-2 text-center text-sm leading-5 text-[#8A8498]">
              Create your first note and Sua will turn it into study material.
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
