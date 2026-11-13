import type { LanguageCode } from "../config/languages";
import { buildTimeline, isVowel, visemeInWord, type Viseme, type WordTiming } from "./visemes";

export interface MouthSample {
  viseme: Viseme;
  /** 0 = closed/rest, 1 = full shape */
  amount: number;
}

/** Typical speed of Edge's natural voices at rate 1 (letters incl. spaces per second). */
export const BASE_CHARS_PER_SECOND = 14.5;

/**
 * Follows the sentence that is being spoken and tells the avatar which mouth shape to show.
 * The timing is estimated from the text; every word boundary event of the voice puts it back
 * in step (and adjusts the estimated speed). Works without boundary events too.
 */
export class LipSync {
  private words: WordTiming[] = [];
  private active = false;
  private anchorWall = 0;
  private anchorT = 0;
  private speed = 1;
  private lastBoundaryWall = -1;
  private lastBoundaryT = 0;

  get speaking(): boolean {
    return this.active;
  }

  /** A sentence starts playing (utterance start event). `now` in milliseconds. */
  start(text: string, lang: LanguageCode, rate: number, now: number): void {
    this.words = buildTimeline(text, lang, BASE_CHARS_PER_SECOND * Math.max(0.3, rate));
    this.active = true;
    this.anchorWall = now;
    this.anchorT = 0;
    // keep the speed learned from the last sentence (same voice), but not extreme values
    this.speed = Math.min(1.4, Math.max(0.75, this.speed));
    this.lastBoundaryWall = -1;
  }

  /** A word starts (boundary event with the character index). */
  boundary(charIndex: number, now: number): void {
    if (!this.active) return;
    const word = this.words.find((w) => charIndex < w.end) ?? null;
    if (!word) return;
    if (this.lastBoundaryWall >= 0 && word.t0 > this.lastBoundaryT) {
      const seconds = (now - this.lastBoundaryWall) / 1000;
      if (seconds > 0.04) {
        const measured = (word.t0 - this.lastBoundaryT) / seconds;
        this.speed = Math.min(2, Math.max(0.5, this.speed * 0.5 + measured * 0.5));
      }
    }
    this.anchorWall = now;
    this.anchorT = word.t0;
    this.lastBoundaryWall = now;
    this.lastBoundaryT = word.t0;
  }

  /** The sentence ended or speaking was stopped. */
  stop(): void {
    this.active = false;
  }

  /** Estimated seconds into the sentence. */
  position(now: number): number {
    return this.anchorT + ((now - this.anchorWall) / 1000) * this.speed;
  }

  sample(now: number): MouthSample {
    if (!this.active) return { viseme: "sil", amount: 0 };
    const t = this.position(now);
    const word = this.words.find((w) => t >= w.t0 && t < w.t1);
    if (!word) return { viseme: "sil", amount: 0 };
    const viseme = visemeInWord(word.visemes, (t - word.t0) / (word.t1 - word.t0));
    return { viseme, amount: isVowel(viseme) ? 1 : 0.75 };
  }
}
