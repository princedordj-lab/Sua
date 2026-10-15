import { useState } from "react";
import { ImageBackground, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { ChevronLeft, ChevronRight } from "lucide-react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Logo, PrimaryButton } from "../components/ui";

const slides = [
  {
    title: "Everything you need to ace your next exam.",
    body: "Record lectures, upload slides, or type notes. Sua makes them easier to understand and revise.",
    image: require("../../assets/images/screens/Onboarding1.jpeg"),
  },
  {
    title: "A study plan that knows your deadline.",
    body: "Tell us when exams are coming and Sua creates a daily plan that fits around real student life.",
    image: require("../../assets/images/screens/Onboarding2.jpeg"),
  },
  {
    title: "Your best study partner, offline too.",
    body: "Review summaries, flashcards, and quizzes wherever you are — even when campus Wi-Fi is not.",
    image: require("../../assets/images/screens/Onboarding3.jpeg"),
  },
];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const slide = slides[step];
  const next = () =>
    step === slides.length - 1 ? router.push("/sign-in") : setStep(step + 1);
  return (
    <SafeAreaView className="flex-1 bg-[#19152C]" style={{ flex: 1 }}>
      <ImageBackground
        source={slide.image}
        className="flex-1"
        resizeMode="cover"
      >
        <View className="absolute inset-0 bg-[#19152C]/65" />
        <View className="flex-1 px-6 pt-5">
          <View className="flex-row items-center justify-between">
            <Logo compact light />
            <Pressable onPress={() => router.push("/sign-in")}>
              <Text className="font-semibold text-white">Skip</Text>
            </Pressable>
          </View>
          <View className="flex-1 justify-end pb-10">
            <Text className="text-[32px] font-black leading-9 text-white">
              {slide.title}
            </Text>
            <Text className="mt-4 text-base leading-6 text-white/85">
              {slide.body}
            </Text>
          </View>
          <View className="gap-5 pb-4">
            <View className="flex-row gap-2">
              {slides.map((_, index) => (
                <View
                  key={index}
                  className={`h-2 rounded-full ${index === step ? "w-8 bg-[#FFBE1A]" : "w-2 bg-white/55"}`}
                />
              ))}
            </View>
            <PrimaryButton onPress={next}>
              {step === slides.length - 1
                ? "Let's set up your space"
                : "Continue"}{" "}
              <ChevronRight size={16} color="#FFBE1A" />
            </PrimaryButton>
            <Pressable
              onPress={() => step > 0 && setStep(step - 1)}
              className="h-7 items-center"
            >
              {step > 0 && (
                <View className="flex-row items-center">
                  <ChevronLeft size={15} color="white" />
                  <Text className="font-bold text-white">Back</Text>
                </View>
              )}
            </Pressable>
          </View>
        </View>
      </ImageBackground>
    </SafeAreaView>
  );
}
