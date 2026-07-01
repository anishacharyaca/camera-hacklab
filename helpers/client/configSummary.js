function setupSummaryText(setup) {
  if (!setup) return "Not checked";
  if (setup.status === "refreshing") return "Checking";
  if (setup.status === "error") return "Check failed";
  return setup.needsSetup ? "Needs setup" : "Ready";
}

function boolLabel(value) {
  return value ? "on" : "off";
}

function timeFormatLabel(value) {
  return Number(value) === 0 ? "12 hour" : "24 hour";
}

function qualityLabel(value) {
  return value || "custom";
}

function recordModeLabel(value) {
  return {
    privacy: "Privacy Mode",
    full_day: "Full Day Recording",
    alarm: "Alarm Recording",
    timed: "Timed Recording",
  }[String(value || "")] || String(value || "");
}

function extraParamsLabel(value) {
  if (!Array.isArray(value) || !value.length) return "none";
  return value.map((entry) => entry.join("=")).join(", ");
}

export const CONFIG_ITEMS = [
  ["did", "DID", (value) => value ?? ""],
  ["quality", "Quality", qualityLabel],
  ["stream", "Stream ID", String],
  ["videoResolution", "Video resolution", String],
  ["timeHour", "Clock display", timeFormatLabel],
  ["nightVisionMode", "Night vision", String],
  ["recordVideo", "Recording", String],
  ["wakeupMode", "Wake up mode", String],
  ["recordMode", "Recording mode", recordModeLabel],
  ["recordSound", "Record sound", boolLabel],
  ["recordSoundDuringWakeUpPeriod", "Wake-up sound", boolLabel],
  ["loopCoverage", "Loop coverage", boolLabel],
  ["sdCardRecordingDurationMinutes", "SD duration", String],
  ["alarmRecordingDurationSeconds", "Alarm duration", String],
  ["alarmRecordingIntervalSeconds", "Alarm interval", String],
  ["timedRecordStart", "Timed start", (value) => value ?? ""],
  ["timedRecordEnd", "Timed end", (value) => value ?? ""],
  ["timedRecordDays", "Timed days", (value) => value ?? ""],
  ["lowPowerMode", "Low power mode", String],
  ["iframeInterval", "I-frame interval", String],
  ["gapIframeThreshold", "Gap threshold", String],
  ["readTimeout", "Read timeout", String],
  ["previewFps", "Preview FPS", String],
  ["previewWidth", "Preview width", String],
  ["noIframe", "No I-frame", boolLabel],
  ["noWaitKeyframe", "Wait keyframe", (value) => boolLabel(!value)],
  ["checkBuffer", "Check PPCS buffer", boolLabel],
  ["getDatetime", "Get datetime", boolLabel],
  ["syncTimeNow", "Sync time now", boolLabel],
  ["previewTimeWatch", "Auto time fix", boolLabel],
  ["extraParams", "Extra params", extraParamsLabel],
];

function renderSummaryItems(items) {
  return items
    .map(
      ([label, value]) => `
        <div class="config-summary-item">
          <span class="config-summary-label">${label}</span>
          <strong class="config-summary-value">${String(value)}</strong>
        </div>
      `,
    )
    .join("");
}

function normalizeComparableValue(key, value) {
  if (key === "extraParams") {
    return JSON.stringify(Array.isArray(value) ? value : []);
  }
  return String(value);
}

export function renderConfigSummary(config, setup) {
  if (!config) {
    return '<div class="config-summary-empty">No camera configuration loaded yet.</div>';
  }

  const items = [
    ["Time check", setupSummaryText(setup)],
    ...CONFIG_ITEMS.map(([key, label, formatter]) => [label, formatter(config[key])]),
  ];

  return renderSummaryItems(items);
}

export function getPendingConfigItems(currentConfig, appliedConfig) {
  if (!appliedConfig) return [];
  return CONFIG_ITEMS
    .filter(([key]) => normalizeComparableValue(key, currentConfig?.[key]) !== normalizeComparableValue(key, appliedConfig?.[key]))
    .map(([key, label, formatter]) => ({ key, label, value: formatter(currentConfig?.[key]) }));
}

export function renderPendingConfigSummary(currentConfig, appliedConfig) {
  const pendingItems = getPendingConfigItems(currentConfig, appliedConfig);

  if (!appliedConfig) {
    return '<div class="config-summary-empty">Waiting for applied camera settings.</div>';
  }
  if (!pendingItems.length) {
    return '<div class="config-summary-empty">All editable options already match the applied camera settings.</div>';
  }

  return renderSummaryItems(pendingItems.map(({ label, value }) => [label, value]));
}
