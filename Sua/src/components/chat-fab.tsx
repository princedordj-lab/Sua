import { Pressable } from "react-native";
import { useRouter } from "expo-router";
import { MessageCircleMore } from "lucide-react-native";
import { colors, motion } from "../config/theme";

// Floating "Ask Sua" button rendered above every authenticated screen in
// src/app/(app)/_layout.tsx. `bottom` lifts it over the tab bar on tabs and
// sits closer to the edge on stacked screens.
export function ChatFab({ bottom }: { bottom: number }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Ask Sua"
      onPress={() => router.push("/ask-sua")}
      className="absolute right-5 h-14 w-14 items-center justify-center rounded-full bg-gold shadow-gold"
      style={{ bottom, transform: [{ scale: motion.pressScale }] }}
    >
      <MessageCircleMore size={26} color={colors.brand.DEFAULT} strokeWidth={2.25} />
    </Pressable>
  );
}
