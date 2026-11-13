/**
 * Teacher mode: the AI starts its answer with a correction block, then the reply:
 *
 *   YOU SAID: <the user's sentence with the mistake>
 *   BETTER: <the corrected sentence>
 *   WHY: <a short reason>
 *   REPLY: <the answer that is spoken>
 *
 * The parser works on the stream: the correction is shown on screen, only the reply is spoken.
 * Small models do not always follow the format, so it is forgiving.
 */

export interface Correction {
  said: string;
  better: string;
  why: string;
}

const LABELS = ["YOU SAID", "BETTER", "WHY", "REPLY"] as const;
const REPLY_LABEL = /(^|\n)[ \t]*[*_]*[ \t]*REPLY[ \t]*[*_]*[ \t]*:[ \t]*[*_]*[ \t]*/i;
const LABEL_LINE = /^[ \t]*[*_]*[ \t]*(YOU SAID|BETTER|WHY|REPLY)[ \t]*[*_]*[ \t]*:/i;

function stripMarks(s: string): string {
  return s.replace(/[*_]/g, "").trimStart();
}

/** True while `text` could still turn into one of the labels (e.g. "YOU S"). */
function couldBeLabel(text: string): boolean {
  const t = stripMarks(text).toUpperCase();
  return LABELS.some((label) => (label + ":").startsWith(t) || t.startsWith(label));
}

export class TeacherParser {
  private raw = "";
  /** index in `raw` where the spoken reply starts, -1 while not known */
  private replyStart = -1;
  private sent = 0;

  /** Adds streamed text; returns the new part of the reply (to be spoken). */
  push(chunk: string): string {
    this.raw += chunk;
    if (this.replyStart < 0) this.replyStart = this.findReplyStart(false);
    return this.take();
  }

  /** The stream ended: returns the rest of the reply. */
  finish(): string {
    if (this.replyStart < 0) this.replyStart = this.findReplyStart(true);
    return this.take();
  }

  /** The reply so far (for the chat bubble). */
  get reply(): string {
    return this.replyStart < 0 ? "" : this.raw.slice(this.replyStart).trim();
  }

  /** The whole answer as the model wrote it (sent back as history). */
  get text(): string {
    return this.raw;
  }

  /** The correction, once its lines are complete. */
  correction(): Correction | null {
    const block = this.replyStart < 0 ? this.raw : this.raw.slice(0, this.replyStart);
    return parseCorrection(block, this.replyStart >= 0);
  }

  private take(): string {
    if (this.replyStart < 0) return "";
    const from = Math.max(this.replyStart, this.sent);
    this.sent = this.raw.length;
    const piece = this.raw.slice(from);
    // no spaces before the first word of the reply
    return this.raw.slice(this.replyStart, from).trim() ? piece : piece.trimStart();
  }

  private findReplyStart(ended: boolean): number {
    const raw = this.raw;
    const label = REPLY_LABEL.exec(raw);
    if (label) return label.index + label[0].length;
    const firstText = raw.search(/\S/);
    if (firstText < 0) return ended ? raw.length : -1;
    const head = raw.slice(firstText);
    const firstLine = head.split("\n")[0];
    if (!LABEL_LINE.test(firstLine)) {
      // no correction block: everything is the reply (unless it may still become a label)
      if (!ended && !head.includes("\n") && couldBeLabel(head)) return -1;
      return firstText;
    }
    // inside the correction block: the reply starts at the first line after it without a label
    const lines = raw.split("\n");
    let offset = 0;
    let seenLabel = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const complete = i < lines.length - 1;
      if (LABEL_LINE.test(line)) seenLabel = true;
      else if (seenLabel && line.trim() && (complete || ended || !couldBeLabel(line))) return offset;
      offset += line.length + 1;
    }
    return ended ? raw.length : -1;
  }
}

function labelValue(block: string, label: string): string {
  const re = new RegExp(`^[ \\t]*[*_]*[ \\t]*${label}[ \\t]*[*_]*[ \\t]*:[ \\t]*[*_]*(.*)$`, "im");
  const value = (re.exec(block)?.[1] ?? "").replace(/[*_]+$/g, "").trim();
  // remove quotes only when they surround the whole value
  const quoted = /^["“„«'](.*)["”“»']$/.exec(value);
  return (quoted ? quoted[1] : value).trim();
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "… (Keine Änderung nötig)" / "(no change needed)": the model's note that nothing was wrong. */
const NO_CHANGE = /\((?:[^()]*\b(?:keine|no|nothing|kein|yok|нет|без|düzgün|doğru|korrekt|correct)\b[^()]*)\)\s*$/iu;
const NO_CHANGE_WORDS =
  /^(?:keine änderung|kein fehler|alles (?:korrekt|richtig)|no (?:change|mistake)s?|correct|korrekt|richtig|doğru|düzgündür|hata yok|səhv yoxdur|всё правильно|правильно)[.!]?$/iu;

/**
 * Reads the correction lines. `complete` = the block has ended (the reply started), so the last
 * line is finished too. Returns null when there is no real correction.
 */
export function parseCorrection(block: string, complete = true): Correction | null {
  const usable = complete ? block : block.slice(0, block.lastIndexOf("\n") + 1);
  const said = labelValue(usable, "YOU SAID");
  const better = labelValue(usable, "BETTER").replace(NO_CHANGE, "").trim();
  const why = labelValue(usable, "WHY");
  if (!better || NO_CHANGE_WORDS.test(better) || NO_CHANGE_WORDS.test(said)) return null;
  // the model sometimes "corrects" a sentence into the same sentence
  if (said && normalize(said) === normalize(better)) return null;
  return { said, better, why };
}

/** For a finished answer (e.g. from history): the correction and the reply. */
export function parseTeacherAnswer(raw: string): { correction: Correction | null; reply: string } {
  const parser = new TeacherParser();
  parser.push(raw);
  parser.finish();
  return { correction: parser.correction(), reply: parser.reply };
}
