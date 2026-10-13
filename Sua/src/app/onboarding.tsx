import { useState } from "react";
import { Image, Pressable, SafeAreaView, Text, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { Logo, PrimaryButton } from "../components/ui";

const slides = [
  { title: "Everything you need to ace your next exam.", body: "Record lectures, upload slides, or type notes. Sua makes them easier to understand and revise.", image: require("../../assets/images/screens/Onboarding1.jpeg") },
  { title: "A study plan that knows your deadline.", body: "Tell us when exams are coming and Sua creates a daily plan that fits around real student life.", image: require("../../assets/images/screens/Onboarding2.jpeg") },
  { title: "Your best study partner, offline too.", body: "Review summaries, flashcards, and quizzes wherever you are — even when campus Wi-Fi is not.", image: require("../../assets/images/screens/Onboarding3.jpeg") },
];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const slide = slides[step];
  const next = () => step === slides.length - 1 ? router.push("/sign-in") : setStep(step + 1);
  return <SafeAreaView className="flex-1 bg-[#FCFBFF]" style={{ flex: 1 }}><View className="flex-1 px-6 pt-5"><View className="flex-row items-center justify-between"><Logo compact /><Pressable onPress={() => router.push("/sign-in")}><Text className="font-semibold text-[#7C5CFC]">Skip</Text></Pressable></View><View className="flex-1 justify-center"><Image source={slide.image} className="mb-9 h-72 w-full rounded-[30px]" resizeMode="cover" /><Text className="text-[32px] font-black leading-9 text-[#19152C]">{slide.title}</Text><Text className="mt-4 text-base leading-6 text-[#6E687D]">{slide.body}</Text></View><View className="gap-5 pb-4"><View className="flex-row gap-2">{slides.map((_, index) => <View key={index} className={`h-2 rounded-full ${index === step ? "w-8 bg-[#7C5CFC]" : "w-2 bg-[#D8D2EA]"}`} />)}</View><PrimaryButton onPress={next}>{step === slides.length - 1 ? "Let's set up your space" : "Continue"} <ChevronRight size={16} color="white" /></PrimaryButton><Pressable onPress={() => step > 0 && setStep(step - 1)} className="h-7 items-center">{step > 0 && <View className="flex-row items-center"><ChevronLeft size={15} color="#7C5CFC" /><Text className="font-bold text-[#7C5CFC]">Back</Text></View>}</Pressable></View></View></SafeAreaView>;
}
