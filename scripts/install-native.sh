#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${PROJECT_DIR}/apk_extract/lib/arm64-v8a/libPPCS_API.so"

usage() {
  cat <<'EOF'
Usage:
  scripts/install-native.sh /path/to/vendor.apk-or-zip
  scripts/install-native.sh /path/to/unpacked-directory

Restores the bundled PPCS native library into the expected project path.
EOF
}

if [[ $# -eq 1 && ( "${1:-}" == "-h" || "${1:-}" == "--help" ) ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

source_path="$1"
mkdir -p "$(dirname "${TARGET}")"

if [[ -d "${source_path}" ]]; then
  for candidate in \
    "${source_path}/apk_extract/lib/arm64-v8a/libPPCS_API.so" \
    "${source_path}/lib/arm64-v8a/libPPCS_API.so"; do
    if [[ -f "${candidate}" ]]; then
      cp -f "${candidate}" "${TARGET}"
      chmod 0644 "${TARGET}"
      printf 'Installed %s from directory source\n' "${TARGET}"
      exit 0
    fi
  done

  printf 'Could not find lib/arm64-v8a/libPPCS_API.so under %s\n' "${source_path}" >&2
  exit 1
fi

if [[ ! -f "${source_path}" ]]; then
  printf 'Source file not found: %s\n' "${source_path}" >&2
  exit 1
fi

python3 - "${source_path}" "${TARGET}" <<'PY'
import sys
from pathlib import Path
from zipfile import ZipFile

source = Path(sys.argv[1])
target = Path(sys.argv[2])
entry_names = (
    "apk_extract/lib/arm64-v8a/libPPCS_API.so",
    "lib/arm64-v8a/libPPCS_API.so",
)

with ZipFile(source) as archive:
    for entry_name in entry_names:
        try:
            payload = archive.read(entry_name)
        except KeyError:
            continue
        target.write_bytes(payload)
        target.chmod(0o644)
        print(f"Installed {target} from {source} entry {entry_name}")
        break
    else:
        raise SystemExit(
            "Could not find libPPCS_API.so in the supplied archive. "
            "Expected apk_extract/lib/arm64-v8a/libPPCS_API.so or lib/arm64-v8a/libPPCS_API.so."
        )
PY
