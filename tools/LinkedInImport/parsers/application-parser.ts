// Application Parser — parses Job Applications CSVs and Screening Q&A files
import { readCsv } from "../utils/csv-reader.ts";
import { parseDate, toISO } from "../utils/date-parser.ts";
import type { JobApplicationRow, SavedAnswerRow, QuestionAnswer, Result } from "../types.ts";

export interface ParsedApplication {
  applicationDate: string; // ISO8601
  companyName: string;
  jobTitle: string;
  jobUrl: string;
  location: string; // often empty in LinkedIn data
  questionAnswers: Array<{ question: string; answer: string }>;
}

export interface ParsedApplicationData {
  applications: ParsedApplication[];
  questionAnswers: QuestionAnswer[];
}

// Parse pipe-delimited Q&A string: "Question:Answer | Question2:Answer2"
function parseQaString(qaStr: string): Array<{ question: string; answer: string }> {
  if (!qaStr || qaStr.trim() === "") return [];
  const pairs: Array<{ question: string; answer: string }> = [];
  const parts = qaStr.split(" | ");
  for (const part of parts) {
    const colonIdx = part.indexOf(":");
    if (colonIdx === -1) continue;
    const question = part.substring(0, colonIdx).trim();
    const answer = part.substring(colonIdx + 1).trim();
    if (question) {
      pairs.push({ question, answer });
    }
  }
  return pairs;
}

export function parseApplications(
  appPath1: string,
  appPath2: string,
  savedAnswersPath: string,
  screeningPath1: string,
  screeningPath2: string
): Result<ParsedApplicationData> {
  // Parse both application files
  const result1 = readCsv<JobApplicationRow>(appPath1);
  if (!result1.success) return result1;

  const result2 = readCsv<JobApplicationRow>(appPath2);
  if (!result2.success) return result2;

  const allAppRows = [...result1.data, ...result2.data];
  const applications: ParsedApplication[] = [];
  const qaMap = new Map<string, string>(); // question -> answer deduplication

  for (const row of allAppRows) {
    const dateStr = row["Application Date"] ?? "";
    const parsedDate = parseDate(dateStr);
    const dateFormatted = parsedDate ? toISO(parsedDate) : new Date().toISOString();

    const companyName = row["Company Name"]?.trim() ?? "";
    const jobTitle = row["Job Title"]?.trim() ?? "";
    const jobUrl = row["Job Url"]?.trim() ?? "";

    if (!companyName && !jobTitle) continue; // Skip empty rows

    // Extract Q&A from the Question And Answers column
    const qaStr = row["Question And Answers"] ?? "";
    const appQa = parseQaString(qaStr);

    // Collect unique Q&A into the global map
    for (const { question, answer } of appQa) {
      if (question && !qaMap.has(question)) {
        qaMap.set(question, answer);
      }
    }

    applications.push({
      applicationDate: dateFormatted,
      companyName,
      jobTitle,
      jobUrl,
      location: "", // LinkedIn applications rarely include location
      questionAnswers: appQa,
    });
  }

  // Parse saved answers (flat Q&A pairs)
  const savedResult = readCsv<SavedAnswerRow>(savedAnswersPath);
  if (savedResult.success) {
    for (const row of savedResult.data) {
      const q = row["Question"]?.trim() ?? "";
      const a = row["Answer"]?.trim() ?? "";
      if (q && !qaMap.has(q)) {
        qaMap.set(q, a);
      }
    }
  }

  // Parse screening question responses (same Q/A column format)
  const screening1 = readCsv<SavedAnswerRow>(screeningPath1);
  if (screening1.success) {
    for (const row of screening1.data) {
      const q = row["Question"]?.trim() ?? "";
      const a = row["Answer"]?.trim() ?? "";
      if (q && !qaMap.has(q)) {
        qaMap.set(q, a);
      }
    }
  }

  const screening2 = readCsv<SavedAnswerRow>(screeningPath2);
  if (screening2.success) {
    for (const row of screening2.data) {
      const q = row["Question"]?.trim() ?? "";
      const a = row["Answer"]?.trim() ?? "";
      if (q && !qaMap.has(q)) {
        qaMap.set(q, a);
      }
    }
  }

  // Filter out non-useful Q&A (resume uploads, raw IDs)
  const SKIP_PREFIXES = [
    "please submit a resume",
    "cover letter",
    "linkedin member profile",
    "mobile phone",
    "primary phone",
    "email address",
    "photo",
    "phone number",
  ];
  const SKIP_PATTERNS = [/^-?\d{7,}\.pdf$/i, /^urn:li:/i, /^\+?1?\d{10,}$/, /@.*\.\w{2,}$/];

  const questionAnswers: QuestionAnswer[] = [];
  for (const [question, answer] of qaMap) {
    const qLower = question.toLowerCase();
    if (SKIP_PREFIXES.some((p) => qLower.startsWith(p))) continue;
    if (SKIP_PATTERNS.some((p) => p.test(answer))) continue;

    questionAnswers.push({
      question,
      answer,
      source: "linkedin_saved",
    });
  }

  return {
    success: true,
    data: { applications, questionAnswers },
  };
}
