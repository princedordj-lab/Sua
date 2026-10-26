"use client";

import Link from "next/link";
import {
  ChevronRight,
  Languages,
  Layers,
  Monitor,
  Moon,
  RotateCcw,
  Sparkles,
  Sun,
  Type,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  PageHeader,
  ProgressBar,
  Segmented,
  Toggle,
} from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { useAppearance, type AppearanceMode } from "@/config/appearance";
import { usePrefs, type SummaryLength } from "@/lib/prefs";
import type { NoteTextScale } from "@/lib/types";

const PREVIEW = `## Key idea
Photosynthesis turns light energy into **chemical energy**.

- Chlorophyll absorbs light
- Water splits, releasing oxygen
- ATP and NADPH power the Calvin cycle`;

export default function PreferencesPage() {
  const { mode, scheme, setMode } = useAppearance();
  const { prefs, update } = usePrefs();

  return (
    <div className="prefs-page">
      <PageHeader
        eyebrow="Make it yours"
        title="Preferences"
        description="Appearance, reading size and study defaults. Everything here applies to this browser; your phone keeps its own copy."
      />

      <div className="prefs-grid">
        <Card className="prefs-card">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              {scheme === "dark" ? <Moon size={18} /> : <Sun size={18} />}
            </span>
            <div>
              <h2>Appearance</h2>
              <p>Currently using the {scheme} theme.</p>
            </div>
          </div>
          <Segmented<AppearanceMode>
            label="Appearance"
            value={mode}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
            onChange={setMode}
          />
          <p className="prefs-note">
            System follows your device setting and switches automatically in the evening.
          </p>
        </Card>

        <Card className="prefs-card">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Layers size={18} />
            </span>
            <div>
              <h2>Review sessions</h2>
              <p>How many due cards one session covers.</p>
            </div>
            <Chip tone="brand">{prefs.reviewSessionLength} cards</Chip>
          </div>
          <Segmented<string>
            label="Review session length"
            value={String(prefs.reviewSessionLength)}
            options={[
              { value: "10", label: "10", hint: "Quick" },
              { value: "20", label: "20", hint: "Steady" },
              { value: "30", label: "30", hint: "Deep" },
            ]}
            onChange={(value) => update({ reviewSessionLength: Number(value) })}
          />
          <label className="prefs-range">
            <span>Custom length: {prefs.reviewSessionLength} cards</span>
            <input
              type="range"
              min={5}
              max={50}
              step={5}
              value={prefs.reviewSessionLength}
              onChange={(event) =>
                update({ reviewSessionLength: Number(event.target.value) })
              }
              aria-label="Custom review session length"
            />
          </label>
          <p className="prefs-note">
            The server clamps every session between 5 and 50 cards, matching the phone.
          </p>
        </Card>

        <Card className="prefs-card">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Type size={18} />
            </span>
            <div>
              <h2>Note text size</h2>
              <p>Applies to the note reader and summaries.</p>
            </div>
          </div>
          <Segmented<NoteTextScale>
            label="Note text size"
            value={prefs.noteTextScale}
            options={[
              { value: "small", label: "Small", hint: "14 px" },
              { value: "medium", label: "Medium", hint: "16 px" },
              { value: "large", label: "Large", hint: "20 px" },
            ]}
            onChange={(value) => update({ noteTextScale: value })}
          />
          <div className="prefs-preview">
            <p className="prefs-preview-label">Preview</p>
            <Markdown text={PREVIEW} scale={prefs.noteTextScale} />
          </div>
        </Card>

        <Card className="prefs-card">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Sparkles size={18} />
            </span>
            <div>
              <h2>AI output</h2>
              <p>How much detail Sua writes into summaries.</p>
            </div>
          </div>
          <Segmented<SummaryLength>
            label="Summary length"
            value={prefs.summaryLength}
            options={[
              { value: "short", label: "Short", hint: "Key points" },
              { value: "standard", label: "Standard", hint: "Balanced" },
              { value: "detailed", label: "Detailed", hint: "Full" },
            ]}
            onChange={(value) => update({ summaryLength: value })}
          />
          <div className="prefs-row">
            <span className="prefs-row-label">
              <Languages size={15} /> Language
            </span>
            <span className="prefs-row-value">English</span>
          </div>
          <p className="prefs-note">
            Summary length is a visual preference for now — the pipeline still writes its standard
            depth. It will be wired in with the next prompt update.
          </p>
        </Card>

        <Card className="prefs-card prefs-card-wide">
          <div className="prefs-card-head">
            <span className="prefs-icon">
              <Monitor size={18} />
            </span>
            <div>
              <h2>Capture defaults</h2>
              <p>Small choices that save a tap every time.</p>
            </div>
          </div>
          <Toggle
            label="Remember the last course"
            description="Open Create with the course you used most recently already selected."
            checked={prefs.rememberCaptureCourse}
            onChange={(checked) => update({ rememberCaptureCourse: checked })}
          />
          <div className="prefs-progress-demo">
            <span>Review goal preview</span>
            <ProgressBar value={62} label="Example progress" />
            <small>Progress bars and cards use the same tokens as the phone app.</small>
          </div>
        </Card>

        <Card className="prefs-card prefs-card-wide prefs-data">
          <div>
            <h2>Your data</h2>
            <p>
              Notes, uploads and study history live in your account. Manage your details or delete
              everything from the profile page.
            </p>
          </div>
          <div className="prefs-data-actions">
            <Link href="/app/profile" className="btn btn-secondary btn-sm">
              Open profile <ChevronRight size={14} />
            </Link>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={15} />}
              onClick={() =>
                update({
                  reviewSessionLength: 30,
                  noteTextScale: "medium",
                  rememberCaptureCourse: true,
                  summaryLength: "standard",
                  lastCourseId: null,
                })
              }
            >
              Reset preferences
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
