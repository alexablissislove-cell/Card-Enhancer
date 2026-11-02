"""Bounded wrapper around the upstream SUPIR test.py CLI. No model is vendored."""
import base64
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile

from PIL import Image, ImageOps

MAX_INPUT_BYTES = 1536 * 1024
MAX_OUTPUT_BYTES = 2560 * 1024
Image.MAX_IMAGE_PIXELS = 2048 * 2048


def prepare_image(encoded, scale):
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("Input exceeds 1.5 MiB")
    if scale not in (1, 2):
        raise ValueError("Unsupported scale")
    with Image.open(io.BytesIO(raw)) as source:
        if source.format not in ("PNG", "JPEG", "WEBP"):
            raise ValueError("Unsupported image format")
        if max(source.size) > 2048 or min(source.size) < 32:
            raise ValueError("Input dimensions must be between 32 and 2048 pixels")
        image = ImageOps.exif_transpose(source).convert("RGB")
    w, h = image.size
    # SUPIR's minimum-side resizing can increase the requested scale.
    ratio = max(scale, 1024 / min(w, h))
    if max(w, h) * ratio > 4096 or w * h * ratio * ratio > 8 * 1024 * 1024:
        raise ValueError("Requested output exceeds the 4096px / 8-megapixel budget")
    return image


def build_command(repo, inputs, outputs, model, scale, seed):
    if model not in ("F", "Q") or scale not in (1, 2) or not 0 <= int(seed) <= 2147483647:
        raise ValueError("Invalid model, scale or seed")
    return [sys.executable, str(repo / "test.py"),
            "--img_dir", str(inputs), "--save_dir", str(outputs),
            "--SUPIR_sign", model, "--upscale", str(scale), "--seed", str(seed),
            "--edm_steps", "50", "--min_size", "1024", "--num_samples", "1",
            "--no_llava", "--loading_half_params", "--use_tile_vae",
            "--a_prompt", "a scanned collectible card, faithful restoration, preserve original printed detail",
            "--n_prompt", "invented text, changed lettering, changed artwork, artifacts, oversmoothing"]


def restore(job, execute=subprocess.run):
    repo = Path(os.environ["SUPIR_REPO"]).resolve()
    if not (repo / "test.py").is_file():
        raise ValueError("SUPIR_REPO must contain the upstream test.py")
    image = prepare_image(job["input_base64"], job["scale"])
    with tempfile.TemporaryDirectory(prefix="supir-") as temp:
        inputs, outputs = Path(temp) / "input", Path(temp) / "output"
        inputs.mkdir()
        outputs.mkdir()
        image.save(inputs / "card.png")
        # No shell interpolation; the original filename is never used as a path.
        command = build_command(repo, inputs, outputs, job["model"], job["scale"], job["seed"])
        # Keep upstream diagnostics in the worker's local terminal, not in the public job record.
        execute(command, cwd=repo, check=True, timeout=900)
        result_path = outputs / "card_0.png"
        with Image.open(result_path) as result:
            if max(result.size) > 4096 or result.width * result.height > 8 * 1024 * 1024:
                raise ValueError("Output exceeds the pixel budget")
            output = io.BytesIO()
            result.convert("RGB").save(output, format="JPEG", quality=95, optimize=True)
        if len(output.getvalue()) > MAX_OUTPUT_BYTES:
            raise ValueError("Output exceeds 2.5 MiB; try a smaller input or scale")
        return base64.b64encode(output.getvalue()).decode("ascii")
