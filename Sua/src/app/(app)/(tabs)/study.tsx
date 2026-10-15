import { Pressable, ScrollView, Text, View} from "react-native";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Sparkles,
} from "lucide-react-native";
import { SectionHeader } from "../../../components/ui";
import { SafeAreaView } from "react-native-safe-area-context";
export default function Study() {
  return (
      <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Text className="text-sm font-semibold text-[#8A8498]">
          Your learning loop
        </Text>
        <Text className="mt-1 text-3xl font-black text-[#19152C]">Study</Text>
        <View className="mt-6 rounded-card bg-brand p-5">
          <View className="flex-row items-center gap-2">
            <Sparkles size={18} color="#FFBE1A" />
            <Text className="font-bold text-gold">DAILY REVIEW</Text>
          </View>
          <Text className="mt-3 text-2xl font-black text-white">
            18 cards are ready.
          </Text>
          <Text className="mt-2 leading-5 text-white/85">
            A focused 15 minutes now keeps your memory fresh.
          </Text>
          <Pressable className="mt-5 min-h-12 items-center justify-center rounded-btn border border-gold bg-brand-light px-5 active:opacity-80">
            <Text className="font-extrabold text-gold">Start review</Text>
          </Pressable>
        </View>
        <View className="mt-8">
          <SectionHeader title="Study sets" />
          <View className="gap-3">
            <Pressable className="flex-row items-center rounded-2xl bg-white p-4">
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-[#FFF5E5]">
                <Brain size={21} color="#F59E0B" />
              </View>
              <View className="ml-3 flex-1">
                <Text className="font-extrabold text-[#19152C]">
                  Data Structures · Week 4
                </Text>
                <Text className="mt-1 text-sm text-[#8A8498]">
                  18 flashcards · 2 quizzes
                </Text>
              </View>
              <ChevronRight size={19} color="#A9A4B8" />
            </Pressable>
            <Pressable className="flex-row items-center rounded-2xl bg-white p-4">
              <View className="h-11 w-11 items-center justify-center rounded-xl bg-[#E9FBF6]">
                <CheckCircle2 size={21} color="#17B890" />
              </View>
              <View className="ml-3 flex-1">
                <Text className="font-extrabold text-[#19152C]">
                  Completed this week
                </Text>
                <Text className="mt-1 text-sm text-[#8A8498]">
                  42 cards · 86% recall
                </Text>
              </View>
              <Clock3 size={18} color="#A9A4B8" />
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
