import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Plus_Jakarta_Sans } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { Analytics } from "@vercel/analytics/next";
import { AppearanceProvider } from "@/config/appearance";
import { colors } from "@/config/theme";
import "./globals.css";
import "./app.css";

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
  applicationName: "Sua",
  icons: {
    icon: [
      { url: "/favicon.png", sizes: "48x48", type: "image/png" },
      { url: "/icon.png", sizes: "1254x1254", type: "image/png" },
    ],
    apple: [{ url: "/icon.png", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: colors.cream },
    { media: "(prefers-color-scheme: dark)", color: "#171411" },
  ],
};

// Applies the stored/system scheme before first paint so the app never flashes
// a light shell at a student who picked dark mode.
const themeScript = `(function(){try{var m=localStorage.getItem("appearance");var d=m==="dark"||((!m||m==="system")&&window.matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${plusJakartaSans.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans bg-cream text-ink">
        <Script
          id="sua-theme"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <ClerkProvider
          signInUrl="/sign-in"
          signUpUrl="/sign-up"
          appearance={{
            variables: {
              colorPrimary: colors.brand.DEFAULT,
              colorPrimaryForeground: "#FFFFFF",
              colorForeground: colors.ink.DEFAULT,
              colorBackground: colors.surface,
              colorInput: colors.surface,
              colorInputForeground: colors.ink.DEFAULT,
              colorMutedForeground: colors.ink.soft,
              colorBorder: colors.line,
              colorDanger: colors.danger,
              fontFamily: "var(--font-plus-jakarta-sans)",
              borderRadius: "14px",
            },
            elements: {
              card: "clerk-card",
              rootBox: "clerk-root",
              headerTitle: "clerk-title",
              headerSubtitle: "clerk-subtitle",
              socialButtonsBlockButton: "clerk-social",
              formButtonPrimary: "clerk-primary",
              footerActionLink: "clerk-link",
            },
          }}
        >
          <AppearanceProvider>{children}</AppearanceProvider>
        </ClerkProvider>
        <Analytics />
      </body>
    </html>
  );
}
