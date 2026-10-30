import Image from "next/image";
import Link from "next/link";
import { Download, ShieldCheck, Wifi } from "lucide-react";
import { androidApp } from "@/config/download";

const installSteps = [
  {
    title: "Download the file",
    copy: `It’s a ${androidApp.sizeLabel} install — stay on the page until it finishes.`,
  },
  {
    title: "Allow the install",
    copy: "If Android asks, let your browser install unknown apps.",
  },
  {
    title: "Install and sign in",
    copy: "Open the downloaded file, tap Install, then use your Sua account.",
  },
];

/**
 * Marketing band for the Android build. Server component: the only interactive
 * part is a plain link to the GitHub release asset, so nothing here needs to
 * cross into the client bundle.
 */
export function DownloadSection() {
  return (
    <section
      className="download-section section-shell"
      id="download"
      aria-labelledby="download-title"
    >
      <div className="download-copy">
        <div className="eyebrow eyebrow-dark">
          <span />
          Sua for Android
        </div>
        <h2 id="download-title">
          Take Sua with you
          <br />
          into the <em>lecture hall.</em>
        </h2>
        <p className="download-description">
          Record a class, photograph the board and study your notes on the bus
          home — the app keeps working when the network doesn’t, then catches up
          when you’re back online.
        </p>

        <div className="download-actions">
          <a
            className="button button-primary download-cta"
            href={androidApp.url}
            aria-label={`Download Sua ${androidApp.version} for Android (${androidApp.sizeLabel})`}
          >
            <Download size={17} aria-hidden="true" />
            Download for Android
          </a>
        </div>

        <p className="download-meta">
          <span>v{androidApp.version}</span>
          <span aria-hidden="true">·</span>
          <span>{androidApp.sizeLabel}</span>
          <span aria-hidden="true">·</span>
          <span>Android {androidApp.minAndroid}+</span>
          <span aria-hidden="true">·</span>
          <span>Free</span>
        </p>

        <details className="download-integrity">
          <summary>
            <ShieldCheck size={13} aria-hidden="true" />
            Check the download
          </summary>
          <p>
            The APK is signed by Sua and installed straight from this page, not
            through the Play Store. After downloading, the file’s SHA-256 should
            read:
            <code>{androidApp.sha256}</code>
          </p>
        </details>

        <p className="download-ios">
          On iPhone? <Link href="/app/home">Use Sua on the web</Link> for now —
          your courses and notes are the same account.
        </p>
      </div>

      <div className="download-card">
        <div className="download-app">
          <Image
            className="download-app-icon"
            src="/icon.png"
            alt=""
            width={46}
            height={46}
          />
          <div>
            <strong>Sua</strong>
            <small>Study sets, notes and review</small>
          </div>
          <span className="download-badge">Android</span>
        </div>

        <dl className="download-facts">
          <div>
            <dt>Version</dt>
            <dd>{androidApp.version}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>{androidApp.sizeLabel}</dd>
          </div>
          <div>
            <dt>Android</dt>
            <dd>{androidApp.minAndroid}+</dd>
          </div>
        </dl>

        <ol className="download-steps">
          {installSteps.map((step) => (
            <li key={step.title}>
              <span>
                <strong>{step.title}.</strong> {step.copy}
              </span>
            </li>
          ))}
        </ol>

        <p className="download-hint">
          <Wifi size={15} aria-hidden="true" />
          Wi-Fi recommended — the download is {androidApp.sizeLabel}.
        </p>
      </div>
    </section>
  );
}
