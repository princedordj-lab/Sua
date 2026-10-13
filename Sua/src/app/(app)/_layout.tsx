import { Redirect, Stack } from "expo-router";
import { useApp } from "../../state/AppContext";
import { View } from "react-native";
import { Logo } from "../../components/ui";

export default function AppLayout() {
  const { isLoaded, isHydrating, isSignedIn, hasCompletedOnboarding } =
    useApp();
  if (!isLoaded || isHydrating) {
    return (
      <View className="flex-1 items-center justify-center bg-[#FCFBFF]">
        <Logo />
      </View>
    );
  }
  if (!isSignedIn) return <Redirect href="/welcome" />;
  if (!hasCompletedOnboarding) return <Redirect href="/setup" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
