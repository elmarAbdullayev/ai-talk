import type { LanguageCode } from "./languages";

export type Mode = "free" | "teacher" | "interview";

export interface ModeInfo {
  id: Mode;
  title: string;
  short: string;
  description: string;
  /** the interview is always in German */
  fixedLanguage?: LanguageCode;
}

export const MODES: ModeInfo[] = [
  {
    id: "free",
    title: "Free talk",
    short: "Talk",
    description: "Talk about anything. Leon answers in your language.",
  },
  {
    id: "teacher",
    title: "Teacher",
    short: "Teacher",
    description: "Leon corrects your mistakes on screen (you said / better / why), then keeps talking.",
  },
  {
    id: "interview",
    title: "Job interview",
    short: "Interview",
    description: "German job interview for an IT Service Desk job. Leon asks 8 questions, then gives feedback.",
    fixedLanguage: "de",
  },
];

export function modeInfo(mode: Mode): ModeInfo {
  return MODES.find((m) => m.id === mode) ?? MODES[0];
}

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && MODES.some((m) => m.id === value);
}

/** Number of interviewer questions before the feedback (matches the backend's INTERVIEW_TOPICS). */
export const INTERVIEW_QUESTIONS = 8;
