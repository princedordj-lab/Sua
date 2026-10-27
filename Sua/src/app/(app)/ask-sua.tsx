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
import { Image } from "expo-image";
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

// Even gutter between bubbles. It lives in a separator (rather than per-item
// margin) so the list stays symmetric: the same 12px sits under a student turn
// and under Sua's answer, and the inverted list flips the order but not the gap.
function MessageSeparator() {
  return <View className="h-3" />;
}

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

  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [offline, setOffline] = useState(false);
  // Optimistic turns live outside `messages` because that array is replaced
  // wholesale by loadHistory() — the server only persists the student's turn
  // after the model answers, so a refresh during "Thinking…" would erase it.
  const [pendingTurns, setPendingTurns] = useState<ChatMessageRow[]>([]);
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
  // Refs keep the history loader stable: `getAuthToken` changing identity on a
  // token refresh used to re-create loadHistory, which re-ran useFocusEffect and
  // wiped a question that was still in flight.
  const askingRef = useRef(false);
  const tokenRef = useRef(getAuthToken);
  useEffect(() => {
    tokenRef.current = getAuthToken;
  }, [getAuthToken]);
  const courseIdRef = useRef("");

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
  useEffect(() => {
    courseIdRef.current = courseId;
  }, [courseId]);

  // Cached history paints first; a fetch replaces it when online.
  const loadHistory = useCallback(async () => {
    if (!courseId) return;
    // Never replace the transcript while a question is in flight: the server
    // has not written the student's turn yet, so the fresh list would omit it.
    if (askingRef.current) return;
    try {
      const cached = await listCourseMessages(db, courseId);
      if (askingRef.current) return;
      setMessages(cached);
    } catch {
      // Cache miss is fine; the fetch below fills the screen.
    }
    const state = await NetInfo.fetch();
    const connected = Boolean(state.isConnected);
    setOffline(!connected);
    if (!connected) return;
    const token = await tokenRef.current();
    if (!token || askingRef.current) return;
    try {
      const { messages: fresh } = await chatApi.messages(token, courseId);
      if (askingRef.current) return;
      const rows = fresh.map(toRow);
      setMessages(rows);
      await replaceCourseMessages(db, courseId, rows);
      await setSetting(db, ASK_SUA_COARSE_KEY, courseId);
    } catch {
      // Keep the cached transcript visible; asking will retry.
    }
  }, [courseId, db]);

  // Cached history paints first (effect only touches external systems after
  // its first await), then a server refresh replaces the cache when online.
  useFocusEffect(
    useCallback(() => {
      if (!courseId) return;
      void loadHistory();
    }, [courseId, loadHistory]),
  );

  // A course switch during an answer bails out of loadHistory (the in-flight
  // guard is still set) and the focus effect has already fired, so the new
  // course would stay empty. Reload once the ask settles — through this effect
  // so the *current* courseId is used, not the one captured by the ask call.
  const reloadAfterAskRef = useRef(false);
  useEffect(() => {
    if (asking || !reloadAfterAskRef.current) return;
    reloadAfterAskRef.current = false;
    void loadHistory();
  }, [asking, loadHistory]);

  const ask = useCallback(
    async (question: string, quickAction?: ChatQuickAction) => {
      const trimmed = question.trim();
      if (!trimmed || askingRef.current || !courseId) return;
      setAskError(null);
      askingRef.current = true;
      setAsking(true);
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
      setPendingTurns((prev) => [...prev, tempRow]);
      const askedCourseId = courseId;
      let switchedCourse = false;
      // The list is inverted, so offset 0 is the newest bubble — this keeps the
      // question and the "Thinking…" row in view without touching older items.
      requestAnimationFrame(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      });
      try {
        const token = await getAuthToken();
        if (!token) throw new Error("Not signed in");
        const result = await chatApi.ask(token, {
          courseId,
          question: trimmed,
          quickAction,
        });
        const userRow = toRow(result.user);
        const assistantRow = toRow(result.assistant);
        if (courseIdRef.current !== askedCourseId) {
          // The student switched course while Sua was thinking. The turn is
          // saved for the course they asked in; do not paint it under the new
          // one, and reload the transcript once the in-flight guard is clear.
          setPendingTurns((prev) => prev.filter((message) => message.id !== tempRow.id));
          switchedCourse = true;
          return;
        }
        setMessages((prev) => {
          const seen = new Set(prev.map((message) => message.id));
          const next = [...prev];
          for (const row of [userRow, assistantRow]) {
            if (!seen.has(row.id)) next.push(row);
          }
          return next;
        });
        setPendingTurns((prev) => prev.filter((message) => message.id !== tempRow.id));
        if (result.sources.length) {
          setSourceTitles((prev) => {
            const next = new Map(prev);
            for (const source of result.sources) next.set(source.id, source.title);
            return next;
          });
        }
        await Promise.all([
          upsertChatMessage(db, userRow),
          upsertChatMessage(db, assistantRow),
        ]);
        await setSetting(db, ASK_SUA_COARSE_KEY, courseId);
      } catch (error) {
        setPendingTurns((prev) => prev.filter((message) => message.id !== tempRow.id));
        // Park the question in the cache for an offline read, and put it back in
        // the composer so the student can retry it in one tap.
        await upsertChatMessage(db, tempRow).catch(() => {});
        draftRef.current = trimmed;
        setDraft(trimmed);
        setAskError(
          error instanceof Error ? error.message : "Ask Sua is unreachable right now.",
        );
      } finally {
        askingRef.current = false;
        if (switchedCourse) reloadAfterAskRef.current = true;
        setAsking(false);
      }
    },
    [courseId, db, getAuthToken],
  );

  const mic = useChatMic({
    getToken: getAuthToken,
    onTranscribed: (text) => {
      // A typed question may already be in flight; park the transcript in the
      // composer instead of dropping it on the floor.
      if (askingRef.current) {
        draftRef.current = text;
        setDraft(text);
        return;
      }
      void ask(text);
    },
  });

  const send = useCallback(() => {
    void ask(draftRef.current);
  }, [ask]);

  const canSend = Boolean(
    draft.trim().length > 0 &&
      !asking &&
      courseId &&
      (mic.micState === "idle" || mic.micState === "error"),
  );
  const hasAsked =
    messages.some((message) => message.role === "assistant") ||
    pendingTurns.some((message) => message.role === "assistant");

  // Inverted list: index 0 paints at the visual bottom, so reverse the order
  // and drop the thinking row in as the newest item while a request runs.
  const displayItems = useMemo(() => {
    const items = [
      ...messages,
      ...pendingTurns.filter((turn) => turn.courseId === courseId),
    ].reverse();
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
  }, [asking, courseId, messages, pendingTurns]);

  const renderItem = useCallback(
    ({ item }: { item: ChatMessageRow }) => {
      const isUser = item.role === "user";
      const isThinking = item.id === "pending";
      const sources = isThinking ? [] : item.sourceNoteIds.slice(0, 2);

      // Column, not row: the source chips belong *under* Sua's bubble. As a
      // row sibling they were a zero-width flex child that still carried `pt-2`
      // when there were no sources, which pushed the bubble up inside its own
      // cell and showed as a phantom gap between the student's turn and the
      // answer (and a taller, squeezed chip column when sources did exist).
      return (
        <View className={isUser ? "items-end" : "items-start"}>
          <View className={isUser ? "items-end" : "flex-row items-end gap-2"}>
            {isUser ? null : (
              <View className="h-10 w-10 overflow-hidden rounded-full border border-gold bg-surface">
                <Image
                  source={require("@/assets/images/icons/chatbot-icon.png")}
                  className="h-full w-full"
                  contentFit="cover"
                  style={{ width: '100%', height: '100%' }}
                  accessibilityLabel="Sua assistant"
                />
              </View>
            )}
            {isThinking ? (
              <View className="rounded-input bg-surface px-4 py-3 shadow-card">
                <Text className="text-body text-ink-soft">Thinking…</Text>
              </View>
            ) : (
              <View
                className={`max-w-[78%] px-4 py-3 ${
                  isUser
                    ? "rounded-input bg-brand-strong"
                    : "rounded-input bg-surface shadow-card"
                }`}
              >
                {isUser ? (
                  <Text className="text-body text-white">{item.content}</Text>
                ) : (
                  <Markdown text={item.content} className="text-body leading-6 text-ink" />
                )}
              </View>
            )}
          </View>
          {sources.length ? (
            <View className="gap-2 pl-12 pt-2">
              {sources.map((sourceId) => {
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
      );
    },
    [sourceTitles],
  );

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={["top", "left", "right"]}>
      {/* Android needs an explicit behavior too: with edge-to-edge (default since
          SDK 54) the window no longer resizes for the keyboard, so the composer
          would stay pinned behind it. `padding` lifts the input row just above
          the keyboard on both platforms; the SafeAreaView excludes the bottom
          edge, so the measured overlap equals the real keyboard height. */}
      <KeyboardAvoidingView behavior="padding" className="flex-1">
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
            <View className="h-9 w-9 overflow-hidden rounded-full border border-gold bg-surface">
              <Image
                source={require("@/assets/images/icons/chatbot-icon.png")}
                className="h-full w-full"
                contentFit="cover"
                style={{ width: '100%', height: '100%' }}
                accessibilityLabel="Sua assistant"
              />
            </View>
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
          contentContainerClassName="px-5 pb-6 pt-8"
          ItemSeparatorComponent={MessageSeparator}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
          onContentSizeChange={() => {
            // The thinking row (and then the answer) grows the list; keep the
            // newest bubble pinned while a request is running.
            if (askingRef.current) {
              listRef.current?.scrollToOffset({ offset: 0, animated: false });
            }
          }}
          ListEmptyComponent={
            <View className="mt-24 items-center gap-3 px-6">
              <View className="h-16 w-16 overflow-hidden rounded-full border-2 border-gold bg-surface">
                <Image
                  source={require("@/assets/images/icons/chatbot-icon.png")}
                  className="h-full w-full"
                  contentFit="cover"
                  style={{ width: '100%', height: '100%' }}
                  accessibilityLabel="Sua assistant"
                />
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
                disabled={asking}
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

        {/* Composer */}
        <SafeAreaView edges={["bottom"]}>
          {mic.micError ? (
            <View className="px-5 pb-1">
              <Text className="text-small text-danger">{mic.micError}</Text>
            </View>
          ) : null}
          {mic.micState === "transcribing" ? (
            <View className="px-5 pb-1">
              <Text className="text-small text-ink-soft">Transcribing…</Text>
            </View>
          ) : null}

        {/* Input row */}
        <View className="flex-row items-center gap-2 px-5 pb-3 pt-3">
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
          <View
            className={`h-10 w-10 items-center justify-center rounded-full ${
              mic.micState === "recording" ? "bg-danger-soft" : "bg-cream"
            }`}
          >
            <Pressable
              onPress={mic.micState === "recording" ? () => void mic.stop() : () => void mic.start()}
              disabled={mic.micState === "transcribing"}
              accessibilityRole="button"
              accessibilityLabel={
                mic.micState === "recording" ? "Stop recording" : "Record voice question"
              }
              hitSlop={8}
              className="h-10 w-10 items-center justify-center rounded-full"
            >
              <Mic
                size={18}
                color={mic.micState === "recording" ? colors.danger : colors.brand.DEFAULT}
              />
            </Pressable>
          </View>
          </View>
          {/* Never add or remove --tw-* utilities after first render. NativeWind's
              dev-only upgrade warning deep-walks props, trips React Navigation's
              throwing context getters, and redboxes as "Couldn't find a
              navigation context" (nativewind#1812). Keep the background and shadow
              variables static; only the plain opacity value toggles. */}
          <View
            className={`h-12 w-12 items-center justify-center rounded-full bg-gold shadow-gold ${
              canSend ? "opacity-100" : "opacity-60"
            }`}
          >
            <Pressable
              disabled={!canSend}
              onPress={send}
              accessibilityRole="button"
              accessibilityLabel="Send"
              className="h-12 w-12 items-center justify-center rounded-full"
            >
              <Send size={20} color={colors.brand.DEFAULT} />
            </Pressable>
          </View>
        </View>
        </SafeAreaView>
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
