import { type ReactNode } from "react";
import { Pressable, Text, TextInput, View, type TextInputProps } from "react-native";
import { ChevronRight, Plus } from "lucide-react-native";

export function Logo({ compact = false }: { compact?: boolean }) {
  return <View className="flex-row items-center gap-2"><View className="h-9 w-9 items-center justify-center rounded-xl bg-[#7C5CFC]"><Text className="text-lg font-black text-white">S</Text></View>{!compact && <Text className="text-2xl font-extrabold tracking-tight text-[#19152C]">sua</Text>}</View>;
}

export function PrimaryButton({ children, onPress, variant = "primary" }: { children: ReactNode; onPress: () => void; variant?: "primary" | "secondary" | "danger" }) {
  const styles = variant === "primary" ? "bg-[#7C5CFC]" : variant === "danger" ? "bg-[#FEECEC]" : "bg-[#F1EEFF]";
  const text = variant === "primary" ? "text-white" : variant === "danger" ? "text-[#D94A4A]" : "text-[#6045D8]";
  return <Pressable onPress={onPress} className={`min-h-14 items-center justify-center rounded-2xl px-5 ${styles}`}><Text className={`text-base font-bold ${text}`}>{children}</Text></Pressable>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return <View className="gap-2"><Text className="text-sm font-semibold text-[#5B566A]">{label}</Text><TextInput {...props} placeholderTextColor="#A9A4B8" className="h-14 rounded-2xl border border-[#E9E5F2] bg-white px-4 text-base text-[#19152C]" /></View>;
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <View className="mb-3 flex-row items-center justify-between"><Text className="text-lg font-extrabold text-[#19152C]">{title}</Text>{action && <Pressable onPress={onAction} className="flex-row items-center gap-1"><Text className="font-bold text-[#7C5CFC]">{action}</Text><ChevronRight size={16} color="#7C5CFC" /></Pressable>}</View>;
}

export function EmptyAction({ title, onPress }: { title: string; onPress: () => void }) {
  return <Pressable onPress={onPress} className="flex-row items-center justify-center gap-2 rounded-2xl border border-dashed border-[#CFC7F8] bg-[#F8F6FF] p-5"><Plus size={18} color="#7C5CFC" /><Text className="font-bold text-[#6045D8]">{title}</Text></Pressable>;
}
