import type { Phase } from "../talk/controller";
import type { VideoClip } from "./avatars";

/** Keep the talking clip this long after the last spoken word, so short gaps do not flicker. */
export const TALK_HOLD_MS = 220;

/**
 * Which video loop to show. While Leon speaks, the talking loop runs only during words; in the
 * pauses between phrases the calm loop shows a closed mouth, so the rhythm follows the speech.
 */
export function chooseClip(phase: Phase, msSinceLastWord: number): VideoClip {
  if (phase === "thinking") return "thinking";
  if (phase === "speaking" && msSinceLastWord < TALK_HOLD_MS) return "talking";
  return "listening";
}
