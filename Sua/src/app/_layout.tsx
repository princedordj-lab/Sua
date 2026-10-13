import "../../global.css";
import { Stack } from "expo-router";
import { AppProvider } from "../state/AppContext";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SQLiteProvider } from "expo-sqlite";
import { migrateDb } from "../lib/notes";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName="sua.db" onInit={migrateDb}>
        <AppProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </AppProvider>
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}
