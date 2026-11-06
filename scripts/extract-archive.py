"""Extract a GitHub source archive within this project's third_party tree."""
import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path, PurePosixPath

sys.stdout.reconfigure(encoding="utf-8")
parser = argparse.ArgumentParser()
parser.add_argument("archive", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
project = Path(__file__).resolve().parents[1]
destination = args.destination.resolve()
if not destination.is_relative_to(project / "third_party"):
    raise ValueError("Destination must be inside this project's third_party directory")
with zipfile.ZipFile(args.archive) as archive:
    count = 0
    for member in archive.infolist():
        parts = PurePosixPath(member.filename).parts[1:]
        if not parts or member.is_dir():
            continue
        if any(part in ("..", ".git") for part in parts):
            raise ValueError("Unsafe archive member")
        target = destination.joinpath(*parts).resolve()
        if not target.is_relative_to(destination):
            raise ValueError("Archive path escaped destination")
        target.parent.mkdir(parents=True, exist_ok=True)
        data = archive.read(member)
        if target.exists() and target.read_bytes() != data:
            raise ValueError(f"Refusing to overwrite differing existing source: {target}")
        target.write_bytes(data)
        count += 1
print(json.dumps({"destination":str(destination),"files":count,
                  "archiveSHA256":hashlib.sha256(args.archive.read_bytes()).hexdigest()}))
