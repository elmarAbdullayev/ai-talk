import type { AvatarScene } from "./avatar/scene";
import type { TalkController } from "./talk/controller";

/**
 * Development only: `window.__talk` to test without microphone or speakers (e.g. in an embedded
 * browser): pretend speech, make Leon speak, change his mood, tune the pose, save pictures.
 */
export function installDevHooks(controller: TalkController, scene: AvatarScene | null): () => void {
  const hooks = {
    controller,
    scene,
    state: () => controller.getSnapshot(),
    /** pretend the user said this (like a final speech recognition result) */
    say: (text: string) => controller.simulateSpeech(text),
    /** Leon's lips follow this sentence for its estimated time (no sound) */
    lips: (text: string) => {
      controller.lipSync.start(text, controller.spokenLanguage(), 1, performance.now());
      scene?.animator?.sentence(text, performance.now() / 1000);
      if (scene) scene.mood = "speaking";
    },
    mood: (mood: "idle" | "listening" | "thinking" | "speaking") => {
      if (scene) scene.mood = mood;
    },
    pose: (bone: string, x: number, y: number, z: number) => scene?.animator?.poseOverride.set(bone, [x, y, z]),
    clearPose: () => scene?.animator?.poseOverride.clear(),
    shape: (name: string, value: number) => scene?.animator?.debugShape(name, value),
    /** stop the animation loop and draw single frames with step() */
    manual: (on: boolean) => {
      if (scene) scene.manual = on;
    },
    step: (dt = 1 / 60, nowMs?: number) => scene?.step(dt, nowMs),
    /** saves the canvas into frontend/.captures/<name>.jpg */
    capture: async (name: string) => {
      if (!scene) return "no scene";
      const response = await fetch(`/__capture?name=${encodeURIComponent(name)}`, { method: "POST", body: scene.capture() });
      return response.text();
    },
  };
  (window as unknown as { __talk: typeof hooks }).__talk = hooks;
  return () => {
    delete (window as unknown as { __talk?: typeof hooks }).__talk;
  };
}
