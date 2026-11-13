"""Generates photorealistic portraits of a man who does not exist (Stable Diffusion 1.5, Realistic Vision 5.1).

python gen_face.py <out_dir> <fp16|fp32> <seed> [<seed> ...]
GTX 16xx cards sometimes give black images in half precision; then use fp32 (slow: model offload).
"""

import sys
from pathlib import Path

import numpy as np
import torch
from diffusers import AutoencoderKL, DPMSolverMultistepScheduler, StableDiffusionPipeline

MODELS = Path(r"C:\Users\abdul\avt\models")
CKPT = MODELS / "Realistic_Vision_V5.1_fp16-no-ema.safetensors"

PROMPT = (
    "RAW photo, upper body portrait of a 35 year old man wearing a navy blazer over a white shirt, whole head "
    "visible with headroom, friendly face, gentle closed-mouth smile, short dark hair, light stubble, looking at "
    "the camera, front view, soft studio light, plain dark blue grey background, sharp focus"
)
NEGATIVE = (
    "cartoon, painting, illustration, 3d render, anime, deformed, distorted face, asymmetric eyes, crossed eyes, "
    "open mouth, teeth, hands, glasses, hat, tie clip, text, watermark, logo, blurry, lowres, bad anatomy, "
    "multiple people, side view, tilted head, close-up, cropped head, harsh shadows, angry, serious"
)


def main() -> None:
    out_dir = Path(sys.argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    half = sys.argv[2] == "fp16"
    seeds = [int(s) for s in sys.argv[3:]] or [1, 2, 3, 4]
    dtype = torch.float16 if half else torch.float32
    vae = AutoencoderKL.from_pretrained(str(MODELS / "vae"), torch_dtype=dtype)
    # decode separately in float32 (the decoder overflows in half precision)
    vae32 = vae if not half else AutoencoderKL.from_pretrained(str(MODELS / "vae"), torch_dtype=torch.float32)
    pipe = StableDiffusionPipeline.from_single_file(
        str(CKPT), config=str(MODELS / "rv-config"), vae=vae, torch_dtype=dtype, load_safety_checker=False
    )
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type="dpmsolver++", solver_type="midpoint", use_karras_sigmas=True
    )
    if half:
        pipe.to("cuda")
    else:
        pipe.enable_model_cpu_offload()  # keeps the 6 GB card from spilling into slow shared memory
    pipe.enable_attention_slicing()
    for seed in seeds:
        generator = torch.Generator("cpu").manual_seed(seed)
        latents = pipe(
            PROMPT,
            negative_prompt=NEGATIVE,
            width=512,
            height=704,
            num_inference_steps=28,
            guidance_scale=5.5,
            generator=generator,
            output_type="latent",
        ).images
        with torch.no_grad():
            vae32.to("cuda")
            decoded = vae32.decode(latents.to("cuda", torch.float32) / vae32.config.scaling_factor).sample
            if not half:
                vae32.to("cpu")
        image = pipe.image_processor.postprocess(decoded, output_type="pil")[0]
        if torch.isnan(latents).any():
            print("latents contain NaN (half precision problem)", flush=True)
        mean = float(np.asarray(image).mean())
        path = out_dir / f"face_{seed}.png"
        image.save(path)
        print("saved", path, "brightness", round(mean, 1), "(black image!)" if mean < 5 else "", flush=True)


if __name__ == "__main__":
    main()
