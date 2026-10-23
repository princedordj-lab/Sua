import { Switch, Text, View } from "react-native";
import { colors } from "../config/theme";
import { usePalette } from "../state/appearance";

export function WifiToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const pv = usePalette();
  return (
    <View className="flex-row items-center gap-2 rounded-chip bg-success-soft px-3 py-2">
      <Text className="text-small font-sans-bold text-ink">Wi-Fi only upload</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: colors.brand.DEFAULT, false: pv.line }}
        thumbColor={colors.ink.inverse}
        accessibilityLabel="Wi-Fi only upload"
      />
    </View>
  );
}
