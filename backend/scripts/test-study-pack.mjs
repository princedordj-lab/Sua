import { validateStudyPack } from "../src/config/study-pack-schema.js";
import { extractDocument } from "../src/lib/extract.js";

console.log("=== Testing study pack schema validation ===");

const validPack = {
  shortSummary: "Photosynthesis is the fundamental biological process by which autotrophic organisms convert light energy into chemical energy. It occurs primarily in the chloroplasts of plant cells through light-dependent reactions and the Calvin cycle. Water and carbon dioxide are consumed to synthesize glucose while releasing oxygen as a byproduct. Understanding this pathway is essential for grasping cellular energetics and ecological food webs.",
  keyTerms: [
    { term: "Chloroplast", definition: "The organelle in plant cells where photosynthesis occurs." },
    { term: "Chlorophyll", definition: "Green pigment that absorbs light energy." },
    { term: "Thylakoid", definition: "Membrane-bound compartments where light reactions take place." },
    { term: "Stroma", definition: "Fluid-filled space surrounding thylakoids where the Calvin cycle occurs." },
    { term: "ATP Synthase", definition: "Enzyme that synthesizes ATP using proton gradients." },
  ],
  formulas: ["6CO2 + 6H2O + light -> C6H12O6 + 6O2"],
  examQuestions: [
    "Differentiate between light-dependent and light-independent reactions.",
    "Explain the role of photosystem II in water photolysis.",
    "How does temperature affect the rate of photosynthesis?",
  ],
  flashcards: [
    { front: "Where do light-dependent reactions take place?", back: "In the thylakoid membranes." },
    { front: "What is the primary function of chlorophyll a?", back: "Absorbs blue and red light for photochemical reactions." },
    { front: "What are the two major products of light reactions?", back: "ATP and NADPH." },
    { front: "What enzyme fixes carbon dioxide in the Calvin cycle?", back: "RuBisCO." },
    { front: "What is the waste product of the light reactions?", back: "Oxygen (O2)." },
  ],
  quiz: [
    {
      type: "mcq",
      prompt: "Where does the Calvin cycle take place in a plant cell?",
      options: ["Thylakoid lumen", "Stroma", "Mitochondrial matrix", "Outer membrane"],
      answer: "Stroma",
      explanation: "The Calvin cycle reactions take place in the stroma of the chloroplast.",
    },
    {
      type: "mcq",
      prompt: "Which molecule provides electrons to replace those lost in Photosystem II?",
      options: ["Carbon dioxide", "Water", "Glucose", "NADPH"],
      answer: "Water",
      explanation: "Photolysis of water splits H2O into oxygen, protons, and replacement electrons.",
    },
    {
      type: "true_false",
      prompt: "Oxygen is produced during the dark reactions of photosynthesis.",
      options: ["True", "False"],
      answer: "False",
      explanation: "Oxygen is released during the light-dependent reactions when water is split.",
    },
  ],
};

const result = validateStudyPack(validPack);
if (!result.success) {
  console.error("FAIL: validPack failed validation:", result.error);
  process.exit(1);
}
console.log("PASS: validPack passed validation successfully.");

// Test invalid pack (too short summary)
const invalidPack = { ...validPack, shortSummary: "Too short" };
const invalidResult = validateStudyPack(invalidPack);
if (invalidResult.success) {
  console.error("FAIL: invalidPack should have failed");
  process.exit(1);
}
console.log("PASS: invalidPack correctly rejected:", invalidResult.error);

// Test markdown extraction
const mdBuffer = Buffer.from("# Lecture 1\n\n- Point 1\n- Point 2\n\nContent here.", "utf8");
extractDocument(mdBuffer, "md", "document").then((extractResult) => {
  if (!extractResult || !extractResult.text.includes("Lecture 1")) {
    console.error("FAIL: markdown extraction failed:", extractResult);
    process.exit(1);
  }
  console.log("PASS: markdown extraction succeeded with text length:", extractResult.text.length);
  console.log("ALL TESTS PASSED!");
});
