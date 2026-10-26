export function initials(name: string) {
  return (
    name
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "S"
  );
}

export function firstName(name: string | null | undefined) {
  return name?.trim().split(/\s+/)[0] || "Student";
}

export function relativeDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function shortDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function examCountdown(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: "Exam passed", tone: "muted" as const };
  if (days === 0) return { label: "Exam today", tone: "danger" as const };
  if (days === 1) return { label: "Exam tomorrow", tone: "warning" as const };
  return {
    label: `${days} days to exam`,
    tone: days <= 7 ? ("warning" as const) : ("brand" as const),
  };
}

export function dueLabel(value: string | null | undefined) {
  if (!value) return "New card";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "New card";
  if (date.getTime() <= Date.now()) return "Due now";
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  if (minutes < 60) return `Due in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Due in ${hours} h`;
  return `Due ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function monthLabel(value: string) {
  const [year, month] = value.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
