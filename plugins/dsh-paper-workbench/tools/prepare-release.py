#!/usr/bin/env python3
"""Validate a packed plugin and prepare release assets, without publishing.

Run after committing release source and running package.mjs / npm pack.
"""
from pathlib import Path
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile

root = Path(__file__).resolve().parents[3]
plugin = root / "plugins/dsh-paper-workbench"
manifest = json.loads((plugin / "package.json").read_text(encoding="utf-8"))
version = manifest["version"]
if manifest["name"] != "dsh-paper-workbench" or not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise RuntimeError("Expected the plugin's stable release version")
if subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root).strip():
    raise RuntimeError("Commit tracked release changes before generating source assets")
head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root).decode().strip()
committed = json.loads(subprocess.check_output(["git", "show", "HEAD:plugins/dsh-paper-workbench/package.json"], cwd=root))
if committed != manifest:
    raise RuntimeError("Plugin manifest is not the committed release manifest")
stable_name = "dsh-paper-workbench-windows-x64.tgz"
catalog = root / "docs/marketplace/Cluodwaters__dsh-paper-workbench--plugins-dsh-paper-workbench.yml"
expected_url = f"https://github.com/Cluodwaters/dsh-paper-workbench/releases/latest/download/{stable_name}"
if f"tarball: {expected_url}" not in catalog.read_text(encoding="utf-8").splitlines():
    raise RuntimeError("Catalog must use the fixed-name latest release asset")
installer = plugin / f"dsh-paper-workbench-{version}.tgz"
# Stream the gzip archive once. Seeking separately for every resource would
# repeatedly decompress the 90 MB installer on each validation pass.
packed_files = {}
payloads = {}
needed_payloads = {"package/package.json", "package/RESOURCES.json", "package/RUNTIME-MANIFEST.json"}
with tarfile.open(installer, "r|gz") as packed:
    for entry in packed:
        if entry.isdir():
            continue
        if not entry.isfile() or entry.name in packed_files:
            raise RuntimeError(f"Unexpected or duplicate installer entry: {entry.name}")
        source = packed.extractfile(entry)
        digest = hashlib.sha256()
        if entry.name in needed_payloads:
            data = source.read()
            payloads[entry.name] = data
            digest.update(data)
        else:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        packed_files[entry.name] = {"size": entry.size, "sha256": digest.hexdigest()}
actual = json.loads(payloads["package/package.json"])
if actual != manifest:
    raise RuntimeError("Installer manifest differs from the committed source")
patch = actual["dsh"]["bundle"]["patch"].removeprefix("./")
if "package/" + patch not in packed_files:
    raise RuntimeError("Installer bundle patch is missing")
provenance = json.loads(payloads["package/RESOURCES.json"])
if provenance["plugin"]["version"] != version:
    raise RuntimeError("Installer provenance version differs")
for relative in ["index.js", "agents.js", "client.js", "storage-location.js", "runtime-cache.js", "README.md", "cordis.patch.yml"]:
    if packed_files["package/" + relative]["sha256"] != hashlib.sha256((plugin / relative).read_bytes()).hexdigest():
        raise RuntimeError(f"Installer differs from source: {relative}")
for relative, expected in provenance["backend"]["files"].items():
    if packed_files["package/resources/backend/" + relative]["sha256"] != expected or hashlib.sha256((root / relative).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f"Installer backend differs from source: {relative}")
runtime_manifest = json.loads(payloads["package/RUNTIME-MANIFEST.json"])
runtime_names = {entry["path"] for entry in runtime_manifest["files"]}
packed_runtime_names = {name.removeprefix("package/resources/") for name in packed_files if name.startswith("package/resources/")}
if runtime_names != packed_runtime_names:
    raise RuntimeError("Runtime manifest does not cover exactly the published resources")
canonical = json.dumps(runtime_manifest["files"], ensure_ascii=False, separators=(",", ":")).encode()
if hashlib.sha256(canonical).hexdigest() != runtime_manifest["key"]:
    raise RuntimeError("Runtime manifest digest differs")
for entry in runtime_manifest["files"]:
    actual_file = packed_files["package/resources/" + entry["path"]]
    if actual_file["size"] != entry["size"] or actual_file["sha256"] != entry["sha256"]:
        raise RuntimeError(f"Runtime resource integrity mismatch: {entry['path']}")
release = root / "output/releases" / f"v{version}"
release.mkdir(parents=True, exist_ok=True)
versioned_asset = release / installer.name
stable_asset = release / stable_name
shutil.copyfile(installer, versioned_asset)
shutil.copyfile(installer, stable_asset)
prefix = f"dsh-paper-workbench-{version}/"
archive = release / f"dsh-paper-workbench-{version}-sources.tar.gz"
git_tar = subprocess.check_output(["git", "archive", "--format=tar", f"--prefix={prefix}", "HEAD"], cwd=root)
vendor_count = 0


def add(destination, name, data, mode=0o644):
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = 0
    destination.addfile(info, io.BytesIO(data))


with archive.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w") as destination:
    with tarfile.open(fileobj=io.BytesIO(git_tar), mode="r:") as source:
        for entry in source:
            if entry.isfile():
                add(destination, entry.name, source.extractfile(entry).read(), entry.mode)
            elif not entry.isdir():
                raise RuntimeError("Unexpected source archive entry")
    for spec in json.loads((root / "sources.download.json").read_text(encoding="utf-8")):
        for entry in spec["files"]:
            if entry["path"].endswith(".onnx"):
                continue
            relative = Path(spec["destination"]) / entry["path"]
            file = (root / relative).resolve()
            if not file.is_relative_to(root / "third_party"):
                raise RuntimeError("Vendor path escapes source directory")
            data = file.read_bytes()
            if hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest() != entry["sha"]:
                raise RuntimeError(f"Vendor integrity mismatch: {relative}")
            add(destination, prefix + relative.as_posix(), data)
            vendor_count += 1
    source_provenance = {
        "pluginVersion": version, "sourceCommit": head, "vendorFiles": vendor_count,
        "vendorIntegrity": "Git blob SHA-1 verified against sources.download.json",
        "excluded": ["optional ONNX models", "personal documents", "databases", "sessions", "local reports", "node_modules"],
        "buildInstructions": "BUILD.md",
    }
    add(destination, prefix + "SOURCE-PROVENANCE.json", (json.dumps(source_provenance, indent=2) + "\n").encode())
records = [{"name": p.name, "size": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in [stable_asset, versioned_asset, archive]]
(release / "SHA256SUMS.txt").write_text("".join(f"{entry['sha256']}  {entry['name']}\n" for entry in records), encoding="utf-8")
(release / "manifest.json").write_text(json.dumps({"commit": head, "assets": records}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"commit": head, "vendorFiles": vendor_count, "assets": records}, indent=2))
