import { useCallback, useMemo, useState } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  List,
} from "lucide-react-native";
import { Markdown, type MarkdownScale } from "../markdown";
import { parseNoteSections, type NoteSection } from "../../lib/markdown";
import { ProgressBar } from "../progress-bar";
import { BottomSheet } from "../sheets";
import { colors } from "../../config/theme";

// Sections the pipeline names for a reason get a quiet, distinct treatment.
// The wrapper is keyed by section id, so its class set is fixed for the life
// of each mounted element (NativeWind #1812).
function sectionToneClass(title: string) {
  const name = title.toLowerCase();
  if (name.includes("key takeaway"))
    return "rounded-card border-l-4 border-gold bg-gold/10 p-4";
  if (name.includes("definition") || name.includes("key term"))
    return "rounded-card border-l-4 border-brand bg-brand/5 p-4";
  if (name.includes("example"))
    return "rounded-card border-l-4 border-brand bg-surface p-4";
  if (name.includes("formula") || name.includes("equation"))
    return "rounded-card border-l-4 border-gold bg-cream p-4";
  return "";
}

/**
 * Reads one note page by page: only the selected `##` section is mounted, the
 * progress bar tracks reading (not generation), and the TOC jumps directly.
 * Bodies without `##` headings fall back to the plain Markdown renderer so
 * legacy notes keep rendering exactly as before.
 */
export function SectionReader({
  text,
  scale,
  initialSectionId,
  courseId,
  onSectionChange,
  onRequestScrollTop,
}: {
  text: string;
  scale?: MarkdownScale;
  initialSectionId?: string | null;
  courseId?: string | null;
  onSectionChange?: (sectionId: string) => void;
  onRequestScrollTop?: () => void;
}) {
  const { intro, sections } = useMemo(() => parseNoteSections(text), [text]);
  // The screen mounts the reader once the saved position is known, so the
  // initializer can restore it without a follow-up state sync.
  const [index, setIndex] = useState(() => {
    if (!sections.length) return 0;
    const target = initialSectionId
      ? sections.findIndex((section) => section.id === initialSectionId)
      : -1;
    return target >= 0 ? target : 0;
  });
  const [finished, setFinished] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const fade = useMemo(() => new Animated.Value(1), []);

  const total = sections.length;
  const safeIndex = total ? Math.min(index, total - 1) : 0;
  const current: NoteSection | null = total ? sections[safeIndex] : null;
  const isFinal = total > 0 && safeIndex === total - 1;
  const progress = total ? Math.round(((safeIndex + 1) / total) * 100) : 0;

  const goTo = useCallback(
    (next: number) => {
      if (!sections.length) return;
      const clamped = Math.max(0, Math.min(sections.length - 1, next));
      setContentsOpen(false);
      setFinished(false);
      setIndex((currentIndex) => {
        if (currentIndex !== clamped) {
          fade.setValue(0.2);
          Animated.timing(fade, {
            toValue: 1,
            duration: 120,
            useNativeDriver: true,
          }).start();
        }
        return clamped;
      });
      onSectionChange?.(sections[clamped].id);
      onRequestScrollTop?.();
    },
    [fade, onRequestScrollTop, onSectionChange, sections],
  );

  if (!sections.length) {
    return <Markdown text={text} scale={scale} />;
  }

  return (
    <View>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text
            accessibilityLiveRegion="polite"
            className="text-caption font-sans-bold text-ink-soft"
          >
            Section {safeIndex + 1} of {total}
          </Text>
          <Text
            accessibilityRole="header"
            className="mt-1 text-h3 font-sans-extrabold text-ink"
          >
            {current?.title}
          </Text>
        </View>
        {isFinal ? (
          <View className="rounded-chip bg-success-soft px-2.5 py-1">
            <Text className="text-caption font-sans-bold text-brand">
              Final section
            </Text>
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={() => setContentsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Open contents"
        className="mt-2 min-h-11 flex-row items-center gap-1.5 self-start active:opacity-70"
      >
        <List size={16} color={colors.brand.DEFAULT} />
        <Text className="text-small font-sans-bold text-brand">Contents</Text>
      </Pressable>

      <View className="mt-2">
        <Text className="mb-1 text-caption text-ink-faint">Reading progress</Text>
        <ProgressBar progress={progress} showPercent label="Reading progress" />
      </View>

      <Animated.View style={{ opacity: fade }}>
        <View className="mt-4">
          {intro && safeIndex === 0 ? (
            <View className="mb-4">
              <Markdown text={intro} scale={scale} />
            </View>
          ) : null}
          <View key={current?.id} className={sectionToneClass(current?.title ?? "")}>
            <Markdown text={current?.body ?? ""} scale={scale} />
          </View>
        </View>
      </Animated.View>

      {finished ? (
        <View className="mt-5 rounded-card border border-line bg-cream p-card">
          <View className="flex-row items-center gap-2">
            <Check size={18} color={colors.brand.DEFAULT} />
            <Text className="flex-1 text-body-lg font-sans-extrabold text-ink">
              You’ve reached the end of this note
            </Text>
          </View>
          <Text className="mt-1 text-small leading-5 text-ink-soft">
            Every section is read. Review the contents or go back to your course.
          </Text>
          <View className="mt-3 flex-row flex-wrap gap-2">
            <Pressable
              onPress={() => setContentsOpen(true)}
              accessibilityRole="button"
              accessibilityLabel="Review contents"
              className="min-h-12 flex-row items-center justify-center rounded-btn border border-line bg-surface px-4 active:opacity-80"
            >
              <Text className="text-label font-sans-bold text-ink">
                Review contents
              </Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setFinished(false);
                if (courseId) router.push(`/course/${courseId}`);
                else router.back();
              }}
              accessibilityRole="button"
              accessibilityLabel="Back to course"
              className="min-h-12 flex-row items-center justify-center rounded-btn bg-brand-strong px-4 active:opacity-80"
            >
              <Text className="text-label font-sans-bold text-ink-inverse">
                Back to course
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <View className="mt-5 flex-row items-center gap-3">
          <Pressable
            disabled={safeIndex === 0}
            onPress={() => goTo(safeIndex - 1)}
            accessibilityRole="button"
            accessibilityLabel="Previous section"
            accessibilityState={{ disabled: safeIndex === 0 }}
            className={`min-h-12 flex-1 flex-row items-center justify-center gap-1.5 rounded-btn border border-line bg-surface active:opacity-80 ${
              safeIndex === 0 ? "opacity-40" : ""
            }`}
          >
            <ChevronLeft
              size={16}
              color={
                safeIndex === 0 ? colors.ink.faint : colors.ink.DEFAULT
              }
            />
            <Text
              className={`text-label font-sans-bold ${
                safeIndex === 0 ? "text-ink-faint" : "text-ink"
              }`}
            >
              Previous
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              if (isFinal) {
                setFinished(true);
                return;
              }
              goTo(safeIndex + 1);
            }}
            accessibilityRole="button"
            accessibilityLabel={isFinal ? "Finish reading" : "Next section"}
            className="min-h-12 flex-1 flex-row items-center justify-center gap-1.5 rounded-btn bg-brand-strong active:opacity-80"
          >
            {isFinal ? (
              <Check size={16} color={colors.ink.inverse} />
            ) : (
              <ChevronRight size={16} color={colors.ink.inverse} />
            )}
            <Text className="text-label font-sans-bold text-ink-inverse">
              {isFinal ? "Finish reading" : "Next"}
            </Text>
          </Pressable>
        </View>
      )}

      <BottomSheet
        visible={contentsOpen}
        onClose={() => setContentsOpen(false)}
        title="Contents"
        subtitle={`Section ${safeIndex + 1} of ${total}`}
      >
        <ScrollView
          className="max-h-96"
          showsVerticalScrollIndicator={false}
          accessibilityLabel="Note sections"
        >
          <View className="gap-2">
            {sections.map((section, sectionIndex) => {
              const active = sectionIndex === safeIndex;
              return (
                <Pressable
                  key={section.id}
                  onPress={() => goTo(sectionIndex)}
                  accessibilityRole="button"
                  accessibilityLabel={`Section ${sectionIndex + 1}: ${section.title}`}
                  accessibilityState={{ selected: active }}
                  className="min-h-12 flex-row items-center gap-3 rounded-input bg-surface px-3 active:opacity-80"
                >
                  {active ? (
                    <View className="h-8 w-1 rounded-full bg-brand-strong" />
                  ) : (
                    <View className="h-8 w-1" />
                  )}
                  <Text
                    className={`w-6 text-caption font-sans-bold ${
                      active ? "text-brand" : "text-ink-faint"
                    }`}
                  >
                    {sectionIndex + 1}
                  </Text>
                  <Text
                    numberOfLines={2}
                    className={`flex-1 text-small ${
                      active ? "font-sans-bold text-ink" : "text-ink-soft"
                    }`}
                  >
                    {section.title}
                  </Text>
                  {active ? (
                    <Check size={16} color={colors.brand.DEFAULT} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </BottomSheet>
    </View>
  );
}
