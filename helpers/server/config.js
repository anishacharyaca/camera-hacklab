export const DEFAULTS = {
  did: "",
  user: "admin",
  pwd: "",
  timezone: "America/Toronto",
  ntpSwitch: 1,
  ntpServer: "192.168.50.1",
  quality: "hd",
  stream: 2,
  lowPowerMode: 2,
  videoResolution: 3,
  timeHour: 0,
  nightVisionMode: 0,
  recordVideo: 1,
  wakeupMode: 0,
  recordMode: "full_day",
  recordSound: 1,
  recordSoundDuringWakeUpPeriod: 0,
  loopCoverage: 0,
  sdCardRecordingDurationMinutes: 10,
  alarmRecordingDurationSeconds: 6,
  alarmRecordingIntervalSeconds: 30,
  timedRecordStart: "00:00",
  timedRecordEnd: "23:59",
  timedRecordDays: "1111111",
  timedRecordEnable: 1,
  iframeInterval: 1,
  noIframe: false,
  noWaitKeyframe: false,
  gapIframeThreshold: 20,
  checkBuffer: false,
  readChunk: 65536,
  maxReadChunk: 2097152,
  readTimeout: 1000,
  setParamDelay: 1,
  previewFps: 8,
  previewWidth: 960,
  previewQuality: 6,
  getDatetime: false,
  syncTimeNow: false,
  previewTimeWatch: false,
  extraParams: [],
};

export function toBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

export function normalizeConfig(input) {
  const cfg = { ...DEFAULTS, ...input };
  cfg.did = String(cfg.did || DEFAULTS.did);
  cfg.user = String(cfg.user || DEFAULTS.user);
  cfg.pwd = String(cfg.pwd || DEFAULTS.pwd);
  cfg.timezone = String(cfg.timezone || DEFAULTS.timezone);
  cfg.ntpSwitch = Number(cfg.ntpSwitch ?? DEFAULTS.ntpSwitch);
  cfg.ntpServer = String(cfg.ntpServer ?? DEFAULTS.ntpServer);
  cfg.quality = String(cfg.quality || "");
  cfg.stream = Number(cfg.stream ?? DEFAULTS.stream);
  cfg.lowPowerMode = Number(cfg.lowPowerMode ?? DEFAULTS.lowPowerMode);
  cfg.videoResolution = Number(cfg.videoResolution ?? DEFAULTS.videoResolution);
  cfg.timeHour = Number(cfg.timeHour ?? DEFAULTS.timeHour);
  cfg.nightVisionMode = Number(cfg.nightVisionMode ?? DEFAULTS.nightVisionMode);
  cfg.recordVideo = Number(cfg.recordVideo ?? DEFAULTS.recordVideo);
  cfg.wakeupMode = Number(cfg.wakeupMode ?? DEFAULTS.wakeupMode);
  cfg.recordMode = String(cfg.recordMode || DEFAULTS.recordMode);
  cfg.recordSound = Number(cfg.recordSound ?? DEFAULTS.recordSound);
  cfg.recordSoundDuringWakeUpPeriod = Number(cfg.recordSoundDuringWakeUpPeriod ?? DEFAULTS.recordSoundDuringWakeUpPeriod);
  cfg.loopCoverage = Number(cfg.loopCoverage ?? DEFAULTS.loopCoverage);
  cfg.sdCardRecordingDurationMinutes = Number(cfg.sdCardRecordingDurationMinutes ?? DEFAULTS.sdCardRecordingDurationMinutes);
  cfg.alarmRecordingDurationSeconds = Number(cfg.alarmRecordingDurationSeconds ?? DEFAULTS.alarmRecordingDurationSeconds);
  cfg.alarmRecordingIntervalSeconds = Number(cfg.alarmRecordingIntervalSeconds ?? DEFAULTS.alarmRecordingIntervalSeconds);
  cfg.timedRecordStart = String(cfg.timedRecordStart || DEFAULTS.timedRecordStart);
  cfg.timedRecordEnd = String(cfg.timedRecordEnd || DEFAULTS.timedRecordEnd);
  cfg.timedRecordDays = String(cfg.timedRecordDays || DEFAULTS.timedRecordDays);
  cfg.timedRecordEnable = Number(cfg.timedRecordEnable ?? DEFAULTS.timedRecordEnable);
  cfg.iframeInterval = Number(cfg.iframeInterval ?? DEFAULTS.iframeInterval);
  cfg.gapIframeThreshold = Number(cfg.gapIframeThreshold ?? DEFAULTS.gapIframeThreshold);
  cfg.readChunk = Number(cfg.readChunk ?? DEFAULTS.readChunk);
  cfg.maxReadChunk = Number(cfg.maxReadChunk ?? DEFAULTS.maxReadChunk);
  cfg.readTimeout = Number(cfg.readTimeout ?? DEFAULTS.readTimeout);
  cfg.setParamDelay = Number(cfg.setParamDelay ?? DEFAULTS.setParamDelay);
  cfg.previewFps = Number(cfg.previewFps ?? DEFAULTS.previewFps);
  cfg.previewWidth = Number(cfg.previewWidth ?? DEFAULTS.previewWidth);
  cfg.previewQuality = Number(cfg.previewQuality ?? DEFAULTS.previewQuality);
  cfg.noIframe = toBool(cfg.noIframe);
  cfg.noWaitKeyframe = toBool(cfg.noWaitKeyframe);
  cfg.checkBuffer = toBool(cfg.checkBuffer);
  cfg.getDatetime = toBool(cfg.getDatetime);
  cfg.syncTimeNow = toBool(cfg.syncTimeNow);
  cfg.previewTimeWatch = toBool(cfg.previewTimeWatch);
  cfg.extraParams = Array.isArray(cfg.extraParams) ? cfg.extraParams : [];
  return cfg;
}
