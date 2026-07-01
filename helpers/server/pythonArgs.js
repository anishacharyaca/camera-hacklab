function appendExtraSetParams(args, cfg) {
  for (const entry of cfg.extraParams) {
    if (Array.isArray(entry) && entry.length === 2 && entry[0]) {
      args.push("--set-param", `${entry[0]}=${entry[1]}`);
    }
  }
}

export function buildStreamPythonArgs(pyScript, cfg) {
  const args = [pyScript, "--out", "-"];
  if (cfg.quality) {
    args.push("--quality", cfg.quality);
  } else {
    args.push("--stream", String(cfg.stream));
  }
  args.push("--did", cfg.did);
  args.push("--user", cfg.user);
  args.push("--pwd", cfg.pwd);
  args.push("--login-time-mode", "omit");
  args.push("--iframe-interval", String(cfg.iframeInterval));
  args.push("--set-param-delay", String(cfg.setParamDelay));
  args.push("--read-chunk", String(cfg.readChunk));
  args.push("--max-read-chunk", String(cfg.maxReadChunk));
  args.push("--read-timeout", String(cfg.readTimeout));
  args.push("--gap-iframe-threshold", String(cfg.gapIframeThreshold));
  if (cfg.noIframe) args.push("--no-iframe");
  if (cfg.noWaitKeyframe) args.push("--no-wait-keyframe");
  if (cfg.checkBuffer) args.push("--check-buffer");
  if (cfg.getDatetime) args.push("--get-datetime");
  if (cfg.syncTimeNow) args.push("--sync-time-now");
  appendExtraSetParams(args, cfg);
  return args;
}

export function buildControlPythonArgs(cfg) {
  const args = ["--apply-only", "--did", cfg.did, "--user", cfg.user, "--pwd", cfg.pwd];
  args.push("--datetime-only", "--set-time-hour", String(cfg.timeHour));
  args.push("--set-param", `video_resolution=${cfg.videoResolution}`);
  args.push("--night-vision-mode", String(cfg.nightVisionMode));
  args.push("--record-video", String(cfg.recordVideo));
  args.push("--wakeup-mode", String(cfg.wakeupMode));
  args.push("--record-sound", String(cfg.recordSound));
  args.push("--record-sound-during-wake-up-period", String(cfg.recordSoundDuringWakeUpPeriod));
  args.push("--loop-coverage", String(cfg.loopCoverage));
  args.push("--sd-card-recording-duration", String(cfg.sdCardRecordingDurationMinutes));
  args.push("--alarm-recording-duration", String(cfg.alarmRecordingDurationSeconds));
  args.push("--alarm-recording-interval", String(cfg.alarmRecordingIntervalSeconds));
  args.push("--timed-record-start", String(cfg.timedRecordStart));
  args.push("--timed-record-end", String(cfg.timedRecordEnd));
  args.push("--timed-record-days", String(cfg.timedRecordDays));
  args.push("--timed-record-enable", String(cfg.timedRecordEnable));
  args.push("--low-power-mode", String(cfg.lowPowerMode));
  args.push("--set-param-delay", String(cfg.setParamDelay));
  if (cfg.getDatetime) args.push("--get-datetime");
  if (cfg.syncTimeNow) args.push("--sync-time-now");
  appendExtraSetParams(args, cfg);
  return args;
}

export function buildFfmpegArgs(cfg) {
  const vf = [`fps=${cfg.previewFps}`];
  if (cfg.previewWidth > 0) {
    vf.push(`scale=${cfg.previewWidth}:-2`);
  }
  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-analyzeduration",
    "0",
    "-probesize",
    "32",
    "-f",
    "hevc",
    "-i",
    "pipe:0",
    "-an",
    "-vf",
    vf.join(","),
    "-q:v",
    String(cfg.previewQuality),
    "-f",
    "mpjpeg",
    "-boundary_tag",
    "homeeye",
    "pipe:1",
  ];
}
