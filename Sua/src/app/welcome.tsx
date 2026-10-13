import { Image, Pressable, SafeAreaView, Text, View } from "react-native";
import { router } from "expo-router";
import { ArrowRight, Sparkles } from "lucide-react-native";
import { Logo, PrimaryButton } from "../components/ui";

export default function Welcome() {
  return <SafeAreaView className="flex-1 bg-[#FCFBFF]" style={{ flex: 1 }}>
    <View className="flex-1 px-6 pt-5">
      <Logo />
      <View className="flex-1 justify-center">
        <View className="mb-8 h-72 overflow-hidden rounded-[32px] bg-[#EEE9FF]"><Image source={require("../../assets/images/screens/welcome2.png")} className="h-full w-full" resizeMode="cover" /></View>
        <View className="mb-3 flex-row items-center gap-2"><Sparkles size={18} color="#7C5CFC" /><Text className="font-bold text-[#7C5CFC]">Study smarter, every day</Text></View>
        <Text className="text-[40px] font-black leading-[46px] text-[#19152C]">Your notes.{"\n"}Your edge.</Text>
        <Text className="mt-4 text-base leading-6 text-[#6E687D]">Sua turns lectures into clear study plans, flashcards, and quizzes that keep you ready for exam day.</Text>
      </View>
      <View className="gap-3 pb-4"><PrimaryButton onPress={() => router.push("/onboarding")}>Get started <ArrowRight size={16} color="white" /></PrimaryButton><Pressable onPress={() => router.push("/sign-in")} className="items-center py-3"><Text className="font-bold text-[#6045D8]">I already have an account</Text></Pressable></View>
    </View>
  </SafeAreaView>;
}
