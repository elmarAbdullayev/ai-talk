import { useEffect, useMemo, useRef, useState } from "react";
import { activeAvatar, type AvatarSpec } from "../avatar/avatars";
import { AvatarScene } from "../avatar/scene";
import type { Phase, TalkController } from "../talk/controller";
import { VideoAvatar } from "./VideoAvatar";

const LABELS: Record<Phase, string> = {
  idle: "Ready",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

type Status = "loading" | "ready" | "error";

interface Props {
  controller: TalkController;
  phase: Phase;
  interim: string;
  heard: string;
  started: boolean;
  onScene?: (scene: AvatarScene | null) => void;
  children?: React.ReactNode;
}

/** Leon (3D model or video loops), with his state and the words the user is saying right now. */
export function AvatarView({ controller, phase, interim, heard, started, onScene, children }: Props) {
  const spec = useMemo(() => activeAvatar(), []);
  const [status, setStatus] = useState<Status>("loading");
  const words = `${heard} ${interim}`.trim();

  return (
    <div className={`avatar avatar--${phase}`}>
      {spec.format === "video" ? (
        <VideoAvatar spec={spec} controller={controller} phase={phase} onReady={(ok) => setStatus(ok ? "ready" : "error")} />
      ) : (
        <ThreeAvatar spec={spec} controller={controller} phase={phase} onStatus={setStatus} onScene={onScene} />
      )}
      {status === "loading" && <div className="avatar__loading">Leon is getting ready …</div>}
      {status === "error" && (
        <div className="avatar__loading">Leon's picture could not load. The conversation still works.</div>
      )}
      {started && (
        <div className={`state-chip state-chip--${phase}`} role="status" aria-live="polite">
          <span className="state-chip__dot" />
          {LABELS[phase]}
        </div>
      )}
      {phase === "listening" && words && <div className="subtitle">{words}</div>}
      {children}
    </div>
  );
}

interface ThreeProps {
  spec: AvatarSpec;
  controller: TalkController;
  phase: Phase;
  onStatus: (status: Status) => void;
  onScene?: (scene: AvatarScene | null) => void;
}

/** Leon in 3D (Three.js): breathing, blinking, moods and lip-sync from the speech. */
function ThreeAvatar({ spec, controller, phase, onStatus, onScene }: ThreeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<AvatarScene | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let alive = true;
    let scene: AvatarScene;
    try {
      scene = new AvatarScene(canvas, () => controller.lipSync.sample(performance.now()));
    } catch (e) {
      console.error("[avatar] WebGL error", e);
      onStatus("error");
      return;
    }
    sceneRef.current = scene;
    scene
      .load(spec)
      .then(() => {
        if (!alive) return;
        scene.start();
        setLoaded(true);
        onStatus("ready");
        onScene?.(scene);
      })
      .catch((e: unknown) => {
        console.error("[avatar] could not load", e);
        if (alive) onStatus("error");
      });
    controller.onSentence = (text) => scene.animator?.sentence(text, performance.now() / 1000);
    controller.onUserSpeech = (talking) => scene.animator?.setUserTalking(talking);
    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => {
      alive = false;
      observer.disconnect();
      controller.onSentence = null;
      controller.onUserSpeech = null;
      onScene?.(null);
      scene.dispose();
      sceneRef.current = null;
    };
    // the scene lives as long as the page
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, spec]);

  useEffect(() => {
    if (sceneRef.current) sceneRef.current.mood = phase;
  }, [phase, loaded]);

  return <canvas ref={canvasRef} className="avatar__canvas" aria-label="Leon, the 3D conversation partner" />;
}
