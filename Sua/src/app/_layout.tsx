import "../../global.css";
import { Stack } from "expo-router";
import { AppProvider } from "../state/AppContext";

export default function RootLayout() {
  return <AppProvider><Stack screenOptions={{ headerShown: false }} /></AppProvider>;
}
