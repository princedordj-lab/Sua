import { type ReactNode } from "react";
import { Image } from "expo-image";
import {
  Pressable,
  Switch,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";
import { usePalette } from "../state/appearance";


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
      : "bg-brand-strong";
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
  const pv = usePalette();
  return (
    <View className="gap-2">
      <Text className="text-label font-semibold text-ink-soft">{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={pv.ink.faint}
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
  const pv = usePalette();
  return (
    <View className="mb-3 flex-row items-center justify-between">
      <Text className="text-title font-extrabold text-ink">{title}</Text>
      {action && (
        <Pressable onPress={onAction} className="min-h-11 flex-row items-center gap-1 active:opacity-80">
          <Text className="font-bold text-brand">{action}</Text>
          <ChevronRight size={16} color={pv.brand.DEFAULT} />
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
  const pv = usePalette();
  return (
    <Pressable
      onPress={onPress}
      className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong px-5 active:opacity-80"
    >
      <Plus size={18} color={pv.gold.DEFAULT} />
      <Text className="font-bold text-gold">{title}</Text>
    </Pressable>
  );
}

// Navigation row for settings screens (icon + label + optional subtitle + chevron).
export function SettingsRow({
  Icon,
  title,
  subtitle,
  onPress,
  danger = false,
  nextValue,
}: {
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  subtitle?: string;
  onPress: () => void;
  danger?: boolean;
  nextValue?: string;
}) {
  const pv = usePalette();
  const textColor = danger ? pv.danger : pv.ink.DEFAULT;
  const iconColor = danger ? pv.danger : pv.brand.DEFAULT;
  return (
    <Pressable
      onPress={onPress}
      className="min-h-12 flex-row items-center px-card active:opacity-80"
      accessibilityRole="button"
    >
      <Icon size={19} color={iconColor} />
      <View className="ml-3 flex-1">
        <Text
          className="font-sans-bold text-body"
          style={{ color: textColor }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-small leading-5 text-ink-soft">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {nextValue ? (
        <Text className="mr-1 text-small text-ink-soft">{nextValue}</Text>
      ) : null}
      <ChevronRight size={18} color={pv.ink.faint} />
    </Pressable>
  );
}

export type SegmentOption<K extends string> = {
  key: K;
  label: string;
  Icon?: React.ComponentType<{ size?: number; color?: string }>;
  // Small trailing count (cards, questions). Zero/undefined is omitted.
  count?: number | null;
};

/**
 * Pill tabs (Notes | Summary | Cards | Quiz).
 *
 * The selected pill is an always-mounted `bg-brand-strong` layer whose opacity
 * flips. Swapping the background utility itself re-runs NativeWind's dev
 * upgrade pass (#1812) and crashes with a bogus navigation-context error, so
 * only `opacity-*` changes after the first render.
 */
export function SegmentedControl<K extends string>({
  options,
  value,
  onChange,
  disabled = false,
  className = "",
}: {
  options: readonly SegmentOption<K>[];
  value: K;
  onChange: (next: K) => void;
  disabled?: boolean;
  className?: string;
}) {
  const pv = usePalette();
  return (
    <View
      className={`flex-row rounded-chip bg-surface p-1 ${className} ${
        disabled ? "opacity-60" : ""
      }`}
    >
      {options.map(({ key, label, Icon, count }) => {
        const selected = key === value;
        return (
          <Pressable
            key={key}
            onPress={() => {
              if (!disabled) onChange(key);
            }}
            disabled={disabled}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            accessibilityLabel={count ? `${label}, ${count}` : label}
            className="min-h-12 flex-1 flex-row items-center justify-center gap-1.5 rounded-chip px-2 active:opacity-70"
          >
            <View
              pointerEvents="none"
              className={`absolute inset-0 rounded-chip bg-brand-strong ${
                selected ? "opacity-100" : "opacity-0"
              }`}
            />
            {Icon ? (
              <Icon size={15} color={selected ? pv.ink.inverse : pv.ink.soft} />
            ) : null}
            <Text
              numberOfLines={1}
              className={`text-small font-sans-bold ${
                selected ? "text-ink-inverse" : "text-ink-soft"
              }`}
            >
              {label}
            </Text>
            {count ? (
              <Text
                className={`text-caption font-sans-bold ${
                  selected ? "text-ink-inverse" : "text-ink-faint"
                }`}
              >
                {count}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// Label + switch row (the switch carries the annotation, not a chevron).
export function SwitchRow({
  Icon,
  title,
  subtitle,
  value,
  onChange,
  danger = false,
}: {
  Icon?: React.ComponentType<{ size?: number; color?: string }>;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (next: boolean) => void;
  danger?: boolean;
}) {
  const pv = usePalette();
  return (
    <View className="min-h-12 flex-row items-center px-card py-2">
      {Icon ? <Icon size={19} color={danger ? pv.danger : pv.brand.DEFAULT} /> : null}
      <View className="flex-1 px-3">
        <Text
          className="font-sans-bold text-body"
          style={{ color: danger ? pv.danger : pv.ink.DEFAULT }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text className="mt-0.5 text-small leading-5 text-ink-soft">
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: pv.brand.DEFAULT, false: pv.line }}
        thumbColor={pv.surface}
        accessibilityLabel={title}
      />
    </View>
  );
}
