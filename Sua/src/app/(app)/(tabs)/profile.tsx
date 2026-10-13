import { Alert, Pressable, ScrollView, Text, View } from "react-native";
import {
  ChevronRight,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react-native";
import { router } from "expo-router";
import { useApp } from "../../../state/AppContext";
import { SafeAreaView } from "react-native-safe-area-context";
export default function Profile() {
  const { profile, signOut } = useApp();
  const leave = () =>
    Alert.alert("Sign out?", "You can sign back in anytime.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          void signOut().finally(() => router.replace("/welcome"));
        },
      },
    ]);
  return (
      <SafeAreaView className="flex-1 bg-cream">
      <ScrollView contentContainerClassName="px-5 pb-8 pt-6">
        <Text className="text-3xl font-black text-[#19152C]">Profile</Text>
        <View className="mt-6 flex-row items-center rounded-3xl bg-white p-5">
          <View className="h-16 w-16 items-center justify-center rounded-full bg-[#EAE5FF]">
            <Text className="text-2xl font-black text-[#7C5CFC]">
              {profile?.name?.charAt(0).toUpperCase() ?? "S"}
            </Text>
          </View>
          <View className="ml-4 flex-1">
            <Text className="text-lg font-extrabold text-[#19152C]">
              {profile?.name ?? "Sua student"}
            </Text>
            <Text className="mt-1 text-sm text-[#8A8498]">
              {profile?.email ?? "student@sua.app"}
            </Text>
          </View>
          <ChevronRight size={19} color="#A9A4B8" />
        </View>
        <View className="mt-7 gap-3">
          <Pressable className="flex-row items-center rounded-2xl bg-white p-4">
            <UserRound size={19} color="#7C5CFC" />
            <Text className="ml-3 flex-1 font-bold text-[#393442]">
              Account details
            </Text>
            <ChevronRight size={18} color="#A9A4B8" />
          </Pressable>
          <Pressable className="flex-row items-center rounded-2xl bg-white p-4">
            <ShieldCheck size={19} color="#17B890" />
            <Text className="ml-3 flex-1 font-bold text-[#393442]">
              Privacy & security
            </Text>
            <ChevronRight size={18} color="#A9A4B8" />
          </Pressable>
          <Pressable
            onPress={leave}
            className="flex-row items-center rounded-2xl bg-white p-4"
          >
            <LogOut size={19} color="#D94A4A" />
            <Text className="ml-3 font-bold text-[#D94A4A]">Sign out</Text>
          </Pressable>
        </View>
        <View className="mt-8 rounded-3xl bg-[#19152C] p-5">
          <Text className="font-extrabold text-white">Sua Pro</Text>
          <Text className="mt-1 text-sm leading-5 text-[#BDB6D3]">
            Unlimited study sets, Exam Mode, and faster AI help.
          </Text>
          <Pressable className="mt-4 self-start rounded-xl bg-white px-4 py-3">
            <Text className="font-bold text-[#6045D8]">Explore plans</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
