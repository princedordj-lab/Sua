import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Mic,
  RefreshCw,
  Sparkles,
} from "lucide-react-native";
import {
  getSetting,
  listUploadHistory,
  setSetting,
  updateUploadState,
  type UploadQueueItem,
} from "../../lib/notes";
import { flushUploads } from "../../lib/uploads";
import { ProgressBar } from "../../components/progress-bar";
import { WifiToggle } from "../../components/wifi-toggle";
import { jobsApi } from "../../lib/api";
import { colors } from "../../config/theme";
import { usePalette } from "../../state/appearance";
import { useApp } from "../../state/AppContext";

function kindIcon(item: UploadQueueItem, size = 16) {
  if (item.kind === "image") return <ImageIcon size={size} color={colors.brand.DEFAULT} />;
  if (item.kind === "audio") return <Mic size={size} color={colors.brand.DEFAULT} />;
  return <FileText size={size} color={colors.brand.DEFAULT} />;
}

function stateLabel(item: UploadQueueItem) {
  if (item.state === "uploading") return "Uploading";
  if (item.state === "failed") return "Failed";
  if (item.state === "uploaded") return "Uploaded";
  return "Queued";
}

function baseName(path: string) {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export default function Uploads() {
  const pv = usePalette();
  const db = useSQLiteContext();
  const { getAuthToken } = useApp();
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const [jobs, setJobs] = useState<Record<string, string>>({});
  const [wifiOnly, setWifiOnlyPref] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const rows = await listUploadHistory(db).catch(() => [] as UploadQueueItem[]);
    setItems(rows);
    setWifiOnlyPref((await getSetting(db, "wifi_only")) !== "0");
  }, [db]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Live progress while this screen is on top.
  useEffect(() => {
    const token = getAuthToken;
    void flushUploads({
      db,
      getAuthToken: token,
      onProgress: (item) => {
        setItems((current) => {
          const index = current.findIndex((row) => row.id === item.id);
          if (index === -1) return [...current, item];
          const next = [...current];
          next[index] = item;
          return next;
        });
      },
    }).finally(() => void load());
  }, [db, getAuthToken, load]);

  // Generation status for uploaded reference/lecture-note targets.
  const doneNoteIds = useMemo(
    () =>
      [...new Set(
        items
          .filter((item) => item.state === "uploaded" && item.target)
          .map((item) => item.noteId),
      )],
    [items],
  );
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (!doneNoteIds.length) {
        setJobs((current) => (Object.keys(current).length ? {} : current));
        return;
      }
      const authToken = await getAuthToken();
      if (!authToken) return;
      try {
        const results = await Promise.all(
          doneNoteIds.map(async (noteId) => {
            const job = await jobsApi
              .latestForNote(authToken, noteId)
              .catch(() => null);
            return [noteId, job?.state ?? ""] as const;
          }),
        );
        if (cancelled) return;
        setJobs(Object.fromEntries(results.filter(([, state]) => state)));
      } catch {
        // Status refresh is best-effort; the rows still show correctly without it.
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [doneNoteIds, getAuthToken]);

  const retry = async (item: UploadQueueItem) => {
    await updateUploadState(db, item.id, {
      state: "pending",
      error: null,
      resetAttempts: true,
    });
    await load();
    void flushUploads({ db, getAuthToken }).finally(() => void load());
  };

  const toggleWifi = async (next: boolean) => {
    setWifiOnlyPref(next);
    await setSetting(db, "wifi_only", next ? "1" : "0");
  };

  const active = useMemo(
    () => items.filter((item) => item.state !== "uploaded"),
    [items],
  );
  const finished = useMemo(
    () => items.filter((item) => item.state === "uploaded"),
    [items],
  );

  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    await load().catch(() => {});
    setRefreshing(false);
  }, [load]);

  const rows = (list: UploadQueueItem[], section: "active" | "done") =>
    list.map((item) => (
      <View
        key={`${section}-${item.id}`}
        className="gap-2 rounded-input bg-cream p-3"
      >
        <View className="flex-row items-center gap-3">
          <View className="h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft">
            {kindIcon(item)}
          </View>
          <View className="flex-1">
            <Text numberOfLines={1} className="text-body font-sans-bold text-ink">
              {baseName(item.localPath)}
            </Text>
            <Text
              numberOfLines={2}
              className={`text-caption ${
                item.state === "failed" ? "text-danger" : "text-ink-soft"
              }`}
            >
              {stateLabel(item)}
              {item.state === "failed" && item.error ? ` — ${item.error}` : ""}
            </Text>
          </View>
          {item.state === "failed" ? (
            <Pressable
              onPress={() => retry(item)}
              accessibilityRole="button"
              accessibilityLabel={`Retry upload of ${baseName(item.localPath)}`}
              className="min-h-9 flex-row items-center justify-center rounded-btn border border-brand px-3 active:opacity-80"
            >
              <RefreshCw size={14} color={colors.brand.DEFAULT} />
              <Text className="ml-1.5 text-caption font-sans-bold text-brand">Retry</Text>
            </Pressable>
          ) : null}
        </View>
        {item.state === "uploading" ? (
          <ProgressBar progress={item.progress} showPercent />
        ) : null}
        {item.state !== "failed" && item.target ? (
          <View className="flex-row items-center gap-1.5">
            {item.target === "course_reference" ? (
              <BookOpen size={13} color={colors.brand.DEFAULT} />
            ) : (
              <Sparkles size={13} color={colors.brand.DEFAULT} />
            )}
            <Text className="text-caption text-ink-soft">
              {item.target === "course_reference"
                ? "Course reference"
                : "Lecture note"}
              {item.state === "uploaded"
                ? jobs[item.noteId] === "done"
                  ? " — AI ready"
                  : jobs[item.noteId] === "failed"
                    ? " — AI failed"
                    : " — AI generating"
                : ""}
            </Text>
          </View>
        ) : null}
      </View>
    ));

  return (
    <SafeAreaView className="flex-1 bg-cream">
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} />
        }
      >
        <View className="flex-row items-center gap-2 py-3">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="h-10 w-10 items-center justify-center rounded-full bg-surface active:opacity-80"
          >
            <ArrowLeft size={20} color={pv.ink.DEFAULT} />
          </Pressable>
          <View className="flex-1 items-center">
            <Text className="text-body-lg font-sans-extrabold text-ink">Uploads</Text>
          </View>
          <View className="h-10 w-10" />
        </View>

        <View className="mt-2 flex-row items-center justify-between rounded-card bg-surface p-card shadow-card">
          <Text className="text-body font-sans-semibold text-ink">Upload settings</Text>
          <WifiToggle value={wifiOnly} onChange={toggleWifi} />
        </View>

        {active.length ? (
          <View className="mt-4 gap-3 rounded-card bg-surface p-card shadow-card">
            <Text className="text-caption font-sans-extrabold text-ink-soft">
              UPLOAD NOW
            </Text>
            {rows(active, "active")}
          </View>
        ) : null}

        {finished.length ? (
          <View className="mt-4 gap-3 rounded-card bg-surface p-card shadow-card">
            <Text className="text-caption font-sans-extrabold text-ink-soft">
              COMPLETED
            </Text>
            {rows(finished, "done")}
          </View>
        ) : null}

        {!active.length && !finished.length ? (
          <View className="mt-10 items-center gap-2">
            <CheckCircle2 size={28} color={colors.brand.DEFAULT} />
            <Text className="text-body font-sans-bold text-ink">No uploads here</Text>
            <Text className="mt-0.5 text-center text-small leading-5 text-ink-soft">
              Files you add in Create queue up here and upload on Wi-Fi or data,
              depending on your setting.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
