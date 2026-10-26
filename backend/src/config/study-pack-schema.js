/**
 * Strict schema and validator for AI-generated study packs.
 * Matches the production-ready university study pack specification for Sua.
 */

export function validateStudyPack(input) {
  if (!input || typeof input !== "object") {
    return { success: false, error: "Output must be a valid JSON object" };
  }

  const {
    shortSummary,
    summary,
    keyTerms,
    formulas,
    formulasExamples,
    examQuestions,
    flashcards,
    quiz,
  } = input;

  // 1. Overview / Short Summary (4-6 sentences)
  const rawSummary = typeof shortSummary === "string" ? shortSummary : (summary?.overview || summary);
  if (typeof rawSummary !== "string" || rawSummary.trim().length < 40) {
    return { success: false, error: "shortSummary must be a 4-6 sentence clear overview (minimum 40 characters)" };
  }

  // 2. Key Terms (5-10 items with term and definition)
  const terms = Array.isArray(keyTerms) ? keyTerms : (Array.isArray(summary?.keyTerms) ? summary.keyTerms : []);
  if (terms.length < 5) {
    return { success: false, error: `keyTerms must have at least 5 terms with definitions (found ${terms.length})` };
  }
  const cleanKeyTerms = [];
  for (let i = 0; i < terms.length; i++) {
    const item = terms[i];
    if (!item || typeof item.term !== "string" || typeof item.definition !== "string") {
      return { success: false, error: `keyTerms[${i}] must have 'term' and 'definition' strings` };
    }
    cleanKeyTerms.push({
      term: item.term.trim(),
      definition: item.definition.trim(),
    });
  }

  // 3. Formulas (equations or empty array)
  const rawFormulas = Array.isArray(formulas) ? formulas : (Array.isArray(formulasExamples) ? formulasExamples : (Array.isArray(summary?.formulasExamples) ? summary.formulasExamples : []));
  const cleanFormulas = rawFormulas.map((f) => String(f).trim()).filter(Boolean);

  // 4. Likely Exam Questions (3-6 questions)
  const rawQuestions = Array.isArray(examQuestions) ? examQuestions : (Array.isArray(summary?.examQuestions) ? summary.examQuestions : []);
  if (rawQuestions.length < 3) {
    return { success: false, error: `examQuestions must have at least 3 likely exam questions (found ${rawQuestions.length})` };
  }
  const cleanExamQuestions = rawQuestions.map((q) => String(q).trim()).filter(Boolean);

  // 5. Flashcards (8-20 active recall cards)
  if (!Array.isArray(flashcards) || flashcards.length < 5) {
    return { success: false, error: `flashcards must be an array of at least 5 active recall cards (found ${Array.isArray(flashcards) ? flashcards.length : 0})` };
  }
  const cleanFlashcards = [];
  for (let i = 0; i < flashcards.length; i++) {
    const card = flashcards[i];
    if (!card || !card.front || !card.back) {
      return { success: false, error: `flashcards[${i}] must have 'front' and 'back'` };
    }
    cleanFlashcards.push({
      front: String(card.front).trim(),
      back: String(card.back).trim(),
    });
  }

  // 6. Quiz (5-10 questions)
  if (!Array.isArray(quiz) || quiz.length < 3) {
    return { success: false, error: `quiz must be an array of at least 3 questions (found ${Array.isArray(quiz) ? quiz.length : 0})` };
  }
  const cleanQuiz = [];
  for (let i = 0; i < quiz.length; i++) {
    const q = quiz[i];
    const prompt = (q.prompt || q.question || "").trim();
    if (!prompt) {
      return { success: false, error: `quiz[${i}] missing question prompt` };
    }

    let type = q.type || "mcq";
    let options = Array.isArray(q.options) ? q.options.map((opt) => String(opt).trim()) : null;
    let answer = "";

    if (q.answerIndex !== undefined && options && options[q.answerIndex] !== undefined) {
      answer = options[q.answerIndex];
    } else if (typeof q.answer === "string") {
      answer = q.answer.trim();
    } else if (typeof q.answer === "number" && options && options[q.answer]) {
      answer = options[q.answer];
    }

    if (!answer && options && options.length > 0) {
      answer = options[0];
    }

    if (!answer) {
      return { success: false, error: `quiz[${i}] missing valid answer` };
    }

    cleanQuiz.push({
      type,
      prompt,
      options,
      answer,
      explanation: String(q.explanation || "").trim(),
    });
  }

  return {
    success: true,
    data: {
      shortSummary: rawSummary.trim(),
      keyTerms: cleanKeyTerms,
      formulas: cleanFormulas,
      examQuestions: cleanExamQuestions,
      flashcards: cleanFlashcards,
      quiz: cleanQuiz,
    },
  };
}
