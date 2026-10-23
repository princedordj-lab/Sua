import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import { AppearanceProvider } from "@/config/appearance";
import "./globals.css";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Sua — Hear it once. Know it for the exam.",
    template: "%s · Sua",
  },
  description:
    "Sua turns lectures, slides and typed notes into summaries, flashcards and quizzes, and guides daily revision toward the exam date.",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "48x48", type: "image/png" },
      { url: "/icon.png", sizes: "1254x1254", type: "image/png" },
    ],
    apple: [{ url: "/icon.png", type: "image/png" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plusJakartaSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-cream text-ink">
        <AppearanceProvider>{children}</AppearanceProvider>
      </body>
    </html>
  );
}
