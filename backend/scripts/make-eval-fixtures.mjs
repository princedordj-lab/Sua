/**
 * Generate the eval fixtures in scripts/eval-samples/.
 *
 *   node scripts/make-eval-fixtures.mjs
 *
 * Everything is deterministic, so the files can be regenerated instead of being
 * committed as binaries. Text samples are the long/messy cases; the PPTX, PDFs
 * and PNG exercise the real extraction + OCR paths through --doc.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dirname, "eval-samples");

// ---------------------------------------------------------------------------
// Text samples
// ---------------------------------------------------------------------------

const TOPICS = [
  {
    heading: "Units, dimensions and measurement",
    facts: [
      "Every physical quantity has a dimension and a unit; the SI unit of length is the metre, of mass the kilogram, and of time the second.",
      "Dimensional analysis checks an equation by comparing the dimensions on both sides: `[v] = L T^-1` and `[a] = L T^-2`.",
      "A measurement of 25.4 mm is the same as 2.54 cm and 0.0254 m.",
      "The uncertainty of a single reading with this ruler is 0.5 mm, so 25.4 mm is written as 25.4 ± 0.5 mm.",
      "Significant figures follow the instrument: 3 significant figures for this ruler, not 6.",
    ],
    examples: [
      "Convert 72 km/h to m/s: 72 × 1000 / 3600 = 20 m/s.",
      "A rod measures 1.25 m with a 1 mm tape, giving a percentage uncertainty of 0.1 / 125 = 0.08%.",
    ],
  },
  {
    heading: "Displacement, velocity and acceleration",
    facts: [
      "Average velocity is displacement divided by time: `v = Δx / Δt`.",
      "Acceleration is the rate of change of velocity: `a = Δv / Δt`, measured in m/s^2.",
      "Velocity is a vector, so reversing direction changes its sign even when the speed is constant.",
      "On a displacement-time graph the slope is velocity; on a velocity-time graph the slope is acceleration and the area is displacement.",
      "Uniform acceleration means the velocity changes by the same amount every second.",
    ],
    examples: [
      "A bus covers 240 m in 12 s, so its average velocity is 20 m/s.",
      "A car speeds up from 8 m/s to 20 m/s in 4 s, so a = (20 - 8) / 4 = 3 m/s^2.",
    ],
  },
  {
    heading: "Equations of motion",
    facts: [
      "For constant acceleration the four equations of motion are `v = u + at`, `s = ut + 1/2 at^2`, `v^2 = u^2 + 2as` and `s = (u + v)t / 2`.",
      "u is the initial velocity, v the final velocity, a the acceleration, t the time and s the displacement.",
      "Each equation leaves out exactly one quantity, so choose the equation that omits what you are not given.",
      "The equations only hold while the acceleration stays constant.",
      "For free fall near the Earth's surface a = 9.8 m/s^2 downward, often rounded to 10 m/s^2 in estimates.",
    ],
    examples: [
      "A stone dropped from rest falls 45 m: 45 = 1/2 × 10 × t^2, so t = 3 s and v = 30 m/s.",
      "A train at 15 m/s brakes at 2 m/s^2 and stops after 56.25 m, because v^2 = u^2 + 2as gives 0 = 225 - 4s.",
    ],
  },
  {
    heading: "Newton's laws of motion",
    facts: [
      "Newton's first law: a body stays at rest or in uniform motion unless a resultant force acts on it.",
      "Newton's second law: the resultant force equals mass times acceleration, `F = ma`, with F in newtons.",
      "Newton's third law: every action has an equal and opposite reaction, acting on a different body.",
      "One newton accelerates 1 kg at 1 m/s^2.",
      "Weight is a force, `W = mg`, so a 60 kg student weighs 588 N on Earth.",
    ],
    examples: [
      "A 1200 kg car accelerates at 2 m/s^2, so the resultant force is 2400 N.",
      "A 5 kg block on a frictionless table pulled by 15 N accelerates at 3 m/s^2.",
    ],
  },
  {
    heading: "Friction and inclined planes",
    facts: [
      "Static friction rises to a maximum of `f = μN` before the surfaces slide.",
      "Kinetic friction is usually smaller than the maximum static friction.",
      "The normal reaction N is perpendicular to the surface, not always equal to the weight.",
      "On a slope of angle θ the component of weight along the slope is `mg sin θ` and the normal reaction is `mg cos θ`.",
      "The coefficient of friction μ has no unit.",
    ],
    examples: [
      "A 10 kg crate on a floor with μ = 0.4 needs 39.2 N to start moving, since f = 0.4 × 98 N.",
      "On a 30 degree slope with no friction a block accelerates at 4.9 m/s^2, from 9.8 × sin 30.",
    ],
  },
  {
    heading: "Work, energy and power",
    facts: [
      "Work is force times displacement along the force: `W = Fs cos θ`, measured in joules.",
      "Kinetic energy is `KE = 1/2 mv^2` and gravitational potential energy is `PE = mgh`.",
      "The work-energy theorem says the resultant work equals the change in kinetic energy.",
      "Power is the rate of doing work: `P = W / t`, measured in watts.",
      "Energy is conserved in a closed system, though it may change form.",
    ],
    examples: [
      "A 2 kg ball at 6 m/s has KE = 1/2 × 2 × 36 = 36 J.",
      "Lifting 20 kg by 3 m takes 588 J of work, and doing it in 2 s needs 294 W.",
    ],
  },
  {
    heading: "Momentum and collisions",
    facts: [
      "Momentum is `p = mv`, measured in kg m/s and pointing along the velocity.",
      "In a collision with no external force, total momentum before equals total momentum after.",
      "Impulse is `FΔt = Δp`, the change in momentum.",
      "An elastic collision conserves kinetic energy; an inelastic one does not.",
      "A perfectly inelastic collision joins the bodies, so they share one final velocity.",
    ],
    examples: [
      "A 0.15 kg ball at 20 m/s has momentum 3 kg m/s.",
      "A 2 kg trolley at 3 m/s hits a stationary 4 kg trolley and they stick: v = 6 / 6 = 1 m/s.",
    ],
  },
  {
    heading: "Circular motion",
    facts: [
      "Angular velocity is `ω = 2π / T`, measured in rad/s.",
      "Centripetal acceleration is `a = v^2 / r = ω^2 r`, always pointing to the centre.",
      "The centripetal force is `F = mv^2 / r`, supplied by tension, friction or gravity.",
      "Velocity is tangential while acceleration is radial, so the speed can stay constant.",
      "One full revolution is 2π radians, or 360 degrees.",
    ],
    examples: [
      "A 0.5 kg mass on a 2 m string at 4 m/s needs 4 N inward, from 0.5 × 16 / 2.",
      "A wheel with T = 0.5 s has ω = 4π rad/s, about 12.6 rad/s.",
    ],
  },
  {
    heading: "Simple harmonic motion",
    facts: [
      "In simple harmonic motion the acceleration is proportional to the displacement and opposite in direction: `a = -ω^2 x`.",
      "The period of a spring is `T = 2π √(m/k)` and of a simple pendulum `T = 2π √(L/g)`.",
      "Amplitude is the maximum displacement; the period does not depend on amplitude.",
      "At maximum displacement the velocity is zero and the acceleration is greatest.",
      "At the equilibrium position the velocity is greatest and the acceleration is zero.",
    ],
    examples: [
      "A pendulum of length 1 m has T = 2π √(1 / 9.8) = 2.0 s.",
      "A 0.2 kg mass on a spring with k = 20 N/m oscillates with T = 0.63 s.",
    ],
  },
  {
    heading: "Waves and sound",
    facts: [
      "The wave equation is `v = fλ`, so a 440 Hz note with λ = 0.78 m travels at 343 m/s.",
      "Frequency is the number of oscillations per second, measured in hertz.",
      "Sound needs a medium, and its speed is about 343 m/s in air at 20 degrees Celsius.",
      "Diffraction is most noticeable when the gap is about the same size as the wavelength.",
      "Resonance occurs when a driving frequency matches the natural frequency.",
    ],
    examples: [
      "A wave of period 0.02 s has f = 50 Hz, and at 10 m/s its wavelength is 0.2 m.",
      "A pipe closed at one end resonates at odd multiples: 100 Hz, 300 Hz, 500 Hz.",
    ],
  },
  {
    heading: "Electricity: current, voltage and resistance",
    facts: [
      "Current is the rate of flow of charge: `I = Q / t`, measured in amperes.",
      "Ohm's law states `V = IR` for a conductor at constant temperature.",
      "Resistors in series add directly; in parallel the reciprocals add: `1/R = 1/R1 + 1/R2`.",
      "Electrical power is `P = VI = I^2 R = V^2 / R`, measured in watts.",
      "One coulomb is the charge carried by 1 A in 1 s.",
    ],
    examples: [
      "A 12 V supply across 4 Ω drives 3 A, using 36 W.",
      "Two 6 Ω resistors in parallel give 3 Ω.",
    ],
  },
  {
    heading: "Heat and thermodynamic energy",
    facts: [
      "Heat capacity is `Q = mcΔT`, with c in J/(kg K).",
      "The specific heat capacity of water is 4180 J/(kg K).",
      "Latent heat changes state without changing temperature: `Q = mL`.",
      "The specific latent heat of fusion of ice is about 334 000 J/kg.",
      "Temperature measures average kinetic energy, while internal energy is the total.",
    ],
    examples: [
      "Heating 2 kg of water by 10 K needs 83 600 J.",
      "Melting 0.5 kg of ice needs 167 000 J.",
    ],
  },
  {
    heading: "Pressure, density and fluids",
    facts: [
      "Pressure is force per unit area: `p = F / A`, measured in pascals.",
      "Pressure in a liquid increases with depth: `p = ρgh`.",
      "Density is mass per unit volume: `ρ = m / V`.",
      "Archimedes' principle: the upthrust equals the weight of fluid displaced.",
      "A body floats when its average density is less than the fluid's density.",
    ],
    examples: [
      "At 5 m depth in water the gauge pressure is 1000 × 9.8 × 5 = 49 000 Pa.",
      "A 2 kg block of volume 0.001 m^3 has density 2000 kg/m^3 and sinks in water.",
    ],
  },
  {
    heading: "Gases and the kinetic model",
    facts: [
      "The ideal gas equation is `PV = nRT`, with R = 8.314 J/(mol K).",
      "For a fixed mass at constant temperature, `P1V1 = P2V2` (Boyle's law).",
      "At constant pressure, `V1/T1 = V2/T2` (Charles's law).",
      "Temperature in the gas laws must be in kelvin, where 0 degrees Celsius is 273 K.",
      "The kinetic model says pressure comes from molecules colliding with the walls.",
    ],
    examples: [
      "2 mol of gas at 300 K in 0.05 m^3 exerts 99 768 Pa.",
      "Doubling the pressure of 3 L of gas at constant temperature gives 1.5 L.",
    ],
  },
];

function lectureText() {
  const lines = [
    "# PHYS 201 — Mechanics and Thermal Physics (lecture transcript)",
    "",
    "## Introduction",
    "",
    "Today we cover the material that appears in the end-of-semester paper, so write every formula down and check the units as we go. If a number is given in the question, use it exactly as written; do not round until the final line.",
    "",
  ];
  for (const [index, topic] of TOPICS.entries()) {
    lines.push(`## ${index + 1}. ${topic.heading}`, "");
    for (const fact of topic.facts) lines.push(fact);
    lines.push("", "Worked examples:");
    for (const example of topic.examples) lines.push(`- ${example}`);
    lines.push(
      "",
      `Remember: this topic contributed ${index + 2} questions in last year's paper, and the examiner marked the unit errors strictly.`,
      "",
    );
  }
  lines.push(
    "## Revision plan",
    "",
    "Work through chapters 1 to 9 of the handbook, then attempt the past paper under timed conditions. Bring your formula sheet to the tutorial on Thursday at 14:00 in Room 204.",
    "",
    "That is all for today. Read pages 112 to 148 before the next lecture.",
  );
  return lines.join("\n");
}

const TYPED_MESSY = `# typed in a hurry during the tutorial
newtons 2nd law F=ma , force in newtons. friction mu N, mu has no units
car example 1200kg and 2 m/s^2 so F = 2400 N.
work = F s cos theta. power P = W/t.
PV = nRT with R = 8.314. remember kelvin! 27 degrees C = 300 K.
pendulum T = 2 pi sqrt(L/g) -> L=1m gives T about 2.0 s
momentum p=mv, impulse F delta t = delta p.
TODO: ask about the 56.25 m braking example, i got 50 m
exam: 2019 paper question 4 was on upthrust. rho = m/V.`;

// ---------------------------------------------------------------------------
// PDF builder (text pages, no dependencies)
// ---------------------------------------------------------------------------

function escapePdf(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(pages) {
  // Object numbers: 1 catalog, 2 pages, 3 font; then page/content pairs.
  const fontNumber = 3;
  let next = 4;
  const entries = pages.map((lines) => {
    const pageNumber = next++;
    const contentNumber = next++;
    return { lines, pageNumber, contentNumber };
  });
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(
    2,
    `<< /Type /Pages /Kids [${entries.map((entry) => `${entry.pageNumber} 0 R`).join(" ")}] /Count ${entries.length} >>`,
  );
  objects.set(
    fontNumber,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  for (const entry of entries) {
    const stream = entry.lines
      .map(
        (line, index) =>
          `BT /F1 11 Tf 50 ${790 - index * 16} Td (${escapePdf(line)}) Tj ET`,
      )
      .join("\n");
    objects.set(
      entry.pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontNumber} 0 R >> >> /Contents ${entry.contentNumber} 0 R >>`,
    );
    objects.set(
      entry.contentNumber,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }

  const chunks = [];
  const offsets = new Map();
  let position = 0;
  const append = (value) => {
    const buffer = Buffer.from(value, "latin1");
    chunks.push(buffer);
    position += buffer.length;
  };

  append("%PDF-1.4\n");
  for (const number of [...objects.keys()].sort((a, b) => a - b)) {
    offsets.set(number, position);
    append(`${number} 0 obj\n${objects.get(number)}\nendobj\n`);
  }
  const xrefOffset = position;
  const size = Math.max(...objects.keys()) + 1;
  append(`xref\n0 ${size}\n`);
  append("0000000000 65535 f \n");
  for (let number = 1; number < size; number += 1) {
    const offset = offsets.get(number);
    if (offset === undefined) {
      append("0000000000 65535 f \n");
    } else {
      append(`${String(offset).padStart(10, "0")} 00000 n \n`);
    }
  }
  append(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** Paginate lecture lines into real-looking pages with running headers. */
function lecturePages(pageCount) {
  const lines = lectureText().split("\n").filter(Boolean);
  const body = lines.filter((line) => !line.startsWith("# "));
  const pages = [];
  const perPage = Math.max(6, Math.ceil(body.length / pageCount));
  for (let page = 0; page < pageCount; page += 1) {
    const slice = body.slice(page * perPage, (page + 1) * perPage);
    pages.push([
      "PHYS 201 — Mechanics and Thermal Physics",
      `Page ${page + 1} of ${pageCount}`,
      "",
      ...slice,
    ]);
  }
  return pages;
}

/** Pages with almost no text layer: the pipeline must OCR them. */
function scannedPages(count) {
  const pages = [];
  for (let page = 1; page <= count; page += 1) {
    // Deliberately under OCR_MIN_CHARS (40) once the page label is removed.
    pages.push([`Sheet ${page}`, "", "F = ma.", "p = rho g h."]);
  }
  return pages;
}

// ---------------------------------------------------------------------------
// PPTX + PNG fixtures
// ---------------------------------------------------------------------------

function slideXml(title, bullets) {
  const paragraph = (value) =>
    `<a:p><a:r><a:rPr lang="en-US"/><a:t>${value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</a:t></a:r></a:p>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>
    ${paragraph(title)}
    ${bullets.map(paragraph).join("\n    ")}
  </p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
}

async function buildPptx(slides) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  slides.forEach((slide, index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(slide.title, slide.bullets));
  });
  return zip.generateAsync({ type: "nodebuffer" });
}

async function buildPng() {
  const { createCanvas } = await import("@napi-rs/canvas");
  const canvas = createCanvas(1000, 650);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111111";
  context.font = "bold 34px Arial";
  context.fillText("PHYS 201 — Circular motion", 50, 70);
  context.font = "26px Arial";
  const lines = [
    "Centripetal acceleration: a = v^2 / r",
    "Centripetal force: F = m v^2 / r",
    "A 0.5 kg mass on a 2 m string at 4 m/s needs 4 N inward.",
    "One revolution = 2 pi radians = 360 degrees.",
    "Angular velocity: omega = 2 pi / T",
  ];
  lines.forEach((line, index) => context.fillText(line, 50, 140 + index * 46));
  return canvas.toBuffer("image/png");
}

// ---------------------------------------------------------------------------

async function main() {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "lecture-long.txt"), `${lectureText()}\n`);
  await writeFile(path.join(out, "typed-messy.md"), `${TYPED_MESSY}\n`);

  await writeFile(path.join(out, "handout-30p.pdf"), buildPdf(lecturePages(30)));
  await writeFile(path.join(out, "handout-60p.pdf"), buildPdf(lecturePages(60)));
  await writeFile(path.join(out, "scanned-5p.pdf"), buildPdf(scannedPages(5)));

  const slides = TOPICS.slice(0, 10).map((topic, index) => ({
    title: `${index + 1}. ${topic.heading}`,
    bullets: [...topic.facts.slice(0, 3), ...topic.examples.slice(0, 1)],
  }));
  await writeFile(path.join(out, "slides-10.pptx"), await buildPptx(slides));

  await writeFile(path.join(out, "notes-photo.png"), await buildPng());

  console.log(`Fixtures written to ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
