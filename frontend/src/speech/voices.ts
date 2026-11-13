import type { Language } from "../config/languages";

/** The parts of SpeechSynthesisVoice that are used (easy to fake in tests). */
export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}

export interface RankedVoice<V extends VoiceLike = VoiceLike> {
  voice: V;
  male: boolean;
  natural: boolean;
  /** same country as the language's locale (de-DE, not de-AT) */
  exactLocale: boolean;
  score: number;
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Edge's online voices: "Microsoft Conrad Online (Natural) - German (Germany)". */
export function isNatural(voice: VoiceLike): boolean {
  return /natural|online|neural/i.test(voice.name) && !voice.localService;
}

function maleRank(voice: VoiceLike, language: Language): number {
  const name = fold(voice.name);
  const index = language.maleVoices.findIndex((n) => name.includes(fold(n)));
  return index; // -1 = not a known male voice
}

function sameLanguage(voice: VoiceLike, language: Language): boolean {
  return fold(voice.lang).replace("_", "-").split("-")[0] === language.code;
}

/** All voices of the language, best first: natural male voices, then other male voices, then the rest. */
export function rankVoices<V extends VoiceLike>(voices: V[], language: Language): RankedVoice<V>[] {
  return voices
    .filter((v) => sameLanguage(v, language))
    .map((voice) => {
      const rank = maleRank(voice, language);
      const male = rank >= 0;
      const natural = isNatural(voice);
      const exactLocale = fold(voice.lang).replace("_", "-") === fold(language.locale);
      let score = 0;
      if (male) score += 100 - rank;
      if (natural) score += 60;
      if (exactLocale) score += 20;
      return { voice, male, natural, exactLocale, score };
    })
    .sort((a, b) => b.score - a.score || a.voice.name.localeCompare(b.voice.name));
}

/**
 * The voice to use: the user's choice if it still exists, otherwise the best male voice.
 * Returns null when the browser has no voice for the language.
 */
export function pickVoice<V extends VoiceLike>(voices: V[], language: Language, preferredName?: string | null): RankedVoice<V> | null {
  const ranked = rankVoices(voices, language);
  if (preferredName) {
    const chosen = ranked.find((r) => r.voice.name === preferredName);
    if (chosen) return chosen;
  }
  return ranked[0] ?? null;
}

/** A short warning when the voice is not what the app wants (male and natural), or null. */
export function voiceWarning(picked: RankedVoice | null, language: Language, isEdge: boolean): string | null {
  const browser = isEdge ? "" : " Microsoft Edge has natural male voices for all five languages.";
  if (!picked) return `This browser has no ${language.name} voice, so Leon cannot speak ${language.name} here.${browser}`;
  if (!picked.male) return `No male ${language.name} voice found, a different voice is used.${browser}`;
  if (!picked.natural) return `Only a robotic ${language.name} voice was found.${browser}`;
  return null;
}
