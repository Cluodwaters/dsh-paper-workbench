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
with tarfile.open(installer, "r:gz") as packed:
    actual = json.load(packed.extractfile("package/package.json"))
    if actual != manifest:
        raise RuntimeError("Installer manifest differs from the committed source")
    patch = actual["dsh"]["bundle"]["patch"].removeprefix("./")
    if not packed.getmember("package/" + patch).isfile():
        raise RuntimeError("Installer bundle patch is missing")
    provenance = json.load(packed.extractfile("package/RESOURCES.json"))
    if provenance["plugin"]["version"] != version:
        raise RuntimeError("Installer provenance version differs")
    for relative in ["index.js", "agents.js", "client.js", "storage-location.js", "README.md", "cordis.patch.yml"]:
        if packed.extractfile("package/" + relative).read() != (plugin / relative).read_bytes():
            raise RuntimeError(f"Installer differs from source: {relative}")
    for relative, expected in provenance["backend"]["files"].items():
        data = packed.extractfile("package/resources/backend/" + relative).read()
        if hashlib.sha256(data).hexdigest() != expected or data != (root / relative).read_bytes():
            raise RuntimeError(f"Installer backend differs from source: {relative}")
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
