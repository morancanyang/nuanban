import argparse
import hashlib
import json
import struct
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
REVISION = "lumi-natural-20261024-v4"
VIEWS = ("hero", "front", "side", "back", "detail", "grip")


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def inspect_render(path, entry):
    with path.open("rb") as source:
        header = source.read(33)
    if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError(f"Not a PNG: {path}")
    width, height, depth, color_type = struct.unpack(">IIBB", header[16:26])
    square = entry["view"] in {"detail", "grip"}
    expected = (2400, 2400 if square else 2800, 16, 6)
    if (width, height, depth, color_type) != expected:
        raise ValueError(f"Expected a full-size 16-bit RGBA master: {path}")
    if (entry["width"], entry["height"], entry["bitDepth"]) != expected[:3]:
        raise ValueError(f"Render metadata disagrees with the PNG: {path}")
    if not entry["transparent"] or entry["samples"] < 128:
        raise ValueError(f"Draft or nontransparent render: {path}")
    with Image.open(path) as image:
        alpha = image.getchannel("A")
        bounds = alpha.getbbox()
        if alpha.getextrema() != (0, 255) or bounds is None:
            raise ValueError(f"Expected transparency and an opaque character: {path}")
        if not square and (bounds[0] <= 0 or bounds[1] <= 0 or bounds[2] >= width or bounds[3] >= height):
            raise ValueError(f"Full-body silhouette is clipped: {path}")
    return {"view": entry["view"], "file": path.name, "width": width, "height": height,
            "bitDepth": depth, "samples": entry["samples"], "alphaBounds": list(bounds),
            "bytes": path.stat().st_size, "sha256": sha256(path)}


def main():
    parser = argparse.ArgumentParser(description="Validate and package the isolated static Lumi natural-v4 review")
    parser.add_argument("--source", type=Path, default=ROOT / "work/lumi-natural-v4")
    parser.add_argument("--reference-source", type=Path,
                        default=ROOT / "work/character-reference-v3/lumi/lumi-reference-v3.blend")
    parser.add_argument("--review", type=Path, default=ROOT / "design/characters/lumi-natural-v4")
    arguments = parser.parse_args()
    source = arguments.source.resolve(strict=True)
    review = arguments.review.resolve(strict=True)
    reference = arguments.reference_source.resolve(strict=True)
    manifest_path = source / "candidate-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["revision"] != REVISION or manifest["character"] != "lumi":
        raise ValueError("Wrong character or revision")
    if manifest["rigged"] or manifest["animationClips"] or manifest["productAssetsReplaced"] or manifest["backgroundGeometry"]:
        raise ValueError("Only static, isolated, non-production look development belongs in this delivery")
    for name in ("CAT_HEAD_sculpted_cheeks", "CAT_PAW_R_grip"):
        topology = manifest["topology"][name]
        if topology["components"] != 1 or topology["nonManifoldEdges"] or not topology["positiveVolume"]:
            raise ValueError(f"Invalid static sculpt topology: {name}")
    if manifest["sourceBlend"] != reference.name or manifest["sourceSha256"] != sha256(reference):
        raise ValueError("The v3 source is missing or changed")
    blend = source / "lumi-natural-v4.blend"
    if manifest["blend"] != blend.name or manifest["blendSha256"] != sha256(blend):
        raise ValueError("Candidate source hash mismatch")
    entries = {entry["view"]: entry for entry in manifest["renders"]}
    if set(entries) != set(VIEWS) or len(manifest["renders"]) != len(VIEWS):
        raise ValueError("Expected four full-body views, face detail and gripping-paw detail")
    inspected = []
    for view in VIEWS:
        entry = entries[view]
        if entry["file"] != f"lumi-{view}.png":
            raise ValueError(f"Unexpected image name for {view}")
        inspected.append(inspect_render(source / entry["file"], entry))
    previews = []
    for entry in inspected:
        path = review / f"lumi-{entry['view']}-preview.png"
        with Image.open(source / entry["file"]) as image:
            reduced = image.convert("RGBA")
            reduced.thumbnail((1200, 1400), Image.Resampling.LANCZOS)
            reduced.save(path, optimize=True)
            previews.append({"view": entry["view"], "file": path.name, "width": reduced.width,
                             "height": reduced.height, "bitDepth": 8, "sha256": sha256(path)})
    archive = source / "lumi-natural-v4-delivery.zip"
    with ZipFile(archive, "w", compression=ZIP_STORED) as bundle:
        for path in (blend, manifest_path, *(source / entry["file"] for entry in inspected)):
            bundle.write(path, f"lumi-natural-v4/{path.name}")
        bundle.write(review / "README.md", "lumi-natural-v4/README.md")
        bundle.write(ROOT / "design/characters/reference-v3/lumi-modeling-prompt.md",
                     "lumi-natural-v4/modeling-and-next-stage-motion-spec.md")
    result = {"revision": REVISION, "status": "static natural look-development review; not rigged or animated",
              "workflow": manifest["workflow"], "nativeMcpConnectorUsed": False,
              "aiRefinementUsed": False, "comfyUIUsed": False, "productAssetsReplaced": False,
              "masterFilesCommitted": False, "localMasterDirectory": "work/lumi-natural-v4 (default; see --source)",
              "sourceBlend": reference.name, "sourceBlendSha256": manifest["sourceSha256"],
              "candidateBlend": blend.name, "candidateBlendSha256": manifest["blendSha256"],
              "groomStrands": manifest["groomStrands"], "rigged": False, "animationClips": [],
              "topology": manifest["topology"],
              "changes": manifest["changes"], "renders": inspected, "previews": previews,
              "localOnlyArchive": archive.name, "archiveBytes": archive.stat().st_size,
              "archiveSha256": sha256(archive)}
    (review / "delivery-manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
