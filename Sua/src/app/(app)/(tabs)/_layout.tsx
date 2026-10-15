import { Tabs } from "expo-router";
import { BookOpen, Home, Plus, Sparkles, UserRound } from "lucide-react-native";
import { View } from "react-native";
import { colors } from "../../../config/theme";

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brand.DEFAULT,
        tabBarInactiveTintColor: colors.ink.faint,
        tabBarLabelStyle: { fontSize: 12, fontFamily: "PlusJakartaSans_700Bold" },
        tabBarStyle: {
          height: 86,
          paddingTop: 9,
          paddingBottom: 14,
          borderTopWidth: 0,
          backgroundColor: colors.surface,
          elevation: 12,
          shadowColor: colors.ink.DEFAULT,
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.08,
          shadowRadius: 18,
        },
      }}
    >
      <Tabs.Screen
        name="home"
        options={{ title: "Home", tabBarIcon: ({ color }) => <Home size={22} color={color} /> }}
      />
      <Tabs.Screen
        name="courses"
        options={{ title: "Courses", tabBarIcon: ({ color }) => <BookOpen size={22} color={color} /> }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: "",
          tabBarIcon: () => (
            <View className="-mt-7 h-16 w-16 items-center justify-center rounded-full border-4 border-cream bg-gold shadow-gold">
              <Plus size={30} color={colors.ink.DEFAULT} strokeWidth={2.25} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="study"
        options={{ title: "Study", tabBarIcon: ({ color }) => <Sparkles size={22} color={color} /> }}
      />
      <Tabs.Screen
        name="profile"
        options={{ title: "Profile", tabBarIcon: ({ color }) => <UserRound size={22} color={color} /> }}
      />
    </Tabs>
  );
}
