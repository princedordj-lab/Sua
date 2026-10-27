import Image from "next/image";
import type { ComponentType } from "react";

/**
 * The assistant's robot mark. Kept in one component so every "Ask Sua" entry
 * point uses the same image, and so it can share icon arrays with lucide
 * components (`strokeWidth` is accepted for that reason and ignored).
 */
export function SuaChatMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <Image
      src="/chatbot-icon.png"
      alt=""
      width={size}
      height={size}
      sizes={`${size}px`}
      draggable={false}
      className={className ? `sua-chat-mark ${className}` : "sua-chat-mark"}
      aria-hidden="true"
    />
  );
}

export type SuaChatIconComponent = ComponentType<{
  size?: number;
  strokeWidth?: number;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;
