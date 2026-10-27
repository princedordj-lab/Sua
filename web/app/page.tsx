import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  BookOpen,
  Brain,
  CalendarClock,
  CloudUpload,
  ListChecks,
} from "lucide-react";
import { SuaChatMark, type SuaChatIconComponent } from "@/components/sua-chat-icon";
import {
  LandingClosingActions,
  LandingHeaderCta,
  LandingHeroActions,
} from "@/components/landing-ctas";

export const metadata: Metadata = {
  title: "Study smarter with Sua",
  description:
    "Turn lectures, slides, and notes into summaries, flashcards, and quizzes. Sua helps African university students study with confidence, online or offline.",
  openGraph: {
    title: "Study smarter with Sua",
    description:
      "Your lectures, turned into exam confidence. Made for students across Ghana and Africa.",
    type: "website",
  },
};

function SuaMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <Image
        src="/icon.png"
        alt=""
        width={36}
        height={36}
        className="brand-mark-image"
      />
    </span>
  );
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m12 2 1.8 7.1L21 12l-7.2 2.1L12 21l-1.8-6.9L3 12l7.2-2.9L12 2Z"
        fill="currentColor"
      />
    </svg>
  );
}

const steps = [
  {
    number: "01",
    title: "Capture the class",
    copy: "Record a lecture, add your slides, or type notes into a course.",
    icon: "◉",
    image: "/screens/Onboarding3.jpeg",
    imageAlt: "A student recording a lecture in a university auditorium",
  },
  {
    number: "02",
    title: "Get study-ready",
    copy: "Sua turns your material into a clear summary, flashcards, and a quiz.",
    icon: "✳",
    image: "/screens/Onboarding1.jpeg",
    imageAlt: "A student reviewing study notes on a phone",
  },
  {
    number: "03",
    title: "Make it stick",
    copy: "Review in short sessions and see what to focus on before the exam.",
    icon: "↗",
    image: "/screens/Onboarding2.jpeg",
    imageAlt: "A student studying outside between classes",
  },
];

const features = [
  {
    number: "01",
    title: "Your lecture, made clear",
    copy: "Go from a long recording or a stack of slides to key points, terms, and questions worth practising.",
    detail: "Summaries · flashcards · quizzes",
    className: "feature-card--summary",
  },
  {
    number: "02",
    title: "Study, even when the network drops",
    copy: "Keep your notes and downloaded study sets close. When you’re offline, new AI generation waits until you reconnect.",
    detail: "Built for low-data days",
    className: "feature-card--offline",
  },
  {
    number: "03",
    title: "Keep the exam in view",
    copy: "A little revision each day helps you spend less time cramming and more time knowing what you know.",
    detail: "Small sessions · steady progress",
    className: "feature-card--exam",
  },
];

type ProductFeature = {
  Icon: SuaChatIconComponent;
  title: string;
  copy: string;
  tag: string;
};

const productFeatures: ProductFeature[] = [
  {
    Icon: CalendarClock,
    title: "Courses with the exam in view",
    copy: "Group notes by paper, add your lecturer and exam date, and keep the countdown in front of you.",
    tag: "Courses",
  },
  {
    Icon: CloudUpload,
    title: "Record, upload or type",
    copy: "Capture a lecture, drop in slides and PDFs, or type your own notes. Sua works with what you already have.",
    tag: "Capture",
  },
  {
    Icon: BookOpen,
    title: "A study set from every note",
    copy: "One generation writes structured notes, a summary, flashcards and a quiz from the same source.",
    tag: "AI study sets",
  },
  {
    Icon: SuaChatMark,
    title: "Ask Sua about your notes",
    copy: "Ask a question for one course and get an answer grounded in those notes, with the sources it used.",
    tag: "Ask Sua",
  },
  {
    Icon: Brain,
    title: "Review that adapts to you",
    copy: "Spaced repetition schedules each card for the moment you’re about to forget it — short sessions add up.",
    tag: "Review",
  },
  {
    Icon: ListChecks,
    title: "Quizzes with real marking",
    copy: "Multiple choice and true/false grade instantly. Short answers are marked by AI, and mistakes become cards.",
    tag: "Quizzes",
  },
];

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <div className="header-inner">
          <a className="wordmark" href="#top" aria-label="Sua home">
            <SuaMark />
            <span>Sua</span>
          </a>

          <nav className="main-nav" aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="#product">Inside the app</a>
            <a href="#features">Why Sua</a>
            <a href="#about">Our promise</a>
          </nav>

          <LandingHeaderCta />
        </div>
      </header>

      <section className="hero section-shell" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span /> Made for the way you learn</div>
          <h1>
            Your lectures,
            <br />
            turned into <em>exam</em>
            <br />
            confidence.
          </h1>
          <p className="hero-description">
            Record a class, add your slides, or type your notes. Sua turns them
            into the study tools you need to walk into exams ready.
          </p>
          <LandingHeroActions />
          <div className="hero-note">
            <span className="note-spark"><SparkIcon /></span>
            <p>Free to start · your courses and notes follow you between web and mobile.</p>
          </div>
        </div>

        <div
          className="hero-art"
          role="img"
          aria-label="Illustration of Ama’s Sua study dashboard with a daily review and course study sets"
        >
          <div className="art-orbit art-orbit-one" />
          <div className="art-orbit art-orbit-two" />
          <div className="floating-note floating-note-top">
            <span className="floating-icon floating-icon-gold">✦</span>
            <span><strong>Lecture captured</strong><small>Ready when you are</small></span>
          </div>
          <div className="dashboard-card">
            <div className="dashboard-topbar">
              <div className="dashboard-brand"><SuaMark /><b>Sua</b></div>
              <div className="dashboard-avatar">A</div>
            </div>
            <div className="dashboard-greeting">
              <span>TODAY’S STUDY SPACE</span>
              <h2>Good morning, Ama <span>✳</span></h2>
              <p>A little progress goes a long way.</p>
            </div>
            <div className="dashboard-review">
              <div className="review-icon">✦</div>
              <div className="review-copy"><small>YOUR DAILY REVIEW</small><strong>Ready when you are</strong></div>
              <div className="review-count"><strong>12</strong><small>cards</small></div>
            </div>
            <div className="dashboard-label-row"><strong>Pick up where you left off</strong><span>See all</span></div>
            <div className="dashboard-course">
              <div className="course-symbol course-symbol-green">∑</div>
              <div className="course-copy"><strong>Engineering Mathematics</strong><small>MATH 251 · 2 study sets</small></div>
              <span className="course-arrow">↗</span>
            </div>
            <div className="dashboard-course">
              <div className="course-symbol course-symbol-gold">⌁</div>
              <div className="course-copy"><strong>Fluid Mechanics</strong><small>ME 317 · 1 new summary</small></div>
              <span className="course-arrow">↗</span>
            </div>
            <div className="dashboard-tabs"><span className="tab-active">⌂<small>Home</small></span><span>▤<small>Courses</small></span><span>＋<small>Create</small></span><span>✳<small>Study</small></span></div>
          </div>
          <div className="floating-note floating-note-bottom">
            <span className="progress-ring">✓</span>
            <span><strong>Study set ready</strong><small>Summary · cards · quiz</small></span>
          </div>
          <span className="art-star art-star-one">✳</span>
          <span className="art-star art-star-two">✦</span>
        </div>
        <div className="hero-bottom-line"><span>LEARN WITH PURPOSE</span><span>BUILT FOR YOUR NEXT EXAM ↓</span></div>
      </section>

      <section className="how-section section-shell" id="how-it-works">
        <div className="section-heading">
          <div>
            <div className="eyebrow eyebrow-dark">A simpler study loop</div>
            <h2>From lecture hall<br />to <em>“I’ve got this.”</em></h2>
          </div>
          <p>Everything you need to turn what you learn in class into what you remember in the exam.</p>
        </div>
        <div className="steps-grid">
          {steps.map((step) => (
            <article className="step-card" key={step.number}>
              <div className="step-image">
                <Image
                  src={step.image}
                  alt={step.imageAlt}
                  fill
                  sizes="(max-width: 700px) calc(100vw - 80px), (max-width: 960px) 30vw, 360px"
                  quality={76}
                />
                <span className="step-image-wash" aria-hidden="true" />
              </div>
              <div className="step-content">
                <div className="step-topline"><span>{step.number}</span><span className="step-icon">{step.icon}</span></div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="product-section section-shell" id="product">
        <div className="section-heading">
          <div>
            <div className="eyebrow eyebrow-dark">Inside the app</div>
            <h2>
              Everything you need
              <br />
              in <em>one study space.</em>
            </h2>
          </div>
          <p>
            Sign in once and your courses, notes, review progress and study sets
            follow you between the web and the mobile app.
          </p>
        </div>
        <div className="product-grid">
          {productFeatures.map(({ Icon, title, copy, tag }) => (
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

      <section className="features-section" id="features">
        <div className="section-shell">
          <div className="section-heading features-heading">
            <div>
              <div className="eyebrow">Made for real student life</div>
              <h2>More than notes.<br /><em>A way forward.</em></h2>
            </div>
            <p>Lecture days are full. Data can be scarce. Sua helps you make each study moment count.</p>
          </div>
          <div className="features-grid">
            {features.map((feature) => (
              <article className={`feature-card ${feature.className}`} key={feature.number}>
                <div className="feature-number">{feature.number}</div>
                <div className="feature-illustration" aria-hidden="true">
                  {feature.number === "01" ? (
                    <div className="mini-stack"><span className="mini-sheet mini-sheet-back" /><span className="mini-sheet mini-sheet-front"><i /><i /><i /><b>Key ideas</b><i /></span><span className="mini-badge">✦</span></div>
                  ) : feature.number === "02" ? (
                    <div className="offline-scene"><span className="offline-sun">☼</span><div className="offline-card"><span>◉</span><b>Your notes,<br />right here.</b><i>Available offline</i></div><span className="offline-dot" /></div>
                  ) : (
                    <div className="exam-scene"><div className="exam-paper"><small>NEXT UP</small><b>Fluid Mechanics</b><span className="exam-line" /><span className="exam-line short" /><div className="exam-check">✓</div></div><span className="exam-star">✳</span></div>
                  )}
                </div>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
                <div className="feature-detail"><span />{feature.detail}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="promise-section section-shell" id="about">
        <div className="promise-mark"><SuaMark /></div>
        <div className="promise-copy">
          <div className="eyebrow eyebrow-dark">The Sua promise</div>
          <h2>Learning should fit your life, <em>not the other way around.</em></h2>
          <p>Built around the way students here learn: long lectures, shared notes, limited data, and exams that matter.</p>
        </div>
        <a className="promise-link" href="#top" aria-label="Back to top">↑</a>
      </section>

      <section className="closing-section">
        <div className="closing-pattern" aria-hidden="true">✳</div>
        <div className="closing-content">
          <div className="eyebrow">Your next exam starts today</div>
          <h2>Hear it once.<br /><em>Know it for the exam.</em></h2>
          <p>Make the most of every lecture, one study session at a time.</p>
          <LandingClosingActions />
        </div>
      </section>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="#top"><SuaMark /><span>Sua</span></a>
        <p>Made for learning. Made for here.</p>
        <div className="footer-links">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-up">Create an account</Link>
          <Link href="/policy">Privacy policy</Link>
          <Link href="/terms">Terms</Link>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </main>
  );
}
