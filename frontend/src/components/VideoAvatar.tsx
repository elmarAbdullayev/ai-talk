import { useEffect, useRef, useState } from "react";
import type { VideoAvatarSpec, VideoClip } from "../avatar/avatars";
import { chooseClip } from "../avatar/clips";
import type { Phase, TalkController } from "../talk/controller";

const CLIPS: VideoClip[] = ["listening", "thinking", "talking"];

interface Props {
  spec: VideoAvatarSpec;
  controller: TalkController;
  phase: Phase;
  onReady: (ok: boolean) => void;
}

/**
 * Leon as a photo-real face: three short video loops play all the time (muted) and the right one
 * fades in for the current state. Leon's voice still comes from speech synthesis.
 */
export function VideoAvatar({ spec, controller, phase, onReady }: Props) {
  const [active, setActive] = useState<VideoClip>("listening");
  const phaseRef = useRef(phase);
  const activeRef = useRef<VideoClip>("listening");
  const base = `${import.meta.env.BASE_URL}avatar/${spec.folder}`;
  phaseRef.current = phase;

  useEffect(() => {
    let raf = 0;
    let lastWord = -Infinity;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      if (controller.lipSync.sample(now).amount > 0) lastWord = now;
      const clip = chooseClip(phaseRef.current, now - lastWord);
      if (clip !== activeRef.current) {
        activeRef.current = clip;
        setActive(clip);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [controller]);

  const style = { "--video-bg": spec.background, "--video-aspect": spec.aspect } as React.CSSProperties;
  return (
    <div className="video-avatar" style={style}>
      <div className="video-avatar__frame">
        <img src={base + spec.poster} alt="" />
        {CLIPS.map((clip) => (
          <video
            key={clip}
            className={clip === active ? "on" : ""}
            src={base + spec.clips[clip]}
            muted
            loop
            autoPlay
            playsInline
            preload="auto"
            aria-hidden
            onLoadedData={clip === "listening" ? () => onReady(true) : undefined}
            onError={clip === "listening" ? () => onReady(false) : undefined}
          />
        ))}
      </div>
    </div>
  );
}
