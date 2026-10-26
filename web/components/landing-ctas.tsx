"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";

function Arrow() {
  return <ArrowRight size={17} aria-hidden="true" />;
}

/**
 * Landing CTAs adapt to the session. `useAuth` (not `<SignedIn>`, removed in
 * Clerk's Core 3) keeps this a client island so the marketing page stays
 * statically prerenderable; signed-out links render until Clerk hydrates.
 */
function useSignedIn() {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && Boolean(isSignedIn);
}

/** Header CTA: sign in / get started when signed out, straight into the app when signed in. */
export function LandingHeaderCta() {
  const signedIn = useSignedIn();
  return (
    <div className="header-actions">
      {signedIn ? (
        <Link className="header-cta" href="/app/home">
          Open Sua <Arrow />
        </Link>
      ) : (
        <>
          <Link className="header-signin" href="/sign-in">
            Sign in
          </Link>
          <Link className="header-cta" href="/sign-up">
            Get started <Arrow />
          </Link>
        </>
      )}
    </div>
  );
}

/** Hero pair: create an account, or resume an existing one. */
export function LandingHeroActions() {
  const signedIn = useSignedIn();
  return (
    <div className="hero-actions">
      {signedIn ? (
        <>
          <Link className="button button-primary" href="/app/home">
            Open your study space <Arrow />
          </Link>
          <a className="text-link" href="#how-it-works">
            See how it works <span>↓</span>
          </a>
        </>
      ) : (
        <>
          <Link className="button button-primary" href="/sign-up">
            Get started free <Arrow />
          </Link>
          <Link className="text-link" href="/sign-in">
            I already have an account <span>→</span>
          </Link>
        </>
      )}
    </div>
  );
}

/** Closing call to action at the bottom of the page. */
export function LandingClosingActions() {
  const signedIn = useSignedIn();
  return (
    <div className="closing-actions">
      {signedIn ? (
        <Link className="button button-light" href="/app/home">
          Back to your study space <Arrow />
        </Link>
      ) : (
        <>
          <Link className="button button-light" href="/sign-up">
            Create your free account <Arrow />
          </Link>
          <Link className="closing-signin" href="/sign-in">
            Sign in
          </Link>
        </>
      )}
    </div>
  );
}
