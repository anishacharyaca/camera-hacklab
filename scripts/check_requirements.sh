#!/usr/bin/env bash
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
failures=0

pass() {
  printf 'OK    %s\n' "$1"
}

fail() {
  printf 'FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

check_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "$1: $(command -v "$1")"
  else
    fail "$1 is not installed"
  fi
}

if [[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]]; then
  pass "host architecture: Linux x86_64"
else
  fail "host must be Linux x86_64 (found $(uname -s) $(uname -m))"
fi

for command in node npm python3 ffmpeg ffprobe zip; do
  check_command "${command}"
done

required_files=(
  "server.js"
  "homeeye_live_hevc.py"
  "public/index.html"
  "public/app.js"
  "public/styles.css"
  "public/favicon.svg"
  "helpers/client/setup.js"
  "helpers/client/format.js"
  "helpers/client/configSummary.js"
  "helpers/server/config.js"
  "helpers/server/cameraActions.js"
  "helpers/server/cameraTime.js"
  "helpers/server/pythonArgs.js"
  "helpers/server/setupPersistence.js"
  "helpers/server/setupStatus.js"
  "apk_extract/lib/arm64-v8a/libPPCS_API.so"
  "android_compat_libs/libc.so"
  "android_compat_libs/liblog.so"
  "android_compat_libs/libm.so"
  "android_compat_libs/libdl.so"
  "android_compat_libs/libstdc++.so"
  "setup/reprovision_camera.sh"
)

for relative_path in "${required_files[@]}"; do
  if [[ -e "${PROJECT_DIR}/${relative_path}" ]]; then
    pass "file: ${relative_path}"
  else
    fail "missing file: ${relative_path}"
  fi
done

if command -v node >/dev/null 2>&1 && node --check "${PROJECT_DIR}/server.js" >/dev/null; then
  pass "Node server syntax"
else
  fail "Node server syntax check"
fi

if command -v python3 >/dev/null 2>&1 && PROJECT_DIR="${PROJECT_DIR}" python3 - <<'PY'
import ast
import os
from pathlib import Path

ast.parse((Path(os.environ["PROJECT_DIR"]) / "homeeye_live_hevc.py").read_text())
PY
then
  pass "Python bridge syntax"
else
  fail "Python bridge syntax check"
fi

if command -v ldd >/dev/null 2>&1; then
  if LD_LIBRARY_PATH="${PROJECT_DIR}/android_compat_libs" \
    ldd "${PROJECT_DIR}/apk_extract/lib/arm64-v8a/libPPCS_API.so" 2>&1 |
    grep -q "not found"; then
    fail "native PPCS library has unresolved dependencies"
  else
    pass "native PPCS library dependencies"
  fi
else
  fail "ldd is unavailable; native dependencies could not be checked"
fi

if (( failures > 0 )); then
  printf '\n%d requirement check(s) failed.\n' "${failures}" >&2
  exit 1
fi

printf '\nCamera Hacklab application requirements are present.\n'
printf 'This does not test camera credentials, Wi-Fi reachability, or the hotspot VM.\n'
