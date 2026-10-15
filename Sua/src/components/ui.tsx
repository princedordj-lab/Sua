import { type ReactNode } from "react";
import { Image } from "expo-image";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";


export function Logo({
  compact = false,
  light = false,
}: {
  compact?: boolean;
  light?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2">
      <View className="h-10 w-10 overflow-hidden rounded-xl">
        <Image
          source={require('@/assets/images/icons/icon.png')}
          style={{ width: "100%", height: "100%" }}
          accessibilityLabel="Sua"
        />
      </View>
      {!compact && (
        <Text
          className={`text-2xl font-extrabold tracking-tight ${light ? "text-gold" : "text-brand"}`}
        >
          sua
        </Text>
      )}
    </View>
  );
}

export function PrimaryButton({
  children,
  onPress,
  variant = "primary",
}: {
  children: ReactNode;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger";
}) {
  const styles =
    variant === "danger"
      ? "bg-danger-soft"
      : "bg-brand";
  const text =
    variant === "danger" ? "text-danger" : "text-gold";
  return (
    <Pressable
      onPress={onPress}
      className={`min-h-14 items-center justify-center rounded-btn px-5 active:opacity-80 ${styles}`}
    >
      <Text className={`text-base font-bold ${text}`}>{children}</Text>
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View className="gap-2">
      <Text className="text-label font-semibold text-ink-soft">{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor="#8A978F"
        className="h-14 rounded-input border border-line bg-surface px-4 text-body text-ink"
      />
    </View>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <View className="mb-3 flex-row items-center justify-between">
      <Text className="text-title font-extrabold text-ink">{title}</Text>
      {action && (
        <Pressable onPress={onAction} className="min-h-11 flex-row items-center gap-1 active:opacity-80">
          <Text className="font-bold text-brand">{action}</Text>
          <ChevronRight size={16} color="#005B45" />
        </Pressable>
      )}
    </View>
  );
}

export function EmptyAction({
  title,
  onPress,
}: {
  title: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand px-5 active:opacity-80"
    >
      <Plus size={18} color="#FFBE1A" />
      <Text className="font-bold text-gold">{title}</Text>
    </Pressable>
  );
}
