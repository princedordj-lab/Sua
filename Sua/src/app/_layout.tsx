import "../../global.css";
import { Stack } from "expo-router";
import { ClerkProvider } from "@clerk/expo";
import * as SplashScreen from "expo-splash-screen";
import { tokenCache } from "../lib/tokenCache";
import { AppProvider } from "../state/AppContext";
import { AppearanceProvider } from "../state/appearance";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SQLiteProvider, type SQLiteDatabase } from "expo-sqlite";
import { migrateDb } from "../lib/notes";
import { NotificationObserver } from "../components/notification-observer";

// Hold the splash until the saved appearance preference is read, otherwise a
// dark-mode user sees the light theme painted for a frame on every cold start.
// AppearanceProvider hides it again once the setting has loaded (or failed).
void SplashScreen.preventAutoHideAsync().catch(() => {});

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
              <NotificationObserver />
            </AppearanceProvider>
          </AppProvider>
        </SQLiteProvider>
      </SafeAreaProvider>
    </ClerkProvider>
  );
}
