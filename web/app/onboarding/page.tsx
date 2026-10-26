"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { CalendarDays, ChevronRight, GraduationCap } from "lucide-react";
import { Logo } from "@/components/logo";
import { Alert, Button, Field, Select, TextInput } from "@/components/ui";
import { useApi } from "@/lib/use-api";
import { COURSE_COLOURS, courseStyle } from "@/lib/course-style";

const LEVELS = ["Level 100", "Level 200", "Level 300", "Level 400", "Postgraduate"];

export default function OnboardingPage() {
  const router = useRouter();
  const { user } = useUser();
  const api = useApi();
  const [name, setName] = useState(user?.fullName ?? user?.firstName ?? "");
  const [university, setUniversity] = useState("");
  const [programme, setProgramme] = useState("");
  const [level, setLevel] = useState("Level 100");
  const [courseName, setCourseName] = useState("");
  const [courseCode, setCourseCode] = useState("");
  const [examDate, setExamDate] = useState("");
  const [colour, setColour] = useState<string>(COURSE_COLOURS[1].hex);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = courseStyle(colour);

  async function finish(skip = false) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.courses.create({
        name: skip ? "My first course" : courseName.trim() || "My first course",
        code: skip ? "COURSE 101" : courseCode.trim() || "COURSE 101",
        examDate: skip ? null : examDate || null,
        colour,
        lecturer: null,
      });
      await api.profile.update({
        name: name.trim() || user?.fullName || "Student",
        university: skip ? "" : university.trim(),
        programme: skip ? "" : programme.trim(),
        level: skip ? "" : level,
        onboardingCompleted: true,
      });
      router.replace("/app/home");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not finish setup. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <div className="onboarding-card">
        <Logo href="/" />
        <div className="onboarding-heading">
          <p className="eyebrow-sm">One minute of setup</p>
          <h1>Make Sua yours.</h1>
          <p>A few details help Sua build your first study space and count down to the exam.</p>
        </div>

        {error ? <Alert title="Could not finish setup">{error}</Alert> : null}

        <div className="onboarding-grid">
          <Field label="Your name" htmlFor="ob-name">
            <TextInput
              id="ob-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Ama Mensah"
              autoComplete="name"
            />
          </Field>
          <Field label="University" htmlFor="ob-university" hint="You can change this later.">
            <TextInput
              id="ob-university"
              value={university}
              onChange={(event) => setUniversity(event.target.value)}
              placeholder="e.g. University of Ghana"
            />
          </Field>
          <Field label="Programme" htmlFor="ob-programme">
            <TextInput
              id="ob-programme"
              value={programme}
              onChange={(event) => setProgramme(event.target.value)}
              placeholder="e.g. BSc Computer Science"
            />
          </Field>
          <Field label="Current level" htmlFor="ob-level">
            <Select id="ob-level" value={level} onChange={(event) => setLevel(event.target.value)}>
              {LEVELS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="onboarding-divider" />

        <div className="onboarding-section-title">
          <GraduationCap size={19} aria-hidden="true" />
          <div>
            <h2>Your first course</h2>
            <p>You can add the rest of the semester after this.</p>
          </div>
        </div>

        <div className="onboarding-grid">
          <Field label="Course name" htmlFor="ob-course">
            <TextInput
              id="ob-course"
              value={courseName}
              onChange={(event) => setCourseName(event.target.value)}
              placeholder="e.g. Principles of Economics"
            />
          </Field>
          <Field label="Course code" htmlFor="ob-code" hint="Optional, but it shows on note tiles.">
            <TextInput
              id="ob-code"
              value={courseCode}
              onChange={(event) => setCourseCode(event.target.value)}
              placeholder="e.g. ECON 101"
            />
          </Field>
          <Field label="Exam date" htmlFor="ob-exam" hint="Optional — Sua counts down to it.">
            <div className="input-with-icon">
              <CalendarDays size={17} aria-hidden="true" />
              <TextInput
                id="ob-exam"
                type="date"
                value={examDate}
                onChange={(event) => setExamDate(event.target.value)}
              />
            </div>
          </Field>
          <div className="field">
            <span className="field-label">Course colour</span>
            <div className="colour-row" role="radiogroup" aria-label="Course colour">
              {COURSE_COLOURS.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="radio"
                  aria-checked={colour === entry.hex}
                  aria-label={entry.key}
                  className={`colour-swatch ${entry.dot} ${colour === entry.hex ? "is-selected" : ""}`}
                  onClick={() => setColour(entry.hex)}
                />
              ))}
            </div>
            <p className="field-hint">
              Tiles and chips will use{" "}
              <span className={`colour-preview ${selected.tint} ${selected.text}`}>{selected.key}</span>.
            </p>
          </div>
        </div>

        <div className="onboarding-actions">
          <Button variant="ghost" onClick={() => void finish(true)} disabled={busy}>
            Skip for now
          </Button>
          <Button busy={busy} icon={<ChevronRight size={17} />} onClick={() => void finish(false)}>
            Start studying
          </Button>
        </div>
      </div>
    </main>
  );
}
