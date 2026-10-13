import { Tabs } from "expo-router";
import { BookOpen, Home, Plus, Sparkles, UserRound } from "lucide-react-native";

export default function TabsLayout() {
  return <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: "#7C5CFC", tabBarInactiveTintColor: "#A9A4B8", tabBarLabelStyle: { fontSize: 11, fontWeight: "700" }, tabBarStyle: { height: 78, paddingTop: 8, paddingBottom: 12, borderTopColor: "#EEEAF5", backgroundColor: "#FFFFFF" } }}>
    <Tabs.Screen name="home" options={{ title: "Home", tabBarIcon: ({ color }) => <Home size={21} color={color} /> }} />
    <Tabs.Screen name="courses" options={{ title: "Courses", tabBarIcon: ({ color }) => <BookOpen size={21} color={color} /> }} />
    <Tabs.Screen name="create" options={{ title: "Create", tabBarIcon: ({ color }) => <Plus size={24} color={color} /> }} />
    <Tabs.Screen name="study" options={{ title: "Study", tabBarIcon: ({ color }) => <Sparkles size={21} color={color} /> }} />
    <Tabs.Screen name="profile" options={{ title: "Profile", tabBarIcon: ({ color }) => <UserRound size={21} color={color} /> }} />
  </Tabs>;
}
