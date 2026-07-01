import { CAMERA_TIMEZONE } from "./setupStatus.js";
import { getCameraTimePayload } from "./cameraTime.js";

function credsArgs(cfg) {
  return ["--did", cfg.did, "--user", cfg.user, "--pwd", cfg.pwd];
}

function buildTimeSyncFields(cfg) {
  const now = getCameraTimePayload(cfg.timezone || CAMERA_TIMEZONE, {
    ntpSwitch: cfg.ntpSwitch,
    ntpServer: cfg.ntpServer,
  });
  return now;
}

export function buildTimeSyncActionGroups(cfg) {
  const timePayload = buildTimeSyncFields(cfg);
  return [
    [
      "--quiet",
      "--datetime-only",
      "--set-datetime-auto",
      "--set-time-epoch",
      String(timePayload.epoch),
      "--set-timezone",
      String(timePayload.timezoneHours),
      "--set-timezone-sec",
      String(timePayload.timezoneSec),
      "--set-dst-switch",
      String(timePayload.dstSwitch),
      "--set-time-hour",
      String(cfg.timeHour),
      "--set-ntp-switch",
      String(timePayload.ntpSwitch),
      ...(timePayload.ntpServer ? ["--set-ntp-server", timePayload.ntpServer] : []),
      ...credsArgs(cfg),
    ],
  ];
}

export function buildSetupActionGroups(cfg, { syncTimeNow = true } = {}) {
  const groups = [];

  if (syncTimeNow) {
    groups.push(...buildTimeSyncActionGroups(cfg));
  }

  groups.push([
    "--quiet",
    "--datetime-only",
    "--set-time-hour",
    String(cfg.timeHour),
    ...credsArgs(cfg),
  ]);
  groups.push([
    "--quiet",
    "--apply-only",
    "--set-param",
    `video_resolution=${cfg.videoResolution}`,
    ...credsArgs(cfg),
  ]);
  groups.push([
    "--quiet",
    "--apply-only",
    "--night-vision-mode",
    String(cfg.nightVisionMode),
    ...credsArgs(cfg),
  ]);
  groups.push([
    "--quiet",
    "--apply-only",
    "--record-mode",
    String(cfg.recordMode),
    ...credsArgs(cfg),
  ]);
  groups.push([
    "--quiet",
    "--apply-only",
    "--record-video",
    String(cfg.recordVideo),
    "--wakeup-mode",
    String(cfg.wakeupMode),
    "--record-sound",
    String(cfg.recordSound),
    "--record-sound-during-wake-up-period",
    String(cfg.recordSoundDuringWakeUpPeriod),
    "--loop-coverage",
    String(cfg.loopCoverage),
    "--sd-card-recording-duration",
    String(cfg.sdCardRecordingDurationMinutes),
    "--alarm-recording-duration",
    String(cfg.alarmRecordingDurationSeconds),
    "--alarm-recording-interval",
    String(cfg.alarmRecordingIntervalSeconds),
    "--timed-record-start",
    String(cfg.timedRecordStart),
    "--timed-record-end",
    String(cfg.timedRecordEnd),
    "--timed-record-days",
    String(cfg.timedRecordDays),
    "--timed-record-enable",
    String(cfg.timedRecordEnable),
    ...credsArgs(cfg),
  ]);
  groups.push([
    "--quiet",
    "--apply-only",
    "--low-power-mode",
    String(cfg.lowPowerMode),
    ...credsArgs(cfg),
  ]);

  for (const entry of cfg.extraParams || []) {
    if (Array.isArray(entry) && entry.length === 2 && entry[0]) {
      groups.push([
        "--quiet",
        "--apply-only",
        "--set-param",
        `${entry[0]}=${entry[1]}`,
        ...credsArgs(cfg),
      ]);
    }
  }

  return groups;
}

export function buildControlActionGroups(cfg) {
  const groups = [
    [
      "--quiet",
      "--datetime-only",
      "--set-time-hour",
      String(cfg.timeHour),
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--set-param",
      `video_resolution=${cfg.videoResolution}`,
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--night-vision-mode",
      String(cfg.nightVisionMode),
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--record-video",
      String(cfg.recordVideo),
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--record-mode",
      String(cfg.recordMode),
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--wakeup-mode",
      String(cfg.wakeupMode),
      ...credsArgs(cfg),
    ],
    [
      "--quiet",
      "--apply-only",
      "--low-power-mode",
      String(cfg.lowPowerMode),
      ...credsArgs(cfg),
    ],
  ];

  for (const entry of cfg.extraParams || []) {
    if (Array.isArray(entry) && entry.length === 2 && entry[0]) {
      groups.push([
        "--quiet",
        "--apply-only",
        "--set-param",
        `${entry[0]}=${entry[1]}`,
        ...credsArgs(cfg),
      ]);
    }
  }

  return groups;
}
