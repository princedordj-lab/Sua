import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSQLiteContext } from "expo-sqlite";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  router,
  useFocusEffect,
  useLocalSearchParams,
} from "expo-router";
import NetInfo from "@react-native-community/netinfo";
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  FileText,
  GraduationCap,
  Lightbulb,
  Mic,
  RefreshCw,
  Send,
  Sparkles,
} from "lucide-react-native";
import { Logo } from "../../components/ui";
import { CoursePickerSheet } from "../../components/sheets";
import { Markdown } from "../../components/markdown";
import { colors } from "../../config/theme";
import { usePalette } from "../../state/appearance";
import { useApp } from "../../state/AppContext";
import { chatApi } from "../../lib/chat";
import {
  ASK_SUA_COARSE_KEY,
  getSetting,
  setSetting,
  listCourseMessages,
  replaceCourseMessages,
  upsertChatMessage,
  type ChatMessageRow,
} from "../../lib/notes";
import { useChatMic } from "../../lib/use-chat-mic";
import type {
  ChatMessageView,
  ChatQuickAction,
} from "../../lib/types";

const QUICK_ACTIONS = [
  { key: "explain_simply", label: "Explain simply", Icon: Sparkles },
  { key: "give_example", label: "Give an example", Icon: Lightbulb },
  { key: "quiz_me", label: "Quiz me on this", Icon: GraduationCap },
] as const satisfies readonly { key: ChatQuickAction; label: string; Icon: typeof Sparkles }[];

// Bubble layout mirrors the mock: student bubbles right, Sua bubbles left.

function toRow(message: ChatMessageView): ChatMessageRow {
  return {
    id: message.id,
    courseId: message.courseId,
    role: message.role,
    content: message.content,
    sourceNoteIds: message.sourceNoteIds,
    createdAt: message.createdAt,
  };
}

export default function AskSua() {
  const pv = usePalette();
  const params = useLocalSearchParams<{ courseId?: string }>();
  const { courses, getAuthToken } = useApp();
  const db = useSQLiteContext();

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  const [messages, setMessages] = useState<ChatMessageRow[]>([]);
  const [pickedCourseId, setPickedCourseId] = useState<string | null>(null);
  const [routeCourseSelection, setRouteCourseSelection] = useState<{
    routeCourseId?: string;
    selectedCourseId: string;
  } | null>(null);
  const [sourceTitles, setSourceTitles] = useState<Map<string, string>>(new Map());

  const listRef = useRef<FlatList<ChatMessageRow>>(null);
  const draftRef = useRef("");
  const courseInitializedRef = useRef(false);

  // Route param wins on open (future "Ask about this course" entry points),
  // otherwise continue the last-used conversation.
  const courseSignature = courses.map((course) => course.id).join(",");
  const firstCourseId = courses[0]?.id ?? "";

  useEffect(() => {
    if (params.courseId || courseInitializedRef.current || !firstCourseId) return;

    let active = true;
    void getSetting(db, ASK_SUA_COARSE_KEY).then((remembered) => {
      if (!active || courseInitializedRef.current) return;
      const knownCourseIds = courseSignature.split(",");
      setPickedCourseId(
        remembered && knownCourseIds.includes(remembered)
          ? remembered
          : firstCourseId,
      );
      courseInitializedRef.current = true;
    }).catch(() => {
      if (!active || courseInitializedRef.current) return;
      setPickedCourseId(firstCourseId);
      courseInitializedRef.current = true;
    });
    return () => {
      active = false;
    };
  }, [courseSignature, db, firstCourseId, params.courseId]);

  const courseId =
    routeCourseSelection &&
    routeCourseSelection.routeCourseId === params.courseId
      ? routeCourseSelection.selectedCourseId
      : params.courseId ?? pickedCourseId ?? "";
  const course = useMemo(
    () => courses.find((item) => item.id === courseId),
    [courses, courseId],
  );

  // Cached history paints first; a fetch replaces it when online.
  const loadHistory = useCallback(async () => {
    if (!courseId) return;
    try {
      const cached = await listCourseMessages(db, courseId);
      setMessages(cached);
    } catch {
      // Cache miss is fine; the fetch below fills the screen.
    }
    const state = await NetInfo.fetch();
    const connected = Boolean(state.isConnected);
    setOffline(!connected);
    if (!connected) return;
    const token = await getAuthToken();
    if (!token) return;
    try {
      const { messages: fresh } = await chatApi.messages(token, courseId);
      const rows = fresh.map(toRow);
      setMessages(rows);
      await replaceCourseMessages(db, courseId, rows);
      await setSetting(db, ASK_SUA_COARSE_KEY, courseId);
    } catch {
      // Keep the cached transcript visible; asking will retry.
    }
  }, [courseId, db, getAuthToken]);

  // Cached history paints first (effect only touches external systems after
  // its first await), then a server refresh replaces the cache when online.
  useFocusEffect(
    useCallback(() => {
      if (!courseId) return;
      void loadHistory();
    }, [courseId, loadHistory]),
  );

  const ask = useCallback(
    async (question: string, quickAction?: ChatQuickAction) => {
      const trimmed = question.trim();
      if (!trimmed || asking || !courseId) return;
      setAskError(null);
      setAsking(true);
      setPendingId(`pending:${Date.now()}`);
      draftRef.current = "";
      setDraft("");
      const tempRow: ChatMessageRow = {
        id: `local:${Date.now()}`,
        courseId,
        role: "user",
        content: trimmed,
        sourceNoteIds: [],
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempRow]);
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("Not signed in");
        const result = await chatApi.ask(token, {
          courseId,
          question: trimmed,
          quickAction,
        });
        setMessages((prev) =>
          prev
            .filter((message) => message.id !== tempRow.id)
            .concat(toRow(result.user), toRow(result.assistant)),
        );
        if (result.sources.length) {
          setSourceTitles((prev) => {
            const next = new Map(prev);
            for (const source of result.sources) next.set(source.id, source.title);
            return next;
          });
        }
        await Promise.all([
          upsertChatMessage(db, toRow(result.user)),
          upsertChatMessage(db, toRow(result.assistant)),
        ]);
        await setSetting(db, ASK_SUA_COARSE_KEY, courseId);
      } catch (error) {
        setMessages((prev) => prev.filter((message) => message.id !== tempRow.id));
        await upsertChatMessage(db, tempRow);
        draftRef.current = trimmed;
        setDraft(trimmed);
        setAskError(
          error instanceof Error ? error.message : "Ask Sua is unreachable right now.",
        );
      } finally {
        setAsking(false);
        setPendingId(null);
      }
    },
    [asking, courseId, db, getAuthToken],
  );

  const mic = useChatMic({
    getToken: getAuthToken,
    onTranscribed: (text) => void ask(text),
  });

  const send = useCallback(() => {
    void ask(draftRef.current);
  }, [ask]);

  const canSend = Boolean(
    draft.trim().length > 0 &&
      !asking &&
      courseId &&
      !mic.micState.startsWith("recor"),
  );
  const hasAsked = messages.some((message) => message.role === "assistant");

  // Inverted list: index 0 paints at the visual bottom, so reverse the order
  // and drop the thinking row in as the newest item while a request runs.
  const displayItems = useMemo(() => {
    const items = [...messages].reverse();
    if (asking) {
      items.unshift({
        id: "pending",
        courseId,
        role: "assistant",
        content: "",
        sourceNoteIds: [],
        createdAt: "",
      });
    }
    return items;
  }, [asking, courseId, messages]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessageRow }) => (
      <View className={item.role === "user" ? "items-end" : "flex-row items-end gap-2"}>
        {item.role === "assistant" ? (
          <View className="h-10 w-10 items-center justify-center rounded-full bg-brand-strong">
            <Text className="text-title font-sans-extrabold text-gold">S</Text>
          </View>
        ) : null}
        {item.id === "pending" ? (
          <View className="rounded-input bg-surface px-4 py-3 shadow-card">
            <Text className="text-body text-ink-soft">Thinking…</Text>
          </View>
        ) : (
        <View
          className={`max-w-[78%] px-4 py-3 ${
            item.role === "user"
              ? "rounded-input bg-brand-strong"
              : "rounded-input bg-surface shadow-card"
          }`}
        >
          {item.role === "user" ? (
            <Text className="text-body text-white">{item.content}</Text>
          ) : (
            <Markdown text={item.content} className="text-body leading-6 text-ink" />
          )}
        </View>
        )}
        {item.role === "assistant" && item.id !== "pending" ? (
          <View className="flex-1 items-start gap-2 pl-12 pt-2">
            {item.sourceNoteIds.slice(0, 2).map((sourceId) => {
              const label = sourceTitles.get(sourceId) ?? "your notes";
              return (
                <Pressable
                  key={sourceId}
                  accessibilityRole="button"
                  accessibilityLabel={`Open source: ${label}`}
                  onPress={() =>
                    router.push("/courses")
                  }
                  className="flex-row items-center gap-2 rounded-chip bg-success-soft px-3 py-2"
                >
                  <FileText size={16} color={colors.brand.DEFAULT} />
                  <Text className="text-small font-sans-medium text-brand">
                    From: {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    ),
    [sourceTitles],
  );

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1"
      >
        {/* Header */}
        <View className="flex-row items-center gap-2 px-5 pt-2">
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            className="h-11 w-11 items-center justify-center active:opacity-80"
          >
            <ArrowLeft size={22} color={pv.ink.DEFAULT} />
          </Pressable>
          <View className="flex-1 flex-row items-center justify-center gap-2">
            <Logo compact />
            <Text className="text-title font-sans-extrabold text-brand">Ask Sua</Text>
          </View>
          <View className="h-11 w-11" />
        </View>

        {/* Course selector pill */}
        <View className="items-center px-5 pt-1">
          <Pressable
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="Choose course"
            className="flex-row items-center gap-2 rounded-chip bg-success-soft px-4 py-3"
          >
            <BookOpen size={17} color={colors.brand.DEFAULT} />
            <Text className="text-body font-sans-semibold text-brand" numberOfLines={1}>
              {course?.name ?? "Choose a course"}
            </Text>
            <ChevronDown size={16} color={colors.brand.DEFAULT} />
          </Pressable>
        </View>

        {/* Messages */}
        <FlatList
          ref={listRef}
          data={displayItems}
          keyExtractor={(item) => item.id}
          className="flex-1"
          contentContainerClassName="px-5 pb-4 pt-6"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          ListEmptyComponent={
            <View className="mt-24 items-center gap-3 px-6">
              <View className="h-16 w-16 items-center justify-center rounded-full bg-brand-strong">
                <Sparkles size={26} color={colors.gold.DEFAULT} />
              </View>
              <Text className="text-body-lg font-sans-bold text-ink">
                Ask me about your {course?.name ? `${course.code ? `${course.code} ` : ""}${course.name} notes` : "notes"}
              </Text>
              <Text className="text-center text-small text-ink-soft">
                {offline
                  ? "You're offline — saved answers stay readable, new questions need a connection."
                  : "I read through your notes in this course and answer with sources."}
              </Text>
            </View>
          }
          renderItem={renderItem}
          inverted
        />

        {/* Ask error banner */}
        {askError ? (
          <Pressable
            onPress={() => void ask(draftRef.current)}
            className="mx-5 mb-2 flex-row items-center gap-2 rounded-input bg-danger-soft px-4 py-3"
          >
            <RefreshCw size={16} color={colors.danger} />
            <Text className="flex-1 text-small text-danger" numberOfLines={2}>
              {askError} — tap to try again.
            </Text>
          </Pressable>
        ) : null}

        {/* Quick actions */}
        {hasAsked ? (
          <View className="flex-row flex-wrap gap-2 px-5 pb-2">
            {QUICK_ACTIONS.map(({ key, label, Icon }) => (
              <Pressable
                key={key}
                disabled={asking || Boolean(pendingId)}
                onPress={() =>
                  void ask(
                    key === "explain_simply"
                      ? "Explain the last topic in simpler terms"
                      : key === "give_example"
                        ? "Give me an example from the notes"
                        : "Quiz me on one point from the notes",
                    key,
                  )
                }
                className="flex-row items-center gap-2 rounded-chip border border-line bg-surface px-3 py-2"
              >
                <Icon size={15} color={colors.brand.DEFAULT} />
                <Text className="text-caption font-sans-semibold text-brand">{label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {/* Input row */}
        <View className="flex-row items-center gap-2 px-5 pb-2 pt-1">
          <View className="h-13 flex-1 flex-row items-center rounded-full bg-surface px-4 shadow-card">
            <TextInput
              value={draft}
              onChangeText={(value) => {
                draftRef.current = value;
                setDraft(value);
              }}
              placeholder="Ask about your notes"
              placeholderTextColor={pv.ink.faint}
              multiline
              className="h-11 flex-1 text-body text-ink"
              returnKeyType="send"
              onSubmitEditing={send}
            />
            <Pressable
              onPress={mic.micState === "recording" ? () => void mic.stop() : () => void mic.start()}
              accessibilityRole="button"
              accessibilityLabel={
                mic.micState === "recording" ? "Stop recording" : "Record voice question"
              }
              hitSlop={8}
              className={`h-10 w-10 items-center justify-center rounded-full ${
                mic.micState === "recording" ? "bg-danger-soft" : "bg-cream"
              }`}
            >
              <Mic
                size={18}
                color={mic.micState === "recording" ? colors.danger : colors.brand.DEFAULT}
              />
            </Pressable>
          </View>
          <Pressable
            disabled={!canSend}
            onPress={send}
            accessibilityRole="button"
            accessibilityLabel="Send"
            className={`h-12 w-12 items-center justify-center rounded-full ${
              canSend ? "bg-gold shadow-gold" : "bg-gold/60"
            }`}
          >
            <Send size={20} color={colors.brand.DEFAULT} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <CoursePickerSheet
        visible={pickerOpen}
        courses={courses}
        currentCourseId={courseId || undefined}
        heading="Ask about which course?"
        onSelect={(next) => {
          setPickerOpen(false);
          if (next !== courseId) {
            courseInitializedRef.current = true;
            setRouteCourseSelection({
              routeCourseId: params.courseId,
              selectedCourseId: next,
            });
            setPickedCourseId(next);
          }
        }}
        onClose={() => setPickerOpen(false)}
      />
    </SafeAreaView>
  );
}
