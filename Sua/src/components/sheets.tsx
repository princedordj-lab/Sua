import { type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Check, X } from "lucide-react-native";
import type { Course } from "../lib/types";
import { usePalette } from "../state/appearance";

export function BottomSheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable onPress={onClose} className="flex-1 justify-end bg-black/30">
        <Pressable onPress={() => {}} className="rounded-t-sheet bg-cream p-6 pb-10">
          <Text className="text-title font-sans-extrabold text-ink" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text className="mt-1 text-small text-ink-soft">{subtitle}</Text>
          ) : null}
          <View className="mt-4 gap-3">{children}</View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// Bottom sheet for forms with text inputs. The keyboard must never cover the
// fields: iOS shifts the sheet with padding, Android shrinks it with height
// (the Modal's dialog window ignores the activity's resize mode).
export function FormSheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const pv = usePalette();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1 justify-end bg-black/30"
      >
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          className="flex-1"
        />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="rounded-t-sheet bg-cream p-6 pb-10"
        >
          <View className="mb-6 flex-row items-center justify-between">
            <Text className="text-title font-sans-extrabold text-ink">
              {title}
            </Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
              className="h-11 w-11 items-center justify-center active:opacity-80"
            >
              <X size={20} color={pv.ink.faint} />
            </Pressable>
          </View>
          <View className="gap-4">{children}</View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function SheetAction({
  icon,
  label,
  onPress,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className={`min-h-12 flex-row items-center gap-3 rounded-input border px-4 active:opacity-80 ${
        danger ? "border-danger-soft bg-danger-soft" : "border-line bg-surface"
      }`}
    >
      {icon}
      <Text
        className={`text-body font-sans-semibold ${danger ? "text-danger" : "text-ink"}`}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function CoursePickerSheet({
  visible,
  courses,
  currentCourseId,
  excludeCourseId,
  heading,
  onSelect,
  onClose,
}: {
  visible: boolean;
  courses: Course[];
  currentCourseId?: string;
  excludeCourseId?: string;
  heading: string;
  onSelect: (courseId: string) => void;
  onClose: () => void;
}) {
  const pv = usePalette();
  // Archived courses are not valid move targets, except the note's current
  // course so the sheet always renders a selected row.
  const targets = courses.filter(
    (course) =>
      course.id !== excludeCourseId &&
      (!course.archived || course.id === currentCourseId),
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable onPress={onClose} className="flex-1 justify-end bg-black/30">
        <Pressable onPress={() => {}} className="max-h-[70%] rounded-t-sheet bg-cream p-6 pb-10">
          <Text className="text-title font-sans-extrabold text-ink">{heading}</Text>
          <Text className="mt-1 text-small text-ink-soft">
            Pick a course — the note moves right away and syncs when you reconnect.
          </Text>
          <ScrollView className="mt-4" keyboardShouldPersistTaps="handled">
            <View className="gap-3">
              {targets.length === 0 ? (
                <Text className="py-3 text-body text-ink-soft">
                  No other courses yet. Create one from the Courses tab first.
                </Text>
              ) : (
                targets.map((course) => {
                  const selected = course.id === currentCourseId;
                  return (
                    <Pressable
                      key={course.id}
                      onPress={() => onSelect(course.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Move to ${course.name}`}
                      accessibilityState={{ selected }}
                      className="min-h-12 flex-row items-center justify-between gap-3 rounded-input border border-line bg-surface px-4 active:opacity-80"
                    >
                      <View className="flex-1">
                        {course.code ? (
                          <Text className="text-caption font-sans-extrabold text-brand">
                            {course.code}
                          </Text>
                        ) : null}
                        <Text
                          className={`text-body font-sans-semibold ${selected ? "text-brand" : "text-ink"}`}
                          numberOfLines={1}
                        >
                          {course.name}
                        </Text>
                      </View>
                      {selected ? <Check size={18} color={pv.brand.light} /> : null}
                    </Pressable>
                  );
                })
              )}
            </View>
          </ScrollView>
          <Pressable
            onPress={onClose}
            className="mt-4 min-h-12 flex-row items-center justify-center rounded-input border border-line bg-surface active:opacity-80"
            accessibilityRole="button"
          >
            <Text className="text-body font-sans-semibold text-ink-soft">Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
