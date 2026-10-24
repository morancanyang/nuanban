import argparse
import hashlib
import json
import struct
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from PIL import Image


REVISION = "reference-20261024-v3"
VIEWS = ("hero", "front", "side", "back", "detail")
ROOT = Path(__file__).resolve().parents[2]


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def inspect_render(path, entry):
    with path.open("rb") as source:
        header = source.read(33)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a PNG render: {path}")
    width, height, depth, color_type = struct.unpack(">IIBB", header[16:26])
    if (width, height, depth, color_type) != (entry["width"], entry["height"], 16, 6):
        raise ValueError(f"Expected a full-resolution 16-bit RGBA render: {path}")
    with Image.open(path) as image:
        alpha = image.getchannel("A")
        bounds = alpha.getbbox()
        if alpha.getextrema() != (0, 255) or bounds is None:
            raise ValueError(f"Missing transparent background or opaque character: {path}")
        if entry["view"] != "detail" and (
            bounds[0] <= 0 or bounds[1] <= 0 or bounds[2] >= width or bounds[3] >= height
        ):
            raise ValueError(f"Full-body silhouette reaches the frame edge: {path}")
    return {"file": path.name, "width": width, "height": height, "bitDepth": depth,
            "alphaBounds": list(bounds), "bytes": path.stat().st_size, "sha256": sha256(path)}


def package_character(character, source_root, review):
    directory = source_root / character
    manifest_path = directory / "candidate-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["revision"] != REVISION or manifest["character"] != character:
        raise ValueError(f"Unexpected candidate manifest: {manifest_path}")
    if manifest["rigged"] or manifest["productAssetsReplaced"] or manifest["backgroundGeometry"]:
        raise ValueError("Only static, isolated, non-production candidates belong in this review")
    blend = directory / f"{character}-reference-v3.blend"
    if manifest["blend"] != blend.name or sha256(blend) != manifest["blendSha256"]:
        raise ValueError(f"Candidate source hash mismatch: {blend}")
    renders = {entry["view"]: entry for entry in manifest["renders"]}
    if set(renders) != set(VIEWS) or len(manifest["renders"]) != len(VIEWS):
        raise ValueError("Expected one complete render for each of the five review views")
    inspected, previews = [], []
    for view in VIEWS:
        entry = renders[view]
        expected = f"{character}-{view}.png"
        if entry["file"] != expected or not entry["transparent"] or entry["bitDepth"] != 16:
            raise ValueError(f"Unexpected render metadata: {entry}")
        image_path = directory / expected
        inspected.append(inspect_render(image_path, entry))
        if view in ("hero", "detail"):
            preview = review / f"{character}-{view}-preview.png"
            with Image.open(image_path) as image:
                reduced = image.convert("RGBA")
                reduced.thumbnail((1200, 1400), Image.Resampling.LANCZOS)
                reduced.save(preview, optimize=True)
                previews.append({"file": preview.name, "width": reduced.width, "height": reduced.height,
                                 "bitDepth": 8, "sha256": sha256(preview)})
    prompt = review / f"{character}-modeling-prompt.md"
    archive = source_root / f"{character}-reference-v3-delivery.zip"
    with ZipFile(archive, "w", compression=ZIP_STORED) as bundle:
        for path in (blend, manifest_path, *(directory / f"{character}-{view}.png" for view in VIEWS)):
            bundle.write(path, f"{character}/{path.name}")
        bundle.write(prompt, f"{character}/modeling-prompt.md")
        bundle.writestr(f"{character}/DELIVERY.md", (
            f"# {character} — {REVISION}\n\n"
            "Editable static look-development candidate, not a finished animation-ready production asset.\n\n"
            "Contains the candidate Blender source, five transparent 16-bit Cycles renders, provenance "
            "manifest and detailed modeling / next-stage animation prompt.\n\n"
            "No rig, skeletal animation, manual retopology, AI refinement or ComfyUI render is included. "
            "The seven motion specifications in the prompt are requirements, not completed clips. "
            "Production character assets have not been replaced.\n"
        ))
    return {"character": character, "sourceBlendSha256": manifest["sourceSha256"],
            "candidateBlend": blend.name, "candidateBlendSha256": manifest["blendSha256"],
            "groomStrands": manifest["groomStrands"], "rigged": False, "animationClips": [],
            "motionSpecifications": 7, "renders": inspected, "previews": previews,
            "localOnlyArchive": archive.name, "archiveBytes": archive.stat().st_size,
            "archiveSha256": sha256(archive)}


def main():
    parser = argparse.ArgumentParser(description="Validate and package the two static character review candidates")
    parser.add_argument("--source", type=Path, default=ROOT / "work/character-reference-v3")
    parser.add_argument("--review", type=Path, default=ROOT / "design/characters/reference-v3")
    arguments = parser.parse_args()
    source = arguments.source.resolve(strict=True)
    review = arguments.review.resolve(strict=True)
    result = {"revision": REVISION, "status": "static look-development review; animation requirements only",
              "workflow": "existing original Blender models refined through the installed loopback MCP addon bridge",
              "nativeMcpConnectorUsed": False, "aiRefinementUsed": False, "comfyUIUsed": False,
              "productAssetsReplaced": False, "masterFilesCommitted": False,
              "localMasterDirectory": "work/character-reference-v3 (default; see --source for custom locations)",
              "characters": [package_character(character, source, review) for character in ("lili", "lumi")]}
    (review / "delivery-manifest.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
