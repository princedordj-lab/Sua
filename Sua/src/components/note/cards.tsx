import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react-native";
import { colors } from "../../config/theme";

/**
 * Status cards for a note's AI generation.
 *
 * Each state is its own module-level component on purpose. Rendering "failed"
 * and "running" from one ternary position made React reuse the same <View> and
 * swap its className (e.g. adding `shadow-card`) after the first render, which
 * trips NativeWind's dev-only upgrade pass (#1812) and surfaces as a bogus
 * "Couldn't find a navigation context" crash. Distinct components force a
 * remount, so every class set is stable for the life of the element.
 */

/** Shown while the pipeline is working; one sentence, never a fake percentage. */
export function AiProgressCard({
  label,
  pendingUploads = 0,
  onViewUploads,
}: {
  label: string;
  pendingUploads?: number;
  onViewUploads?: () => void;
}) {
  return (
    <View className="mt-4 flex-row items-center justify-between gap-2 rounded-card bg-surface p-card shadow-card">
      <View className="flex-1 flex-row items-center gap-2.5">
        <Loader2 size={17} color={colors.brand.DEFAULT} />
        <Text className="flex-1 text-body font-sans-bold text-ink">{label}</Text>
      </View>
      {pendingUploads > 0 && onViewUploads ? (
        <Pressable
          onPress={onViewUploads}
          accessibilityRole="link"
          accessibilityLabel="View upload progress"
          className="min-h-12 justify-center active:opacity-70"
        >
          <Text className="text-caption font-sans-bold text-brand">
            View uploads
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * A failed run. The message is whatever the server stored on the job — the
 * pipeline only saves wording meant for the student, so it is shown verbatim.
 */
export function AiFailedCard({
  message,
  title,
  onRetry,
  retrying = false,
  pendingUploads = 0,
  onViewUploads,
}: {
  message: string;
  title: string;
  onRetry: () => void;
  retrying?: boolean;
  pendingUploads?: number;
  onViewUploads?: () => void;
}) {
  return (
    <View className="mt-4 rounded-card border border-warning bg-warning-soft p-card">
      <View className="flex-row items-center gap-2">
        <AlertTriangle size={18} color={colors.warning} />
        <Text className="flex-1 text-body-lg font-sans-extrabold text-ink">
          {title}
        </Text>
      </View>
      <Text className="mt-1 text-small leading-5 text-ink-soft">{message}</Text>
      {pendingUploads > 0 && onViewUploads ? (
        <Pressable
          onPress={onViewUploads}
          accessibilityRole="link"
          accessibilityLabel="Check uploads first"
          className="mt-2 self-start active:opacity-70"
        >
          <Text className="text-small font-sans-bold text-brand">
            Some files still need to upload — check Uploads first.
          </Text>
        </Pressable>
      ) : null}
      <View className={`mt-3 self-start ${retrying ? "opacity-60" : ""}`}>
        <Pressable
          disabled={retrying}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Try generating again"
          className="min-h-12 flex-row items-center justify-center gap-2 rounded-btn bg-brand-strong px-4 active:opacity-80"
        >
          <RefreshCw size={15} color={colors.ink.inverse} />
          <Text className="text-label font-sans-bold text-ink-inverse">
            {retrying ? "Trying again…" : "Try again"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Pipeline notices ("Only the first 20 pages were used.") belong above the
 * note, quoted, not inline in the prose where they read as lecture content.
 */
export function NoticeCard({ notices }: { notices: string[] }) {
  if (!notices.length) return null;
  return (
    <View className="mt-4 rounded-card bg-surface p-card">
      {notices.map((notice, index) => (
        <View
          key={`${index}-${notice.slice(0, 12)}`}
          className={`border-l-2 border-brand/40 pl-3 ${index > 0 ? "mt-2" : ""}`}
        >
          <Text className="text-small leading-5 text-ink-soft">{notice}</Text>
        </View>
      ))}
    </View>
  );
}

/** Neutral empty state: nothing generated yet, or no cards for this note. */
export function EmptyCard({
  title,
  body,
  cta,
  onPress,
  Icon = Sparkles,
}: {
  title: string;
  body?: string;
  cta?: string;
  onPress?: () => void;
  Icon?: React.ComponentType<{ size?: number; color?: string }>;
}) {
  return (
    <View className="rounded-card bg-surface p-card shadow-card">
      <View className="flex-row items-center gap-2">
        <Icon size={18} color={colors.brand.DEFAULT} />
        <Text className="flex-1 text-body font-sans-bold text-ink">{title}</Text>
      </View>
      {body ? (
        <Text className="mt-1 text-small leading-5 text-ink-soft">{body}</Text>
      ) : null}
      {cta && onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={cta}
          className="mt-3 min-h-12 flex-row items-center justify-center gap-2 self-start rounded-btn bg-brand-strong px-4 active:opacity-80"
        >
          <Sparkles size={15} color={colors.ink.inverse} />
          <Text className="text-label font-sans-bold text-ink-inverse">{cta}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Thin labelled section wrapper used by the reader tabs. */
export function ReaderCard({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <View className="mt-4 rounded-card bg-surface p-card-lg shadow-card">
      {title || action ? (
        <View className="mb-3 flex-row items-center justify-between">
          {title ? (
            <Text className="text-body-lg font-sans-extrabold text-ink">
              {title}
            </Text>
          ) : (
            <View />
          )}
          {action}
        </View>
      ) : null}
      {children}
    </View>
  );
}
