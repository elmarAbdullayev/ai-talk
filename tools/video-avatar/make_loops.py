"""Animates one portrait photo into short seamless loops (listening / thinking / talking) with LivePortrait.

python make_loops.py <portrait.png> <out_dir> [preview]

No driving video: the head, eye and lip movements are generated here as smooth periodic functions,
so every loop ends exactly where it starts. LivePortrait's own math for eyes, smile and brows
(from its Gradio editor) is reused below.
"""

import math
import sys
from pathlib import Path

sys.path.insert(0, r"C:\Users\abdul\avt\LivePortrait")

import imageio.v2 as imageio  # noqa: E402
import numpy as np  # noqa: E402
import torch  # noqa: E402

from src.config.crop_config import CropConfig  # noqa: E402
from src.config.inference_config import InferenceConfig  # noqa: E402
from src.live_portrait_pipeline import LivePortraitPipeline  # noqa: E402
from src.utils.camera import get_rotation_matrix  # noqa: E402
from src.utils.crop import paste_back, prepare_paste_back  # noqa: E402
from src.utils.io import load_image_rgb  # noqa: E402
from src.utils.retargeting_utils import calc_eye_close_ratio, calc_lip_close_ratio  # noqa: E402

FPS = 25


def smoothstep(x: float) -> float:
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)


def blink_curve(t: float, times: list[float], length: float = 0.22) -> float:
    """0 = open, 1 = closed; a quick close and a slightly slower open."""
    value = 0.0
    for start in times:
        p = (t - start) / length
        if 0 <= p <= 1:
            value = max(value, math.sin(p * math.pi) ** 0.8)
    return value


class Animator:
    def __init__(self, portrait: Path) -> None:
        self.cfg = InferenceConfig(flag_use_half_precision=False)
        self.pipe = LivePortraitPipeline(inference_cfg=self.cfg, crop_cfg=CropConfig())
        w = self.wrapper = self.pipe.live_portrait_wrapper
        self.img = load_image_rgb(str(portrait))
        crop = self.pipe.cropper.crop_source_image(self.img, self.pipe.cropper.crop_cfg)
        if crop is None:
            raise SystemExit("no face found in the portrait")
        self.crop = crop
        self.lmk = crop["lmk_crop"]
        self.mask = prepare_paste_back(self.cfg.mask_crop, crop["M_c2o"], dsize=(self.img.shape[1], self.img.shape[0]))
        I_s = w.prepare_source(crop["img_crop_256x256"])
        self.info = w.get_kp_info(I_s)
        self.f_s = w.extract_feature_3d(I_s)
        self.x_s = w.transform_keypoint(self.info)
        self.R_s = get_rotation_matrix(self.info["pitch"], self.info["yaw"], self.info["roll"])
        self.eye0 = float(calc_eye_close_ratio(self.lmk[None]).mean())
        self.lip0 = float(calc_lip_close_ratio(self.lmk[None])[0][0])
        print(f"source eye ratio {self.eye0:.3f}, lip ratio {self.lip0:.3f}", flush=True)

    # --- expression edits, as in LivePortrait's gradio_pipeline.py ---
    @staticmethod
    def eyeball(d, x, y):
        if x > 0:
            d[0, 11, 0] += x * 0.0007
            d[0, 15, 0] += x * 0.001
        else:
            d[0, 11, 0] += x * 0.001
            d[0, 15, 0] += x * 0.0007
        d[0, 11, 1] += y * -0.001
        d[0, 15, 1] += y * -0.001
        blink = -y / 2.0
        d[0, 11, 1] += blink * -0.001
        d[0, 13, 1] += blink * 0.0003
        d[0, 15, 1] += blink * -0.001
        d[0, 16, 1] += blink * 0.0003

    @staticmethod
    def smile(d, s):
        d[0, 20, 1] += s * -0.01
        d[0, 14, 1] += s * -0.02
        d[0, 17, 1] += s * 0.0065
        d[0, 17, 2] += s * 0.003
        d[0, 13, 1] += s * -0.00275
        d[0, 16, 1] += s * -0.00275
        d[0, 3, 1] += s * -0.0035
        d[0, 7, 1] += s * -0.0035

    @staticmethod
    def eyebrow(d, e):
        if e > 0:
            d[0, 1, 1] += e * 0.001
            d[0, 2, 1] += e * -0.001
        else:
            d[0, 1, 0] += e * -0.001
            d[0, 2, 0] += e * 0.001
            d[0, 1, 1] += e * 0.0003
            d[0, 2, 1] += e * -0.0003

    @staticmethod
    def lip_round(d, v):
        # lip_variation_two in the editor: rounder lips ("o", "u")
        d[0, 20, 2] += v * -0.001
        d[0, 20, 1] += v * -0.001
        d[0, 14, 1] += v * -0.001

    @torch.no_grad()
    def frame(self, pitch=0.0, yaw=0.0, roll=0.0, eye=None, lip=None, look=(0.0, 0.0), smile=0.0, brow=0.0, round_=0.0):
        w = self.wrapper
        dev = w.device
        R_d = get_rotation_matrix(self.info["pitch"] + pitch, self.info["yaw"] + yaw, self.info["roll"] + roll)
        R = ((R_d @ self.R_s.permute(0, 2, 1)) @ self.R_s).to(dev)
        delta = self.info["exp"].clone().to(dev)
        if look != (0.0, 0.0):
            self.eyeball(delta, *look)
        if smile:
            self.smile(delta, smile)
        if brow:
            self.eyebrow(delta, brow)
        if round_:
            self.lip_round(delta, round_)
        x_d = self.info["scale"].to(dev) * (self.info["kp"].to(dev) @ R + delta) + self.info["t"].to(dev)
        x_s = self.x_s.to(dev)
        if eye is not None:
            x_d = x_d + w.retarget_eye(x_s, w.calc_combined_eye_ratio([[float(eye)]], self.lmk))
        if lip is not None:
            x_d = x_d + w.retarget_lip(x_s, w.calc_combined_lip_ratio([[float(lip)]], self.lmk))
        x_d = w.stitching(x_s, x_d)
        out = w.warp_decode(self.f_s.to(dev), x_s, x_d)
        crop_img = w.parse_output(out["out"])[0]
        return paste_back(crop_img, self.crop["M_c2o"], self.img, self.mask)


def listening(t: float, T: float) -> dict:
    """Calm attention: small nods, slight tilt, friendly face, blinks."""
    a = 2 * math.pi * t / T
    return dict(
        pitch=1.6 * math.sin(2 * a) + 0.8 * math.sin(3 * a + 1.0),
        yaw=2.2 * math.sin(a + 0.4) + 0.6 * math.sin(4 * a),
        roll=2.0 + 1.2 * math.sin(a + 2.0),
        blink=blink_curve(t, [1.4, 4.6, 6.9]),
        look=(1.5 * math.sin(a), 0.0),
        smile=0.35 + 0.1 * math.sin(a),
        brow=0.0,
    )


def thinking(t: float, T: float) -> dict:
    """Looks up to the side, slow small movements."""
    a = 2 * math.pi * t / T
    return dict(
        pitch=-4.0 + 0.8 * math.sin(a),
        yaw=5.0 + 1.5 * math.sin(a + 0.7),
        roll=-2.5 + 0.8 * math.sin(2 * a),
        blink=blink_curve(t, [2.6]),
        look=(9.0 + 2.0 * math.sin(a), 8.0 + 1.5 * math.sin(2 * a + 0.5)),
        smile=0.0,
        brow=-2.0,
    )


def talking(t: float, T: float, rng_phases: list[float]) -> dict:
    """Speech-like mouth: syllables (~4.5 per second) grouped in words and phrases, with head moves."""
    a = 2 * math.pi * t / T
    # phrase envelope: two short pauses per loop
    phrase = smoothstep(min(abs(math.sin(a)), abs(math.sin(a + 0.9))) * 3.2)
    syllable = abs(math.sin(math.pi * 4.6 * t + 0.6 * math.sin(2 * math.pi * 0.7 * t + rng_phases[0])))
    word = 0.65 + 0.35 * math.sin(2 * math.pi * 1.3 * t + rng_phases[1])
    openness = phrase * syllable * word
    return dict(
        pitch=1.8 * math.sin(3 * a) + 1.2 * math.sin(5 * a + 0.3),
        yaw=3.0 * math.sin(a + 0.5) + 1.0 * math.sin(4 * a),
        roll=1.2 * math.sin(2 * a + 1.0),
        blink=blink_curve(t, [1.1, 4.3, 7.7]),
        look=(1.0 * math.sin(2 * a), 0.0),
        smile=0.15,
        brow=1.2 * max(0.0, math.sin(2 * a + 0.4)),
        mouth=openness,
        round_=8.0 * max(0.0, math.sin(2 * math.pi * 0.9 * t)) * phrase,
    )


def render_loop(anim: Animator, name: str, seconds: float, motion, out_dir: Path, preview: bool) -> Path:
    n = int(seconds * FPS)
    if preview:
        n = min(n, 6)
    frames = []
    for i in range(n):
        t = i / FPS
        m = motion(t, seconds)
        eye = anim.eye0 * (1 - m["blink"]) + 0.02 * m["blink"]
        lip = None
        if "mouth" in m:
            lip = anim.lip0 + 0.42 * m["mouth"]
        frames.append(
            anim.frame(
                pitch=m["pitch"], yaw=m["yaw"], roll=m["roll"], eye=eye, lip=lip, look=m["look"],
                smile=m["smile"], brow=m["brow"], round_=m.get("round_", 0.0),
            )
        )
        if i % 25 == 0:
            print(f"{name}: frame {i}/{n}", flush=True)
    if preview:
        for i, f in enumerate(frames):
            imageio.imwrite(out_dir / f"{name}_{i}.jpg", f)
        return out_dir
    path = out_dir / f"{name}.mp4"
    imageio.mimwrite(path, frames, fps=FPS, codec="libx264", quality=8, pixelformat="yuv420p", macro_block_size=8)
    print("saved", path, flush=True)
    return path


def main() -> None:
    portrait = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    preview = len(sys.argv) > 3 and sys.argv[3] == "preview"
    anim = Animator(portrait)
    phases = [0.8, 2.1]
    render_loop(anim, "listening", 8.0, listening, out_dir, preview)
    render_loop(anim, "thinking", 5.0, thinking, out_dir, preview)
    render_loop(anim, "talking", 10.0, lambda t, T: talking(t, T, phases), out_dir, preview)
    # the still first frame of listening, shown while the videos load
    imageio.imwrite(out_dir / "poster.jpg", anim.frame(roll=2.0, smile=0.35), quality=90)


if __name__ == "__main__":
    main()
