import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Logo } from "@/components/logo";

export const metadata: Metadata = {
  title: {
    default: "Welcome to Sua",
    template: "%s · Sua",
  },
  description: "Sign in to keep your courses, summaries and study sets in sync.",
};

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth-shell">
      <section className="auth-story" aria-hidden="true">
        <Logo href="/" />
        <div className="auth-story-copy">
          <p className="eyebrow">Hear it once. Know it for the exam.</p>
          <h1>
            Your lectures,
            <br />
            turned into <em>exam confidence.</em>
          </h1>
          <p>
            Sua listens to the lecture, tidies your notes and builds the flashcards and
            quizzes that get you ready for the paper. Your phone and this browser share one
            study space.
          </p>
        </div>
        <div className="auth-story-footer">
          <span>Built for African university students</span>
          <Link href="/health">System status</Link>
        </div>
      </section>
      <section className="auth-panel">{children}</section>
    </div>
  );
}
