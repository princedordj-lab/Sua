import type { Metadata } from "next";
import { Suspense } from "react";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = { title: "Sign in" };

export default function SignInPage() {
  return (
    <div className="auth-card-wrap">
      <div className="auth-card-heading">
        <p className="eyebrow-sm">Welcome back</p>
        <h2>Pick up where you left off.</h2>
        <p>Your courses, notes and study sets are waiting on this device.</p>
      </div>
      <Suspense fallback={<div className="auth-clerk-skeleton" aria-label="Loading sign in" />}>
        <SignIn
          path="/sign-in"
          routing="path"
          signUpUrl="/sign-up"
          fallbackRedirectUrl="/app/home"
          appearance={{ elements: { rootBox: "clerk-root" } }}
        />
      </Suspense>
    </div>
  );
}
