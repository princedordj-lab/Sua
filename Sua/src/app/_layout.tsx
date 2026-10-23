import "../../global.css";
import { Stack } from "expo-router";
import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "../lib/tokenCache";
import { AppProvider } from "../state/AppContext";
import { AppearanceProvider } from "../state/appearance";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SQLiteProvider, type SQLiteDatabase } from "expo-sqlite";
import { migrateDb } from "../lib/notes";

async function initializeDatabase(db: SQLiteDatabase) {
  await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  await migrateDb(db);
}

export default function RootLayout() {
  const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) {
    throw new Error("Add EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY to the app environment.");
  }
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <SafeAreaProvider>
        <SQLiteProvider databaseName="sua.db" onInit={initializeDatabase}>
          <AppProvider>
            <AppearanceProvider>
              <Stack screenOptions={{ headerShown: false }} />
            </AppearanceProvider>
          </AppProvider>
        </SQLiteProvider>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
