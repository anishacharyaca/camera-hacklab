import { getCurrentTime } from "../getCurrentTime.js";

export const CAMERA_TIMEZONE = "America/Toronto";
export const MIN_VALID_CAMERA_EPOCH = 1577836800;
export const MAX_TIME_DRIFT_SECONDS = 300;

export function getTimezoneTimeParts(timezone = CAMERA_TIMEZONE) {
  const { epochMs } = getCurrentTime();
  const now = new Date(epochMs);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const offsetLabel = parts.timeZoneName || "GMT+0";
  const match = offsetLabel.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  let offsetSec = 0;
  if (match) {
    const sign = match[1] === "-" ? -1 : 1;
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    offsetSec = sign * ((hours * 60 * 60) + (minutes * 60));
  }
  return {
    epoch: Math.floor(now.getTime() / 1000),
    year: Number(parts.year || now.getFullYear()),
    timezoneSec: offsetSec,
    timezoneHours: offsetSec / 3600,
    // This firmware already expects the active timezone offset to include DST.
    // Sending dstSwitch=1 makes the camera UI add another hour on top.
    dstSwitch: 0,
    iso: now.toLocaleString("sv-SE", { timeZone: timezone }).replace(" ", "T"),
  };
}

export function parseQueryJson(stdout) {
  const text = String(stdout || "").trim();
  try {
    return JSON.parse(text || "{}");
  } catch {
    // Some camera control replies prepend binary/control text before the JSON.
    // Prefer the last complete object because the useful payload is emitted last.
    for (let end = text.lastIndexOf("}"); end >= 0; end = text.lastIndexOf("}", end - 1)) {
      for (let start = text.lastIndexOf("{", end); start >= 0; start = text.lastIndexOf("{", start - 1)) {
        try {
          return JSON.parse(text.slice(start, end + 1));
        } catch {}
      }
    }
  }
  return null;
}

export function evaluateSetupFromDatetime(payload, timezone = CAMERA_TIMEZONE) {
  const now = getTimezoneTimeParts(timezone);
  const camera = payload?.json && typeof payload.json === "object" ? payload.json : (payload || {});
  const cameraTime = Number(camera.time);
  const cameraTimezoneSec = Number(camera.timeZone_Sec);
  const cameraDstSwitch = Number(camera.dstSwitch);
  const timeDeltaSeconds = Number.isFinite(cameraTime) ? Math.abs(now.epoch - cameraTime) : NaN;
  const cameraYear = Number.isFinite(cameraTime)
    ? Number(new Date(cameraTime * 1000).toLocaleString("en-US", {
      timeZone: timezone,
      year: "numeric",
    }))
    : NaN;
  if (!Number.isFinite(cameraTime) || cameraTime < MIN_VALID_CAMERA_EPOCH) {
    return {
      needsSetup: true,
      reason: "missing_time",
      summary: Number.isFinite(cameraYear)
        ? `Camera reports year ${cameraYear}, which is not valid.`
        : "Camera did not return a valid stored year.",
      cameraTime,
      cameraTimezoneSec,
      cameraDstSwitch,
      timeDeltaSeconds,
      cameraYear,
      targetYear: now.year,
      targetTimezoneSec: now.timezoneSec,
      targetDstSwitch: now.dstSwitch,
    };
  }
  const checks = {
    yearOk: cameraYear === now.year,
    timeOk: Number.isFinite(timeDeltaSeconds) && timeDeltaSeconds <= MAX_TIME_DRIFT_SECONDS,
    timezoneOk: cameraTimezoneSec === now.timezoneSec,
    dstOk: cameraDstSwitch === now.dstSwitch,
  };
  if (checks.yearOk && checks.timeOk && checks.timezoneOk && checks.dstOk) {
    return {
      needsSetup: false,
      reason: "ready",
      summary: `Camera time matches ${timezone}.`,
      cameraTime,
      cameraTimezoneSec,
      cameraDstSwitch,
      timeDeltaSeconds,
      cameraYear,
      targetYear: now.year,
      targetTimezoneSec: now.timezoneSec,
      targetDstSwitch: now.dstSwitch,
      checks,
    };
  }
  const failed = [];
  if (!checks.yearOk) failed.push("year");
  if (!checks.timeOk) failed.push("clock");
  if (!checks.timezoneOk) failed.push("timezone");
  if (!checks.dstOk) failed.push("DST");
  return {
    needsSetup: true,
    reason: "time_mismatch",
    summary: `Camera ${failed.join(", ")} setting${failed.length === 1 ? " is" : "s are"} not aligned with ${timezone}.`,
    cameraTime,
    cameraTimezoneSec,
    cameraDstSwitch,
    timeDeltaSeconds,
    cameraYear,
    targetYear: now.year,
    targetTimezoneSec: now.timezoneSec,
    targetDstSwitch: now.dstSwitch,
    checks,
  };
}
