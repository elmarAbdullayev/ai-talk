# How the video avatar was made

Leon's video loops (`frontend/public/avatar/video/`) were made once, offline, on a GTX 1660 Ti (6 GB).
The tools were removed afterwards; these two scripts are kept to show how it works and to make a new face.

1. `gen_face.py` – Stable Diffusion 1.5 with the Realistic Vision 5.1 model makes portraits of a man who does not
   exist (512×704). The chosen one was seed 303. GTX 16xx cards return NaN (black images) in half precision, so the
   script runs in float32 with model offloading (about 2 minutes per portrait).
2. `make_loops.py` – [LivePortrait](https://github.com/KwaiVGI/LivePortrait) animates the portrait into three seamless
   loops: listening (8 s), thinking (5 s), talking (10 s). No driving video: head pose, gaze, blinks, smile, brows and
   lip opening are periodic curves written in the script (about 4 minutes for all three).

Then `ffmpeg -i X.mp4 -c:v libx264 -crf 22 -preset slow -pix_fmt yuv420p -movflags +faststart -an X.mp4` for the web.

Setup used: Python 3.10 (uv), `torch==2.3.0+cu118`, LivePortrait's `requirements_base.txt`, `diffusers==0.30.3`,
`transformers==4.38.0`, LivePortrait weights from `KlingTeam/LivePortrait` (insightface + liveportrait folders).
The paths in the scripts (`C:\Users\abdul\avt\...`) are from that setup.
