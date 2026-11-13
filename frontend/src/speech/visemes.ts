import type { LanguageCode } from "../config/languages";

/**
 * Mouth shapes (visemes) from written text. The avatar has the 15 standard viseme blendshapes
 * (the Oculus/Meta set), so the text is turned into a rough sequence of those shapes per word.
 * Not a real phoneme analysis: simple letter rules per language, good enough for lip-sync.
 */
export const VISEMES = ["sil", "PP", "FF", "TH", "DD", "kk", "CH", "SS", "nn", "RR", "aa", "E", "I", "O", "U"] as const;
export type Viseme = (typeof VISEMES)[number];

const VOWELS = new Set<Viseme>(["aa", "E", "I", "O", "U"]);
export const isVowel = (v: Viseme): boolean => VOWELS.has(v);

type Rules = [string, Viseme[]][];

// longer letter groups first
const GERMAN: Rules = [
  ["tsch", ["CH"]], ["sch", ["CH"]], ["ch", ["kk"]], ["ck", ["kk"]], ["ph", ["FF"]], ["th", ["DD"]], ["qu", ["kk", "FF"]],
  ["ei", ["aa", "I"]], ["ai", ["aa", "I"]], ["au", ["aa", "U"]], ["eu", ["O", "I"]], ["äu", ["O", "I"]], ["ie", ["I"]],
  ["ng", ["nn"]], ["ß", ["SS"]], ["z", ["DD", "SS"]], ["v", ["FF"]], ["w", ["FF"]], ["j", ["I"]], ["y", ["U"]],
  ["ä", ["E"]], ["ö", ["O"]], ["ü", ["U"]], ["c", ["kk"]], ["h", []],
];
const ENGLISH: Rules = [
  ["tch", ["CH"]], ["th", ["TH"]], ["sh", ["CH"]], ["ch", ["CH"]], ["ph", ["FF"]], ["ck", ["kk"]], ["ng", ["nn"]],
  ["qu", ["kk", "U"]], ["oo", ["U"]], ["ee", ["I"]], ["ea", ["I"]], ["ou", ["aa", "U"]], ["ow", ["O", "U"]], ["ay", ["E", "I"]],
  ["ce", ["SS", "E"]], ["ci", ["SS", "I"]], ["cy", ["SS", "I"]], ["c", ["kk"]], ["w", ["U"]], ["y", ["I"]], ["j", ["CH"]],
  ["x", ["kk", "SS"]], ["h", []],
];
const TURKIC: Rules = [
  ["ç", ["CH"]], ["ş", ["CH"]], ["c", ["CH"]], ["j", ["CH"]], ["ğ", []], ["ı", ["I"]], ["ö", ["O"]], ["ü", ["U"]],
  ["ə", ["aa"]], ["x", ["kk"]], ["q", ["kk"]], ["y", ["I"]], ["w", ["FF"]], ["h", []],
];
const RUSSIAN: Record<string, Viseme[]> = {
  а: ["aa"], б: ["PP"], в: ["FF"], г: ["kk"], д: ["DD"], е: ["E"], ё: ["O"], ж: ["CH"], з: ["SS"], и: ["I"], й: ["I"],
  к: ["kk"], л: ["nn"], м: ["PP"], н: ["nn"], о: ["O"], п: ["PP"], р: ["RR"], с: ["SS"], т: ["DD"], у: ["U"], ф: ["FF"],
  х: ["kk"], ц: ["SS"], ч: ["CH"], ш: ["CH"], щ: ["CH"], ъ: [], ы: ["I"], ь: [], э: ["E"], ю: ["U"], я: ["aa"],
};
// shared Latin letters (after the language rules)
const LATIN: Record<string, Viseme[]> = {
  a: ["aa"], á: ["aa"], à: ["aa"], â: ["aa"], e: ["E"], é: ["E"], è: ["E"], ê: ["E"], i: ["I"], í: ["I"], î: ["I"],
  o: ["O"], ó: ["O"], ô: ["O"], u: ["U"], ú: ["U"], û: ["U"], b: ["PP"], p: ["PP"], m: ["PP"], f: ["FF"], v: ["FF"],
  w: ["FF"], d: ["DD"], t: ["DD"], l: ["nn"], n: ["nn"], k: ["kk"], g: ["kk"], q: ["kk"], c: ["kk"], x: ["kk", "SS"],
  r: ["RR"], s: ["SS"], z: ["SS"], j: ["I"], y: ["I"], h: [],
  ä: ["E"], ö: ["O"], ü: ["U"], ç: ["CH"], ş: ["CH"], ğ: [], ı: ["I"], ə: ["aa"], ß: ["SS"],
};

function rulesFor(lang: LanguageCode): Rules {
  if (lang === "de") return GERMAN;
  if (lang === "en") return ENGLISH;
  if (lang === "tr" || lang === "az") return TURKIC;
  return [];
}

/** The mouth shapes of one word (lower or upper case). */
export function wordVisemes(word: string, lang: LanguageCode): Viseme[] {
  const w = word.toLocaleLowerCase(lang === "tr" || lang === "az" ? "tr" : lang);
  const rules = rulesFor(lang);
  const out: Viseme[] = [];
  let i = 0;
  while (i < w.length) {
    const ch = w[i];
    if (/\d/.test(ch)) {
      out.push("DD", "aa", "nn"); // a spoken number: some generic movement
      i++;
      continue;
    }
    const rule = rules.find(([letters]) => w.startsWith(letters, i));
    if (rule) {
      out.push(...rule[1]);
      i += rule[0].length;
      continue;
    }
    out.push(...(RUSSIAN[ch] ?? LATIN[ch] ?? []));
    i++;
  }
  // double letters ("ll", "mm") are one mouth movement
  const merged = out.filter((v, k) => k === 0 || v !== out[k - 1]);
  return merged.length ? merged : ["aa"];
}

export interface WordTiming {
  /** character range in the sentence (as in speechSynthesis boundary events) */
  start: number;
  end: number;
  visemes: Viseme[];
  /** estimated start and end in seconds from the start of the sentence */
  t0: number;
  t1: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Estimated timing for a sentence spoken at `charsPerSecond`. */
export function buildTimeline(text: string, lang: LanguageCode, charsPerSecond: number): WordTiming[] {
  const words: WordTiming[] = [];
  let t = 0.05;
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    const start = m.index ?? 0;
    const between = text.slice(last, start);
    if (words.length) {
      t += between.length / charsPerSecond;
      if (/[.!?…]/.test(between)) t += 0.35;
      else if (/[,;:–—()]/.test(between)) t += 0.18;
    }
    const duration = Math.max(0.12, m[0].length / charsPerSecond);
    words.push({ start, end: start + m[0].length, visemes: wordVisemes(m[0], lang), t0: t, t1: t + duration });
    t += duration;
    last = start + m[0].length;
  }
  return words;
}

/** The viseme at `progress` (0..1) through a word; vowels take a bit longer than consonants. */
export function visemeInWord(visemes: Viseme[], progress: number): Viseme {
  const weights = visemes.map((v) => (isVowel(v) ? 1.4 : 0.8));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  const target = Math.min(0.9999, Math.max(0, progress)) * total;
  for (let i = 0; i < visemes.length; i++) {
    acc += weights[i];
    if (target < acc) return visemes[i];
  }
  return visemes[visemes.length - 1];
}
