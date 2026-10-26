import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How Sua handles account details, study materials, and information needed to provide the app.",
};

export default function PolicyPage() {
  return (
    <LegalPage
      eyebrow="Your work stays yours"
      title="Privacy policy"
      intro="Sua helps turn lectures and notes into study tools. This page explains what information the app handles, why it is used, and the choices available to you."
      sections={[
        {
          id: "information",
          title: "Information Sua handles",
          content: <>
            <p><strong>Account and profile details.</strong> When you create an account, Sua receives identity and sign-in details from Clerk, such as your email address and name. You may also add profile details such as your university, programme, and level.</p>
            <p><strong>Your study materials.</strong> This includes courses, notes, recordings, documents, transcripts, summaries, flashcards, quizzes, and study activity you create or ask Sua to generate.</p>
            <p><strong>Basic technical information.</strong> The website and service providers may process information needed to deliver and secure the service, such as device, browser, network, and request details.</p>
          </>,
        },
        {
          id: "use",
          title: "How information is used",
          content: <>
            <p>Sua uses this information to sign you in, sync your work, store your courses and study materials, generate requested study features, keep the service secure, and respond to account actions such as deletion.</p>
            <p>Some features send the relevant material to service providers that operate authentication, databases and file storage, transcription or document extraction, and AI text generation. Those providers process information to deliver the requested feature under their own terms and privacy practices.</p>
          </>,
        },
        {
          id: "providers",
          title: "Service providers",
          content: <>
            <p>Sua currently relies on Clerk for authentication, Neon for database and file storage, Google AI services for tasks such as transcription or document extraction, and an AI text-generation provider for study outputs. Older files may also use Cloudinary through a compatibility path.</p>
            <p>Study materials are sent for processing only when needed for a feature you use, such as generating a summary or asking Sua a question. The privacy and retention practices of each provider are governed by that provider’s terms and settings.</p>
          </>,
        },
        {
          id: "device",
          title: "Your device and browser",
          content: <>
            <p>The mobile app can keep notes and study materials on your device for offline access and sync them when you reconnect. The web app uses browser storage for your appearance preference. Sign-in may use cookies or similar browser storage to maintain your session.</p>
            <p>Removing the app or clearing browser data may remove locally stored information that has not synced. Keep a copy of anything important before clearing app data or changing devices.</p>
          </>,
        },
        {
          id: "sharing",
          title: "Sharing and visibility",
          content: <>
            <p>Your study materials are associated with your account and are used to provide your Sua experience. Sua does not make private notes or recordings public as part of ordinary use. If sharing features are added, the choices and terms for those features will be explained in the product.</p>
            <p>Information may also be disclosed when required to comply with law, protect the service or its users, or carry out a request you make.</p>
          </>,
        },
        {
          id: "retention",
          title: "Keeping and deleting information",
          content: <>
            <p>You can delete individual study materials in the app. You can also request account deletion from the account controls. Sua then removes the account’s records and attempts to remove associated stored files.</p>
            <p>Some copies may remain for a limited time in provider backups, security logs, or records that must be kept by law. Storage providers may also need time to complete deletion.</p>
          </>,
        },
        {
          id: "security",
          title: "Security and changes",
          content: <>
            <p>Sua uses account authentication, access controls, and service-provider security measures to protect information. No online service or device can be guaranteed completely secure, so protect your sign-in details and device.</p>
            <p>This policy may change as the service changes. The current version and its update date will appear on this page.</p>
          </>,
        },
      ]}
    />
  );
}
