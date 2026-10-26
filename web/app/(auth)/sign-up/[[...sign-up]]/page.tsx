import type { Metadata } from "next";
import { Suspense } from "react";
import { SignUp } from "@clerk/nextjs";

export const metadata: Metadata = { title: "Create an account" };

export default function SignUpPage() {
  return (
    <div className="auth-card-wrap">
      <div className="auth-card-heading">
        <p className="eyebrow-sm">Start studying smarter</p>
        <h2>Make Sua yours.</h2>
        <p>One account for your phone and this browser. Free to start.</p>
      </div>
      <Suspense fallback={<div className="auth-clerk-skeleton" aria-label="Loading sign up" />}>
        <SignUp
          path="/sign-up"
          routing="path"
          signInUrl="/sign-in"
          fallbackRedirectUrl="/onboarding"
          appearance={{ elements: { rootBox: "clerk-root" } }}
        />
      </Suspense>
    </div>
  );
}
