import { Text, View } from "react-native";

// Horizontal upload progress: rounded track + brand fill with the percent
// alongside. Used by the Create upload queue and the Uploads screen.
export function ProgressBar({
  progress,
  showPercent = false,
  className = "",
}: {
  progress: number;
  showPercent?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(progress)));
  return (
    <View className={`flex-row items-center gap-2 ${className}`}>
      <View
        className="h-2 flex-1 overflow-hidden rounded-chip bg-line"
        accessibilityLabel={`Upload ${pct} percent complete`}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: pct }}
      >
        <View className="h-full rounded-chip bg-brand-strong" style={{ width: `${pct}%` }} />
      </View>
      {showPercent ? (
        <Text className="text-caption font-sans-bold text-ink-soft">{pct}%</Text>
      ) : null}
    </View>
  );
}
