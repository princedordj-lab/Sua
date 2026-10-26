"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  ChevronRight,
  GraduationCap,
  KeyRound,
  LogOut,
  Mail,
  Pencil,
  Settings,
  ShieldAlert,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useAppData } from "@/components/app-data";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Chip,
  Field,
  LoadingBlock,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  TextInput,
} from "@/components/ui";
import { useApi } from "@/lib/use-api";
import { monthLabel } from "@/lib/format";

const LEVELS = ["Level 100", "Level 200", "Level 300", "Level 400", "Postgraduate"];

export default function ProfilePage() {
  const api = useApi();
  const router = useRouter();
  const { user } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const { profile, courses, error, refresh, refreshProfile } = useAppData();

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [phrase, setPhrase] = useState("");

  const closeEditor = useCallback(() => setEditOpen(false), []);
  const closeDelete = useCallback(() => {
    setDeleteOpen(false);
    setPhrase("");
  }, []);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    university: "",
    programme: "",
    level: "Level 100",
  });

  if (error && !profile) {
    return (
      <div>
        <PageHeader title="Profile" />
        <Alert title="Could not load your account">{error}</Alert>
        <Button variant="secondary" onClick={refresh}>
          Try again
        </Button>
      </div>
    );
  }

  if (!profile) return <LoadingBlock rows={5} />;

  const name = profile.name || user?.fullName || "Sua student";
  const email = profile.email || user?.primaryEmailAddress?.emailAddress || "";
  const noteCount = courses.reduce((total, course) => total + course.noteCount, 0);
  const usage = profile.usage;
  const plan = profile.plan === "pro" ? "Pro" : "Free";

  function openEditor() {
    if (!profile) return;
    setForm({
      name: profile.name ?? "",
      university: profile.university ?? "",
      programme: profile.programme ?? "",
      level: profile.level || "Level 100",
    });
    setActionError(null);
    setEditOpen(true);
  }

  async function saveProfile() {
    if (!form.name.trim()) {
      setActionError("Add your name so Sua can greet you properly.");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await api.profile.update({
        name: form.name.trim(),
        university: form.university.trim(),
        programme: form.programme.trim(),
        level: form.level,
      });
      await refreshProfile();
      setEditOpen(false);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not save your profile.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteAccount() {
    if (phrase.trim().toUpperCase() !== "DELETE" || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.profile.deleteAccount();
      await signOut({ redirectUrl: "/" });
      router.replace("/");
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "The server is unreachable. Nothing was deleted — try again when you are online.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="profile-page">
      <PageHeader
        eyebrow="Your account"
        title="Profile"
        description="Your details, plan and study usage. One account keeps the web and phone in sync."
        actions={
          <Button variant="secondary" onClick={openEditor} icon={<Pencil size={16} />}>
            Edit profile
          </Button>
        }
      />

      <Card className="profile-hero">
        <Avatar name={name} imageUrl={user?.imageUrl} size={72} />
        <div className="profile-hero-copy">
          <h2>{name}</h2>
          <p>
            <Mail size={14} /> {email}
          </p>
          <div className="profile-hero-chips">
            <Chip tone={plan === "Pro" ? "gold" : "brand"}>{plan} plan</Chip>
            {profile.level ? <Chip tone="muted">{profile.level}</Chip> : null}
            {profile.programme ? <Chip tone="muted">{profile.programme}</Chip> : null}
          </div>
        </div>
        <div className="profile-hero-stats">
          <div>
            <strong>{courses.length}</strong>
            <span>{courses.length === 1 ? "course" : "courses"}</span>
          </div>
          <div>
            <strong>{noteCount}</strong>
            <span>{noteCount === 1 ? "note" : "notes"}</span>
          </div>
        </div>
      </Card>

      <div className="profile-columns">
        <div className="profile-column">
          <Card className="profile-details">
            <div className="profile-section-head">
              <div>
                <h2 className="section-title">About you</h2>
                <p className="section-hint">Shown only to you inside Sua.</p>
              </div>
              <Button variant="ghost" size="sm" onClick={openEditor}>
                Edit
              </Button>
            </div>
            <dl className="profile-list">
              <div>
                <dt>
                  <UserRound size={15} /> Name
                </dt>
                <dd>{profile.name || "Not set"}</dd>
              </div>
              <div>
                <dt>
                  <GraduationCap size={15} /> University
                </dt>
                <dd>{profile.university || "Not set"}</dd>
              </div>
              <div>
                <dt>
                  <BookOpen size={15} /> Programme
                </dt>
                <dd>{profile.programme || "Not set"}</dd>
              </div>
              <div>
                <dt>
                  <GraduationCap size={15} /> Level
                </dt>
                <dd>{profile.level || "Not set"}</dd>
              </div>
            </dl>
          </Card>

          <Card className="profile-usage">
            <div className="profile-section-head">
              <div>
                <h2 className="section-title">This month</h2>
                <p className="section-hint">{monthLabel(usage.month)} · resets monthly</p>
              </div>
              <Chip tone="muted">Free plan</Chip>
            </div>
            <div className="profile-meter-grid">
              <UsageMeter
                label="Summaries"
                value={usage.summaries}
                limit={usage.limits.summaries}
              />
              <UsageMeter
                label="Study sets"
                value={usage.studySets}
                limit={usage.limits.studySets}
              />
              <UsageMeter
                label="Reference sheets"
                value={usage.references}
                limit={usage.limits.references}
              />
              <UsageMeter
                label="Ask Sua questions"
                value={usage.assistantQueries}
                limit={usage.limits.assistantQueries}
                tone="gold"
              />
            </div>
            <p className="profile-usage-note">
              Free-plan limits are shown for transparency. Billing arrives on mobile first.
            </p>
          </Card>
        </div>

        <div className="profile-column">
          <Card className="profile-links">
            <Link href="/app/preferences" className="profile-link">
              <span className="profile-link-icon">
                <Settings size={17} />
              </span>
              <span>
                <strong>Preferences</strong>
                <small>Appearance, note text size, review length</small>
              </span>
              <ChevronRight size={17} />
            </Link>
            <Link href="/app/ask-sua" className="profile-link">
              <span className="profile-link-icon">
                <Sparkles size={17} />
              </span>
              <span>
                <strong>Ask Sua</strong>
                <small>Grounded answers from your notes</small>
              </span>
              <ChevronRight size={17} />
            </Link>
            <button type="button" className="profile-link" onClick={() => openUserProfile()}>
              <span className="profile-link-icon">
                <KeyRound size={17} />
              </span>
              <span>
                <strong>Sign-in & security</strong>
                <small>Password, email and active sessions via Clerk</small>
              </span>
              <ChevronRight size={17} />
            </button>
            <button
              type="button"
              className="profile-link"
              onClick={() => void signOut({ redirectUrl: "/" })}
            >
              <span className="profile-link-icon">
                <LogOut size={17} />
              </span>
              <span>
                <strong>Sign out</strong>
                <small>You can sign back in anytime</small>
              </span>
              <ChevronRight size={17} />
            </button>
          </Card>

          <Card className="profile-danger">
            <div className="profile-danger-head">
              <ShieldAlert size={19} />
              <h2>Delete account</h2>
            </div>
            <p>
              Permanently removes your courses, notes, uploads, study sets, review history and Ask
              Sua conversations on every device.
            </p>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setPhrase("");
                setActionError(null);
                setDeleteOpen(true);
              }}
            >
              Delete my account
            </Button>
          </Card>
        </div>
      </div>

      <Modal
        open={editOpen}
        onClose={closeEditor}
        title="Edit profile"
        description="These details personalise Sua and appear on your profile."
        footer={
          <>
            <Button variant="ghost" onClick={closeEditor}>
              Cancel
            </Button>
            <Button busy={busy} onClick={() => void saveProfile()}>
              Save changes
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not save">{actionError}</Alert> : null}
        <div className="form-grid">
          <Field label="Your name" htmlFor="profile-name">
            <TextInput
              id="profile-name"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              autoComplete="name"
            />
          </Field>
          <Field label="University" htmlFor="profile-university">
            <TextInput
              id="profile-university"
              value={form.university}
              onChange={(event) => setForm({ ...form, university: event.target.value })}
              placeholder="e.g. University of Ghana"
            />
          </Field>
          <Field label="Programme" htmlFor="profile-programme">
            <TextInput
              id="profile-programme"
              value={form.programme}
              onChange={(event) => setForm({ ...form, programme: event.target.value })}
              placeholder="e.g. BSc Computer Science"
            />
          </Field>
          <Field label="Level" htmlFor="profile-level">
            <Select
              id="profile-level"
              value={form.level}
              onChange={(event) => setForm({ ...form, level: event.target.value })}
            >
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={closeDelete}
        title="Delete your account?"
        description="This is permanent. It removes everything on the server and on every device."
        footer={
          <>
            <Button
              variant="ghost"
              onClick={closeDelete}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy}
              disabled={phrase.trim().toUpperCase() !== "DELETE"}
              onClick={() => void deleteAccount()}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {actionError ? <Alert title="Could not delete the account">{actionError}</Alert> : null}
        <Alert tone="warning" title="This cannot be undone">
          Courses, notes, typed drafts, recordings, uploads, summaries, flashcards, quizzes, review
          history and Ask Sua conversations are all removed. Queued uploads and generations are
          cancelled.
        </Alert>
        <Field
          label="Type DELETE to confirm"
          htmlFor="delete-phrase"
          hint="Use capital letters."
        >
          <TextInput
            id="delete-phrase"
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder="DELETE"
            autoComplete="off"
            autoCapitalize="characters"
          />
        </Field>
      </Modal>
    </div>
  );
}

function UsageMeter({
  label,
  value,
  limit,
  tone = "brand",
}: {
  label: string;
  value: number;
  limit: number;
  tone?: "brand" | "gold";
}) {
  const percent = (value / Math.max(1, limit)) * 100;
  return (
    <div className="profile-meter">
      <div className="profile-meter-head">
        <span>{label}</span>
        <strong>
          {value}/{limit}
        </strong>
      </div>
      <ProgressBar value={percent} tone={tone} label={`${label} used`} />
    </div>
  );
}
