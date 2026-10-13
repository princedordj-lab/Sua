import { useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { Apple, Globe2 } from "lucide-react-native";
import { Field, Logo, PrimaryButton } from "../components/ui";
import { useApp } from "../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SignIn() {
  const { signIn } = useApp();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const submit = () => {
    if (!email || !password)
      return Alert.alert(
        "Almost there",
        "Enter your email and password to continue.",
      );
    signIn(email);
    router.replace("/setup");
  };
  return (
    <SafeAreaView className="flex-1 bg-[#FCFBFF]" style={{ flex: 1 }}>
      <View className="flex-1 px-6 pt-5">
        <Logo />
        <View className="flex-1 justify-center gap-6">
          <View>
            <Text className="text-[34px] font-black text-[#19152C]">
              Welcome back.
            </Text>
            <Text className="mt-2 text-base text-[#6E687D]">
              Sign in to pick up where you left off.
            </Text>
          </View>
          <View className="gap-4">
            <Field
              label="Email address"
              value={email}
              onChangeText={setEmail}
              placeholder="you@university.edu"
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="••••••••"
              secureTextEntry
            />
            <Pressable className="items-end">
              <Text className="font-semibold text-[#7C5CFC]">
                Forgot password?
              </Text>
            </Pressable>
          </View>
          <PrimaryButton onPress={submit}>Sign in</PrimaryButton>
          <View className="flex-row items-center gap-3">
            <View className="h-px flex-1 bg-[#E7E2F0]" />
            <Text className="text-[#9992A8]">or continue with</Text>
            <View className="h-px flex-1 bg-[#E7E2F0]" />
          </View>
          <View className="flex-row gap-3">
            <Pressable
              onPress={() => {
                signIn("google@sua.app", "Google student");
                router.replace("/setup");
              }}
              className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-[#E9E5F2] bg-white"
            >
              <Globe2 size={18} color="#4285F4" />
              <Text className="font-bold text-[#393442]">Google</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                signIn("apple@sua.app", "Apple student");
                router.replace("/setup");
              }}
              className="h-14 flex-1 flex-row items-center justify-center gap-2 rounded-2xl border border-[#E9E5F2] bg-white"
            >
              <Apple size={18} color="#19152C" />
              <Text className="font-bold text-[#393442]">Apple</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
