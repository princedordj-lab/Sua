import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

type LegalSection = {
  id: string;
  title: string;
  content: ReactNode;
};

type LegalPageProps = {
  title: string;
  eyebrow: string;
  intro: string;
  sections: LegalSection[];
};

export function LegalPage({ title, eyebrow, intro, sections }: LegalPageProps) {
  return (
    <main className="legal-page">
      <header className="legal-header">
        <Link className="wordmark legal-wordmark" href="/" aria-label="Sua home">
          <Image src="/icon.png" alt="" width={34} height={34} />
          <span>Sua</span>
        </Link>
        <Link className="legal-home-link" href="/">
          <span aria-hidden="true">←</span> Back to Sua
        </Link>
      </header>

      <section className="legal-hero" aria-labelledby="legal-title">
        <div className="legal-hero-copy">
          <p className="legal-eyebrow"><span /> {eyebrow}</p>
          <h1 id="legal-title">{title}</h1>
          <p className="legal-intro">{intro}</p>
        </div>
        <div className="legal-date-card">
          <span className="legal-date-mark" aria-hidden="true">S</span>
          <span className="legal-date-label">Last updated</span>
          <time dateTime="2026-10-26">October 26, 2026</time>
          <span className="legal-date-caption">Clear terms for a better study day.</span>
        </div>
      </section>

      <div className="legal-layout">
        <nav className="legal-toc" aria-label="On this page">
          <p>On this page</p>
          <ol>
            {sections.map((section, index) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <article className="legal-document">
          {sections.map((section, index) => (
            <section className="legal-section" id={section.id} key={section.id}>
              <div className="legal-section-number">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h2>{section.title}</h2>
                <div className="legal-prose">{section.content}</div>
              </div>
            </section>
          ))}
          <aside className="legal-note">
            <span className="legal-note-star" aria-hidden="true">✳</span>
            <p>Good learning starts with trust. We’ll keep these pages current when Sua’s practices change.</p>
          </aside>
        </article>
      </div>

      <footer className="legal-footer">
        <Link className="legal-footer-brand" href="/">Sua <span>· Made for learning. Made for here.</span></Link>
        <div>
          <Link href="/policy">Privacy policy</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/">Home</Link>
        </div>
      </footer>
    </main>
  );
}
