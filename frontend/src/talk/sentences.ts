/**
 * Splits the AI's streamed answer into sentences, so the first sentence can be spoken while the
 * rest is still being written.
 */

const TERMINATORS = ".!?…";
const CLOSERS = "\"'”“»«)]’";

/** Words that end with a dot but do not end a sentence (lower case, without the dot). */
const ABBREVIATIONS = new Set([
  // German
  "bzw", "usw", "ca", "dr", "nr", "str", "inkl", "evtl", "ggf", "sog", "vgl", "tel", "zb", "dh", "uvm", "etc", "bspw", "prof", "hr", "fr",
  // English
  "mr", "mrs", "ms", "vs", "st", "jr", "sr", "eg", "ie", "approx", "dept",
  // Turkish / Azerbaijani
  "vb", "örn", "vs", "sn", "doç",
  // Russian
  "др", "см", "стр", "руб", "тыс", "млн", "млрд", "ул", "им",
]);

export interface SplitterOptions {
  /** the first sentence is cut at a comma when it gets longer than this, so speaking starts early */
  firstMaxChars: number;
  /** later sentences are cut at a comma when they get longer than this */
  maxChars: number;
}

const DEFAULTS: SplitterOptions = { firstMaxChars: 120, maxChars: 240 };

export class SentenceSplitter {
  private buffer = "";
  private count = 0;
  private readonly options: SplitterOptions;

  constructor(options: Partial<SplitterOptions> = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Adds streamed text; returns the sentences that are complete now. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const end = findSentenceEnd(this.buffer);
      if (end >= 0) {
        this.emit(this.buffer.slice(0, end), out);
        this.buffer = this.buffer.slice(end);
        continue;
      }
      const limit = this.count === 0 ? this.options.firstMaxChars : this.options.maxChars;
      if (this.buffer.trim().length > limit) {
        const cut = findSoftBreak(this.buffer, limit);
        if (cut > 0) {
          this.emit(this.buffer.slice(0, cut), out);
          this.buffer = this.buffer.slice(cut);
          continue;
        }
      }
      return out;
    }
  }

  /** The end of the stream: returns what is left. */
  flush(): string[] {
    const out: string[] = [];
    this.emit(this.buffer, out);
    this.buffer = "";
    return out;
  }

  private emit(text: string, out: string[]): void {
    const sentence = text
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-–—•,;:]+\s*/, "");
    // skip pieces without letters or digits (a lone dash, "...")
    if (!/[\p{L}\p{N}]/u.test(sentence)) return;
    out.push(sentence);
    this.count++;
  }
}

/** Index just after the first sentence end in `text`, or -1 if no complete sentence yet. */
export function findSentenceEnd(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") {
      if (text.slice(0, i).trim()) return i + 1;
      continue;
    }
    if (!TERMINATORS.includes(ch)) continue;
    // take the whole group of terminators and closing quotes: "?!", "...", '."'
    let j = i + 1;
    while (j < text.length && (TERMINATORS.includes(text[j]) || CLOSERS.includes(text[j]))) j++;
    if (j >= text.length) return -1; // need to see what follows
    if (!/\s/.test(text[j])) {
      i = j - 1; // "3.5", "z.B.", "file.txt": not an end
      continue;
    }
    if (ch === "." && j === i + 1) {
      const real = isRealDot(text, i);
      if (real === undefined) return -1; // need the next word to decide
      if (!real) continue;
    }
    return j;
  }
  return -1;
}

/**
 * False for dots after abbreviations, single letters ("z. B.", "т. е.") and ordinal numbers ("3. Oktober");
 * undefined when the next word is needed to decide.
 */
function isRealDot(text: string, dot: number): boolean | undefined {
  let start = dot;
  while (start > 0 && /[\p{L}\p{N}]/u.test(text[start - 1])) start--;
  const word = text.slice(start, dot);
  if (!word) return true;
  if (/^\p{L}$/u.test(word)) return false;
  if (ABBREVIATIONS.has(word.toLowerCase())) return false;
  if (/^\d{1,2}$/.test(word)) {
    // ordinal numbers: "am 3. Oktober", "zum 2. Mal", "3. sınıf"
    const rest = text.slice(dot + 1).trimStart();
    if (!rest) return undefined;
    const next = /^\p{L}+/u.exec(rest)?.[0] ?? "";
    const prev = /(\p{L}+)\s*$/u.exec(text.slice(0, start))?.[1]?.toLowerCase() ?? "";
    if (next && next[0] === next[0].toLowerCase() && next[0] !== next[0].toUpperCase()) return false;
    if (MONTHS.test(next) || ORDINAL_BEFORE.has(prev)) return false;
  }
  return true;
}

const MONTHS =
  /^(jan|feb|mär|mar|apr|mai|may|jun|jul|aug|sep|okt|oct|nov|dez|dec|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|yanvar|fevral|aprel|iyun|iyul|avqust|sentyabr|oktyabr|noyabr|dekabr)/i;
const ORDINAL_BEFORE = new Set([
  "am", "im", "zum", "zur", "vom", "bis", "ab", "seit", "dem", "den", "der", "die", "das", "des", "ein", "eine",
  "einem", "einen", "jeden", "jedes", "jeder", "the",
]);

/** A comma, semicolon, colon or dash before `limit` where a long sentence can be cut. */
function findSoftBreak(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const re = /[,;:–—](\s)/g;
  let best = -1;
  for (let m = re.exec(window); m; m = re.exec(window)) {
    if (m.index >= 25) best = m.index + 1;
  }
  return best;
}

/**
 * Text as it should be spoken: no markdown symbols, emojis, stage directions in asterisks or
 * the teacher's labels.
 */
export function cleanForSpeech(text: string): string {
  return (
    text
      .replace(STAGE_DIRECTION, (match: string, inner: string, offset: number, all: string) =>
        isStageDirection(all, offset, match.length, inner) ? "" : inner,
      )
      .replace(/\*\*|__|`+/g, "")
      .replace(/^\s{0,3}(#{1,6}|[-*•]|\d+[.)])\s+/gm, "")
      .replace(/\b(YOU SAID|BETTER|WHY|REPLY)\s*:\s*/gi, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// *smiles* / *lächelt* (single asterisks, not **bold**)
const STAGE_DIRECTION = /(?<!\*)\*(?!\*)([^*\n]{1,40})(?<!\*)\*(?!\*)/g;

/** A short phrase in asterisks on its own (at the start, after a sentence, or at the end) is an action, not speech. */
function isStageDirection(text: string, start: number, length: number, inner: string): boolean {
  if (inner.trim().split(/\s+/).length > 4) return false;
  const before = text.slice(0, start).trimEnd();
  const after = text.slice(start + length).trimStart();
  const alone = (s: string) => s === "" || /[.!?…:\p{Extended_Pictographic}]$/u.test(s);
  return alone(before) || after === "" || after.startsWith("\n");
}

/** Text for the chat bubbles: like the spoken text, but keeps line breaks. */
export function cleanForDisplay(text: string): string {
  return text
    .replace(/\*\*|__|`+/g, "")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
