import "../../global.css";
import { Stack } from "expo-router";
import { ClerkProvider } from "@clerk/expo";
import { useEffect } from "react";
import { Text, View } from "react-native";
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

// Inlined at build time by Expo. Read once at module scope: the provider needs
// it as a prop, and re-reading `process.env` on every render buys nothing.
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * A missing publishable key used to throw during render, which in a release
 * build is an unrecoverable white screen with no hint. Clerk cannot mount
 * without the key, so show the reason instead. Deliberately provider-free:
 * nothing below can render without Clerk, and the appearance preference has
 * not been read yet, so the default (light) tokens are the correct fallback.
 */
function MissingClerkKey() {
  // Nothing else can hide the splash on this path (AppearanceProvider does it
  // once it mounts), and the splash would cover the explanation forever.
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => {});
  }, []);
  return (
    <View className="flex-1 items-center justify-center gap-3 bg-cream px-6">
      <Text className="text-xl font-black text-ink">Sua cannot start</Text>
      <Text className="text-center text-base text-ink-soft">
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing. Add it to the app
        environment and rebuild.
      </Text>
    </View>
  );
}

export default function RootLayout() {
  if (!publishableKey) return <MissingClerkKey />;
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
