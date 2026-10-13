import { Redirect, Stack } from "expo-router";
import { useApp } from "../../state/AppContext";

export default function AppLayout() {
  const { isSignedIn, hasCompletedOnboarding } = useApp();
  if (!isSignedIn) return <Redirect href="/welcome" />;
  if (!hasCompletedOnboarding) return <Redirect href="/setup" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
