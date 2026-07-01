import { CAMERA_TIMEZONE, getTimezoneTimeParts } from "./setupStatus.js";

export function getCameraTimePayload(timezone = CAMERA_TIMEZONE, options = {}) {
  const now = getTimezoneTimeParts(timezone);
  return {
    epoch: now.epoch,
    timezoneHours: now.timezoneHours,
    timezoneSec: now.timezoneSec,
    dstSwitch: now.dstSwitch,
    ntpSwitch: Number(options.ntpSwitch ?? 1),
    ntpServer: String(options.ntpServer ?? "192.168.50.1"),
  };
}
