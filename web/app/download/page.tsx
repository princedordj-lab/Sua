import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { BookOpen, Check, CloudUpload, ListChecks } from "lucide-react";
import { DownloadSection } from "@/components/download-section";
import { androidApp } from "@/config/download";

export const metadata: Metadata = {
  title: "Download Sua for Android",
  description: `Install the Sua Android app (${androidApp.sizeLabel}, Android ${androidApp.minAndroid}+) and study your lectures, notes and flashcards offline.`,
  openGraph: {
    title: "Download Sua for Android",
    description:
      "Take your lectures, study sets and review into the lecture hall — the Android app keeps working offline.",
    type: "website",
  },
};

/** Screens from the Android build, shown as a strip under the install band. */
const shots = [
  {
    src: "/screens/WelcomeScreen.jpeg",
    alt: "The Sua welcome screen on an Android phone",
  },
  {
    src: "/screens/Onboarding3.jpeg",
    alt: "A student recording a lecture in Sua",
  },
  {
    src: "/screens/Onboarding1.jpeg",
    alt: "A student reviewing a Sua study set on a phone",
  },
  {
    src: "/screens/Onboarding2.jpeg",
    alt: "A student studying with Sua between classes",
  },
];

const insideApp = [
  {
    Icon: CloudUpload,
    title: "Capture the class",
    copy: "Record a lecture in 2-minute parts, photograph the board, or type notes — the app keeps capturing when the signal drops.",
    tag: "Record · upload · type",
  },
  {
    Icon: BookOpen,
    title: "A study set from every note",
    copy: "One generation writes the summary, flashcards and quiz for a note, then syncs them to the web app.",
    tag: "Summaries · cards · quizzes",
  },
  {
    Icon: ListChecks,
    title: "Review wherever you are",
    copy: "Spaced repetition picks what is due today and quizzes are marked as you go, so a queue or a bus ride counts.",
    tag: "SRS review · quizzes",
  },
];

const requirements = [
  {
    title: `Android ${androidApp.minAndroid} or newer`,
    copy: "Sua runs on most phones still in use today.",
  },
  {
    title: `${androidApp.sizeLabel} download`,
    copy: "Grab it over Wi-Fi so the install doesn’t eat your data bundle.",
  },
  {
    title: "Room to install",
    copy: "Android needs the install size plus working space while it unpacks the app.",
  },
  {
    title: "Your Sua account",
    copy: "Sign in with the same account you use on the web — your courses are already there.",
  },
];

const questions = [
  {
    question: "Why is Sua not on the Play Store?",
    answer:
      "The Android app ships as a signed install straight from this page. Android may warn you once about installing from your browser — that is expected for apps distributed outside the store.",
  },
  {
    question: "Does the app work offline?",
    answer:
      "Notes, flashcards and quizzes you already have on your phone stay available without a connection. New AI generation waits until you are back online, then finishes on its own.",
  },
  {
    question: "How do I update the app?",
    answer:
      "Come back to this page, download the newest file and install it over the old copy. Your notes and review progress stay in place.",
  },
  {
    question: "Can I use Sua on an iPhone?",
    answer:
      "There is no iOS build yet. Use Sua in your phone’s browser instead — the same account and the same notes are there.",
  },
];

export default function DownloadPage() {
  return (
    <main>
      <header className="site-header">
        <div className="header-inner">
          <Link className="wordmark" href="/" aria-label="Sua home">
            <span className="brand-mark" aria-hidden="true">
              <Image
                src="/icon.png"
                alt=""
                width={34}
                height={34}
                className="brand-mark-image"
              />
            </span>
            <span>Sua</span>
          </Link>

          <nav className="main-nav" aria-label="Main navigation">
            <Link href="/">Home</Link>
            <Link href="/#features">Why Sua</Link>
            <Link href="/#about">Our promise</Link>
          </nav>

          <div className="header-actions">
            <Link className="header-signin" href="/sign-in">
              Sign in
            </Link>
            <Link className="header-cta" href="/app/home">
              Open Sua
            </Link>
          </div>
        </div>
      </header>

      <DownloadSection
        headingAs="h1"
        title={
          <>
            Download Sua
            <br />
            for <em>Android.</em>
          </>
        }
      />

      <section
        className="download-shots-section section-shell"
        aria-labelledby="download-shots-title"
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow eyebrow-dark">A look inside</div>
            <h2 id="download-shots-title">
              The app in <em>your pocket.</em>
            </h2>
          </div>
          <p>
            The same courses, notes and study sets you have on the web — built
            for a phone you can hold in one hand.
          </p>
        </div>
        <div className="download-shots">
          {shots.map((shot) => (
            <figure className="download-shot" key={shot.src}>
              <Image
                src={shot.src}
                alt={shot.alt}
                fill
                sizes="(max-width: 700px) 45vw, (max-width: 1180px) 22vw, 280px"
                quality={74}
              />
            </figure>
          ))}
        </div>
      </section>

      <section
        className="download-inside section-shell"
        aria-labelledby="download-inside-title"
      >
        <div className="section-heading">
          <div>
            <div className="eyebrow eyebrow-dark">What you get</div>
            <h2 id="download-inside-title">
              Built for <em>lecture days.</em>
            </h2>
          </div>
          <p>
            Long halls, shared slides and low data: the app is shaped around the
            study day you actually have.
          </p>
        </div>
        <div className="product-grid download-grid">
          {insideApp.map(({ Icon, title, copy, tag }) => (
            <article className="product-card" key={title}>
              <span className="product-icon" aria-hidden="true">
                <Icon size={22} strokeWidth={2} />
              </span>
              <h3>{title}</h3>
              <p>{copy}</p>
              <span className="product-tag">{tag}</span>
            </article>
          ))}
        </div>
      </section>

      <section
        className="download-support section-shell"
        aria-label="Install requirements and common questions"
      >
        <div className="download-panel">
          <h2>Before you install</h2>
          <p>A few things worth knowing before you tap download.</p>
          <ul className="download-requirements">
            {requirements.map((item) => (
              <li key={item.title}>
                <Check size={15} aria-hidden="true" />
                <span>
                  <strong>{item.title}.</strong> {item.copy}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="download-panel">
          <h2>Questions students ask</h2>
          <p>Short answers to the ones that come up most.</p>
          <div className="download-questions">
            {questions.map((item) => (
              <details className="download-question" key={item.question}>
                <summary>
                  {item.question}
                  <span className="download-question-icon" aria-hidden="true">
                    +
                  </span>
                </summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <Link className="wordmark footer-wordmark" href="/">
          <span className="brand-mark" aria-hidden="true">
            <Image
              src="/icon.png"
              alt=""
              width={28}
              height={28}
              className="brand-mark-image"
            />
          </span>
          <span>Sua</span>
        </Link>
        <p>Made for learning. Made for here.</p>
        <div className="footer-links">
          <Link href="/sign-up">Create an account</Link>
          <Link href="/policy">Privacy policy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/">Home ↑</Link>
        </div>
      </footer>
    </main>
  );
}
