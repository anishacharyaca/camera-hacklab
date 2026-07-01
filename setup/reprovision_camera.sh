#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${CAMERA_CONFIG:-${SCRIPT_DIR}/camera.conf}"
CONTROL_SCRIPT="${PROJECT_DIR}/homeeye_live_hevc.py"
export LD_LIBRARY_PATH="${PROJECT_DIR}/android_compat_libs${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

read_cfg() {
  local key="$1"
  local value
  value="$(sed -n "s/^${key}:[[:space:]]*//p" "${CONFIG_FILE}" | head -n 1)"
  if [[ -z "${value}" ]]; then
    echo "Missing config key ${key} in ${CONFIG_FILE}" >&2
    exit 1
  fi
  printf '%s\n' "${value}"
}

confirm() {
  local answer
  while true; do
    read -r -p "$1 [y/n]: " answer
    case "${answer}" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
    esac
  done
}

active_interface_for_ssid() {
  nmcli -t -f ACTIVE,SSID,DEVICE dev wifi 2>/dev/null |
    awk -F: -v target="$1" '$1=="yes" && $2==target {print $3; exit}'
}

camera_ip_from_neighbors() {
  ip neigh show dev "$1" |
    awk -v target="$2" 'tolower($0) ~ tolower(target) {print $1; exit}'
}

ping_sweep() {
  local prefix="$1"
  local start="$2"
  local end="$3"
  seq "${start}" "${end}" |
    xargs -P 24 -I{} bash -c 'ping -c 1 -W 1 "$1.$2" >/dev/null 2>&1 || true' _ "${prefix}" {}
}

camera_command() {
  python3 "${CONTROL_SCRIPT}" \
    --did "${CAMERA_DID}" \
    --user "${CAMERA_USER}" \
    --pwd "${CAMERA_PASSWORD}" \
    "$@"
}

sync_camera_time() {
  local values epoch timezone_hours timezone_sec hour iso
  values="$(python3 - "${CAMERA_TIMEZONE}" <<'PY'
import datetime as dt
import sys
from zoneinfo import ZoneInfo

now = dt.datetime.now(ZoneInfo(sys.argv[1]))
offset = now.utcoffset() or dt.timedelta(0)
print(
    int(now.timestamp()),
    offset.total_seconds() / 3600,
    int(offset.total_seconds()),
    now.hour,
    now.isoformat(),
    sep="|",
)
PY
)"
  IFS="|" read -r epoch timezone_hours timezone_sec hour iso <<<"${values}"
  echo "Synchronizing camera time to ${iso} (${CAMERA_TIMEZONE})..."
  camera_command \
    --set-datetime-auto \
    --set-time-epoch "${epoch}" \
    --set-timezone "${timezone_hours}" \
    --set-timezone-sec "${timezone_sec}" \
    --set-dst-switch 0 \
    --set-time-hour "${hour}" \
    --set-ntp-switch "${NTP_SWITCH}" \
    --set-ntp-server "${NTP_SERVER}" \
    --quiet
}

need_cmd nmcli
need_cmd python3
need_cmd ping
need_cmd ip
need_cmd xargs
need_cmd sed
need_cmd awk
need_cmd seq

[[ -f "${CONFIG_FILE}" ]] || {
  echo "Missing ${CONFIG_FILE}" >&2
  echo "Create it with: cp setup/camera.conf.example setup/camera.conf" >&2
  exit 1
}
[[ -f "${CONTROL_SCRIPT}" ]] || {
  echo "Missing camera bridge: ${CONTROL_SCRIPT}" >&2
  exit 1
}

CAMERA_AP_PREFIX="$(read_cfg CAMERA_AP_PREFIX)"
CAMERA_DID="$(read_cfg CAMERA_DID)"
CAMERA_USER="$(read_cfg CAMERA_USER)"
CAMERA_PASSWORD="$(read_cfg CAMERA_PASSWORD)"
CAMERA_MAC="$(read_cfg CAMERA_MAC)"
CAMERA_TIMEZONE="$(read_cfg CAMERA_TIMEZONE)"
TARGET_SSID="$(read_cfg TARGET_SSID)"
TARGET_PASSWORD="$(read_cfg TARGET_PASSWORD)"
TARGET_ENCRYPTION="$(read_cfg TARGET_ENCRYPTION)"
TARGET_SUBNET_PREFIX="$(read_cfg TARGET_SUBNET_PREFIX)"
TARGET_SCAN_START="$(read_cfg TARGET_SCAN_START)"
TARGET_SCAN_END="$(read_cfg TARGET_SCAN_END)"
NTP_SWITCH="$(read_cfg NTP_SWITCH)"
NTP_SERVER="$(read_cfg NTP_SERVER)"

echo "Camera: ${CAMERA_DID}"
echo "Target Wi-Fi: ${TARGET_SSID}"
echo
nmcli -t -f DEVICE,TYPE,STATE,CONNECTION dev status || true
echo
echo "Stop Camera Hacklab and the vendor app before continuing."
echo "Linux must currently be connected to the camera's ${CAMERA_AP_PREFIX}... hotspot."
if ! confirm "Continue with camera Wi-Fi provisioning?"; then
  echo "Cancelled."
  exit 0
fi

echo
echo "Sending the target Wi-Fi configuration to the camera..."
camera_command \
  --set-wifi-ssid "${TARGET_SSID}" \
  --set-wifi-pwd "${TARGET_PASSWORD}" \
  --set-wifi-encryption "${TARGET_ENCRYPTION}" \
  --quiet

echo
echo "The camera should leave its setup hotspot and join ${TARGET_SSID}."
echo "Connect this Linux host to ${TARGET_SSID}, then continue."
if ! confirm "Is Linux connected to ${TARGET_SSID}?"; then
  echo "Provisioning command was sent; verification was skipped."
  exit 0
fi

TARGET_IFACE="$(active_interface_for_ssid "${TARGET_SSID}")"
if [[ -z "${TARGET_IFACE}" ]]; then
  echo "No active Linux interface was found on ${TARGET_SSID}." >&2
  exit 1
fi

CAMERA_IP=""
for attempt in 1 2 3; do
  echo "Discovery attempt ${attempt}/3 on ${TARGET_SUBNET_PREFIX}.0/24..."
  ping_sweep "${TARGET_SUBNET_PREFIX}" "${TARGET_SCAN_START}" "${TARGET_SCAN_END}"
  CAMERA_IP="$(camera_ip_from_neighbors "${TARGET_IFACE}" "${CAMERA_MAC}")"
  [[ -n "${CAMERA_IP}" ]] && break
  sleep 5
done

if [[ -z "${CAMERA_IP}" ]]; then
  echo "Camera MAC ${CAMERA_MAC} was not found on ${TARGET_SSID}." >&2
  echo "Wait two minutes and retry verification, or reset the camera to restore its AP." >&2
  exit 1
fi

echo "Camera found at ${CAMERA_IP} on ${TARGET_IFACE}."
ping -c 2 -W 1 "${CAMERA_IP}" || true

echo "Verifying the native camera control path..."
camera_command --sd-status --quiet

sync_camera_time

echo "Reading the updated camera clock..."
camera_command --get-datetime-auto --quiet

echo
echo "Success: ${CAMERA_DID} is on ${TARGET_SSID}, camera control works, and time sync was sent."
