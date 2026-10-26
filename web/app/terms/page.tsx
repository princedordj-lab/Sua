import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of use",
  description: "Terms for using Sua to capture lectures, manage notes, and practise for exams.",
};

export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="A fair way to learn"
      title="Terms of use"
      intro="These terms explain the ground rules for using Sua. By creating an account or using the service, you agree to follow them."
      sections={[
        {
          id: "using-sua",
          title: "Using Sua",
          content: <>
            <p>Sua is a study tool for capturing lectures and materials, organising courses, and creating revision aids. You are responsible for the activity on your account and for keeping your sign-in details secure.</p>
            <p>Use Sua lawfully and in a way that does not disrupt the service or other people. Do not access another person’s account, upload material you do not have permission to use, or attempt to interfere with the app or its security.</p>
          </>,
        },
        {
          id: "your-material",
          title: "Your materials",
          content: <>
            <p>You keep your rights to the notes, recordings, and other materials you submit. You allow Sua and its service providers to host, copy, and process those materials only as needed to operate the service and provide features you request.</p>
            <p>You are responsible for making sure you may record, upload, and process the material you provide, including lecture recordings and course documents.</p>
          </>,
        },
        {
          id: "ai-outputs",
          title: "AI-generated study materials",
          content: <>
            <p>Summaries, transcripts, answers, flashcards, and quizzes may be generated or processed automatically. They can be incomplete or incorrect and are not a substitute for your course materials, lecturer guidance, or independent judgement.</p>
            <p>Review generated content before relying on it for coursework or exam preparation. Sua does not promise a particular grade, result, or level of accuracy.</p>
          </>,
        },
        {
          id: "service",
          title: "Service availability and changes",
          content: <>
            <p>Sua may change, pause, or discontinue features as the service develops. Some functions require an internet connection and may be unavailable during maintenance, provider outages, or network interruptions. Offline features depend on what has already been saved to your device.</p>
            <p>Keep copies of important materials. Sua works to sync account data, but you should not treat the service as the only backup for irreplaceable files.</p>
          </>,
        },
        {
          id: "plans",
          title: "Plans and payments",
          content: <>
            <p>If Sua offers a paid plan or purchase, the price, billing period, included features, and renewal or cancellation terms will be shown when you subscribe. Those checkout terms apply to that purchase.</p>
            <p>Features and limits may differ by plan and may change. Any material change to a paid plan will be communicated through the applicable product or purchase channel.</p>
          </>,
        },
        {
          id: "account",
          title: "Account suspension and deletion",
          content: <>
            <p>You may stop using Sua and request deletion through the account controls. Sua may restrict or suspend access when needed to protect users, the service, or comply with law.</p>
            <p>When an account is deleted, associated account records and stored files are scheduled for removal. Separate provider backups or records that must be retained by law may remain for a limited period.</p>
          </>,
        },
        {
          id: "terms-changes",
          title: "Updates to these terms",
          content: <>
            <p>These terms may be updated when Sua changes. The current terms and their update date will be available on this page. Continuing to use Sua after an update means you accept the revised terms.</p>
            <p>If you do not agree with an update, stop using the service and use the account controls to request deletion.</p>
          </>,
        },
      ]}
    />
  );
}
