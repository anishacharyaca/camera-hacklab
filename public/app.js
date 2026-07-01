import { fmtBytes, renderList } from "../helpers/client/format.js";
import { CONFIG_ITEMS, renderConfigSummary, getPendingConfigItems, renderPendingConfigSummary } from "../helpers/client/configSummary.js";
import { currentSetupConfig, needsSetupAttention, renderSetupPanel, shouldAutoStartReadyPreview } from "../helpers/client/setup.js";

const state = {
  running: false,
  logs: [],
  filteredLogs: [],
  recordingTask: null,
  formHydrated: false,
  recordingsAutoLoaded: false,
  recordingsPreloaded: false,
  recordingsLoadingPromise: null,
  setupFormOpen: false,
  readyAutoStarted: false,
  setup: null,
  onboarding: null,
  onboardingHydrated: false,
  onboardingCompleteShown: false,
  config: null,
  appliedConfig: null,
  previewRetryTimer: null,
  previewPausedForRecordings: false,
  activeRecordingIndex: -1,
  activeRecordingFile: "",
  lastPlayableTime: 0,
  correctingRecordingSeek: false,
  recordingPointerTime: 0,
  recordingPointerAt: 0,
  recordingCacheTimer: null,
  thumbnailAbortController: null,
  busyHolds: {
    playback: null,
    thumbnails: 0,
  },
  ui: {
    activeWorkspace: "overviewWorkspace",
    busyCount: 0,
    isBusy: false,
    activeOperationLabel: "",
    selectedDay: "",
    recordingsMode: "browse",
    previewState: "idle",
    setupAttention: false,
  },
  sd: {
    status: null,
    days: [],
    files: [],
    groupedFiles: [],
    visibleRows: [],
    dayPage: 0,
    dayPageSize: 12,
    selectedDay: "",
    view: "grid",
  },
};

const els = {
  body: document.body,
  startupGate: document.getElementById("startupGate"),
  startupTitle: document.getElementById("startupTitle"),
  startupMessage: document.getElementById("startupMessage"),
  startupSpinner: document.getElementById("startupSpinner"),
  startupRetryBtn: document.getElementById("startupRetryBtn"),
  leftRail: document.getElementById("leftRail"),
  navToggleBtn: document.getElementById("navToggleBtn"),
  workspaceButtons: Array.from(document.querySelectorAll("[data-workspace-target]")),
  workspaces: Array.from(document.querySelectorAll(".workspace")),
  cameraIdentity: document.getElementById("cameraIdentity"),
  topbarState: document.getElementById("topbarState"),
  cameraBusy: document.getElementById("cameraBusy"),
  cameraBusyText: document.getElementById("cameraBusyText"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  applyBtn: document.getElementById("applyBtn"),
  firstSetupNavBtn: document.getElementById("firstSetupNavBtn"),
  cameraSetupMount: document.getElementById("cameraSetupMount"),
  onboardingMessage: document.getElementById("onboardingMessage"),
  onboardingProgress: document.getElementById("onboardingProgress"),
  onboardingStatus: document.getElementById("onboardingStatus"),
  onboardingCameraForm: document.getElementById("onboardingCameraForm"),
  onboardingWifiForm: document.getElementById("onboardingWifiForm"),
  onboardingSettingsForm: document.getElementById("onboardingSettingsForm"),
  onboardingWifiList: document.getElementById("onboardingWifiList"),
  onboardingDiscoverBtn: document.getElementById("onboardingDiscoverBtn"),
  onboardingBeginBtn: document.getElementById("onboardingBeginBtn"),
  onboardingConnectBtn: document.getElementById("onboardingConnectBtn"),
  onboardingKeepHotspotBtn: document.getElementById("onboardingKeepHotspotBtn"),
  onboardingChooseWifiBtn: document.getElementById("onboardingChooseWifiBtn"),
  onboardingWifiScanBtn: document.getElementById("onboardingWifiScanBtn"),
  onboardingWifiSkipBtn: document.getElementById("onboardingWifiSkipBtn"),
  onboardingWifiApplyBtn: document.getElementById("onboardingWifiApplyBtn"),
  onboardingBackWifiBtn: document.getElementById("onboardingBackWifiBtn"),
  onboardingVerifyBtn: document.getElementById("onboardingVerifyBtn"),
  onboardingCompleteBtn: document.getElementById("onboardingCompleteBtn"),
  onboardingSetupWifiLaterBtn: document.getElementById("onboardingSetupWifiLaterBtn"),
  onboardingOpenDashboardBtn: document.getElementById("onboardingOpenDashboardBtn"),
  onboardingConnectionSummary: document.getElementById("onboardingConnectionSummary"),
  onboardingReconnectText: document.getElementById("onboardingReconnectText"),
  onboardingActiveNetworks: document.getElementById("onboardingActiveNetworks"),
  onboardingPanels: Array.from(document.querySelectorAll("[data-onboarding-panel]")),
  onboardingMarkers: Array.from(document.querySelectorAll("[data-onboarding-marker]")),
  streamImg: document.getElementById("streamImg"),
  previewEmpty: document.getElementById("previewEmpty"),
  statusText: document.getElementById("statusText"),
  statusMeta: document.getElementById("statusMeta"),
  overviewConnectionState: document.getElementById("overviewConnectionState"),
  overviewSetupState: document.getElementById("overviewSetupState"),
  overviewStreamState: document.getElementById("overviewStreamState"),
  controlsAppliedSummary: document.getElementById("controlsAppliedSummary"),
  configSummary: document.getElementById("configSummary"),
  controlsPendingBadge: document.getElementById("controlsPendingBadge"),
  pendingSummary: document.getElementById("pendingSummary"),
  applyStatus: document.getElementById("applyStatus"),
  setupPanel: document.getElementById("setupPanel"),
  setupHeadline: document.getElementById("setupHeadline"),
  setupSummary: document.getElementById("setupSummary"),
  setupTimezone: document.getElementById("setupTimezone"),
  setupOpenBtn: document.getElementById("setupOpenBtn"),
  setupRefreshBtn: document.getElementById("setupRefreshBtn"),
  setupApplyBtn: document.getElementById("setupApplyBtn"),
  setupApplyStatus: document.getElementById("setupApplyStatus"),
  setupForm: document.getElementById("setupForm"),
  setupBottomActions: document.getElementById("setupBottomActions"),
  configForm: document.getElementById("configForm"),
  inputBytes: document.getElementById("inputBytes"),
  outputBytes: document.getElementById("outputBytes"),
  frames: document.getElementById("frames"),
  missing: document.getElementById("missing"),
  dropRate: document.getElementById("dropRate"),
  maxGap: document.getElementById("maxGap"),
  waitingKeyframe: document.getElementById("waitingKeyframe"),
  prependedConfig: document.getElementById("prependedConfig"),
  diagnosticsSdStatusBtn: document.getElementById("diagnosticsSdStatusBtn"),
  diagnosticsReloadDatesBtn: document.getElementById("diagnosticsReloadDatesBtn"),
  clearLogsBtn: document.getElementById("clearLogsBtn"),
  logFilterInput: document.getElementById("logFilterInput"),
  logPresetBtn: document.getElementById("logPresetBtn"),
  logBox: document.getElementById("logBox"),
  sdStatusBtn: document.getElementById("sdStatusBtn"),
  sdDaysBtn: document.getElementById("sdDaysBtn"),
  sdFilesBtn: document.getElementById("sdFilesBtn"),
  sdStatus: document.getElementById("sdStatus"),
  sdYear: document.getElementById("sdYear"),
  sdDate: document.getElementById("sdDate"),
  sdDays: document.getElementById("sdDays"),
  recordingOpenDayBtn: document.getElementById("recordingOpenDayBtn"),
  sdFiles: document.getElementById("sdFiles"),
  recordingsHeading: document.getElementById("recordingsHeading"),
  recordingsModeDayBtn: document.getElementById("recordingsModeDayBtn"),
  recordingsModeBrowseBtn: document.getElementById("recordingsModeBrowseBtn"),
  recordingPlayer: document.getElementById("recordingPlayer"),
  recordingPlayerStatus: document.getElementById("recordingPlayerStatus"),
  recordingModal: document.getElementById("recordingModal"),
  recordingModalTitle: document.getElementById("recordingModalTitle"),
  recordingDownloadBtn: document.getElementById("recordingDownloadBtn"),
  recordingNextModalBtn: document.getElementById("recordingNextModalBtn"),
  recordingSort: document.getElementById("recordingSort"),
  recordingTimeFilter: document.getElementById("recordingTimeFilter"),
  recordingPrevBtn: document.getElementById("recordingPrevBtn"),
  recordingNextBtn: document.getElementById("recordingNextBtn"),
  recordingPageInfo: document.getElementById("recordingPageInfo"),
  recordingViewToggleBtn: document.getElementById("recordingViewToggleBtn"),
  recordingThumbSize: document.getElementById("recordingThumbSize"),
  recordingDownloadFormat: document.getElementById("recordingDownloadFormat"),
  recordingTransferProgress: document.getElementById("recordingTransferProgress"),
  recordingDownloadAllBtn: document.getElementById("recordingDownloadAllBtn"),
  recordingDeleteAllBtn: document.getElementById("recordingDeleteAllBtn"),
};

els.cameraSetupMount.appendChild(els.setupPanel);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[ch]));
}

function displayYmd(value) {
  return String(value || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
}

function cameraYmd(value) {
  return String(value || "").trim().replace(/-/g, "");
}

function sortRecordingDays(days) {
  return [...new Set((days || []).map((day) => cameraYmd(day)).filter((day) => {
    if (!/^\d{8}$/.test(day)) return false;
    const year = Number(day.slice(0, 4));
    const month = Number(day.slice(4, 6));
    const date = Number(day.slice(6, 8));
    return year >= 2000 && year <= 2200 && month >= 1 && month <= 12 && date >= 1 && date <= 31;
  }))].sort((a, b) => Number(b) - Number(a));
}

function currentConfig() {
  const form = new FormData(els.configForm);
  return {
    did: form.get("did"),
    user: form.get("user"),
    pwd: form.get("pwd"),
    quality: form.get("quality"),
    stream: Number(form.get("stream")),
    videoResolution: Number(form.get("videoResolution")),
    timeHour: Number(form.get("timeHour")),
    nightVisionMode: Number(form.get("nightVisionMode")),
    recordVideo: Number(form.get("recordVideo")),
    recordMode: form.get("recordMode"),
    recordSound: Number(form.get("recordSound")),
    recordSoundDuringWakeUpPeriod: Number(form.get("recordSoundDuringWakeUpPeriod")),
    loopCoverage: Number(form.get("loopCoverage")),
    sdCardRecordingDurationMinutes: Number(form.get("sdCardRecordingDurationMinutes")),
    alarmRecordingDurationSeconds: Number(form.get("alarmRecordingDurationSeconds")),
    alarmRecordingIntervalSeconds: Number(form.get("alarmRecordingIntervalSeconds")),
    wakeupMode: Number(form.get("wakeupMode")),
    timedRecordStart: form.get("timedRecordStart"),
    timedRecordEnd: form.get("timedRecordEnd"),
    timedRecordDays: form.get("timedRecordDays"),
    timedRecordEnable: Number(form.get("timedRecordEnable")),
    lowPowerMode: Number(form.get("lowPowerMode")),
    iframeInterval: Number(form.get("iframeInterval")),
    gapIframeThreshold: Number(form.get("gapIframeThreshold")),
    setParamDelay: Number(form.get("setParamDelay")),
    readChunk: Number(form.get("readChunk")),
    maxReadChunk: Number(form.get("maxReadChunk")),
    readTimeout: Number(form.get("readTimeout")),
    previewFps: Number(form.get("previewFps")),
    previewWidth: Number(form.get("previewWidth")),
    previewQuality: Number(form.get("previewQuality")),
    noIframe: form.get("noIframe") === "on",
    noWaitKeyframe: form.get("noWaitKeyframe") === "on",
    checkBuffer: form.get("checkBuffer") === "on",
    getDatetime: form.get("getDatetime") === "on",
    syncTimeNow: form.get("syncTimeNow") === "on",
    previewTimeWatch: form.get("previewTimeWatch") === "on",
    extraParams: String(form.get("extraParams") || ""),
  };
}

function setFormValue(name, value) {
  const el = els.configForm.elements.namedItem(name);
  if (!el) return;
  if (el.type === "checkbox") {
    el.checked = Boolean(value);
    return;
  }
  el.value = String(value);
}

function applyConfigToForm(config) {
  if (!config) return;
  setFormValue("did", config.did ?? "");
  setFormValue("user", config.user ?? "");
  setFormValue("pwd", config.pwd ?? "");
  setFormValue("quality", config.quality ?? "hd");
  setFormValue("stream", config.stream ?? 2);
  setFormValue("videoResolution", config.videoResolution ?? 3);
  setFormValue("timeHour", config.timeHour ?? 0);
  setFormValue("nightVisionMode", config.nightVisionMode ?? 0);
  setFormValue("recordVideo", config.recordVideo ?? 1);
  setFormValue("recordMode", config.recordMode ?? "full_day");
  setFormValue("recordSound", config.recordSound ?? 1);
  setFormValue("recordSoundDuringWakeUpPeriod", config.recordSoundDuringWakeUpPeriod ?? 0);
  setFormValue("loopCoverage", config.loopCoverage ?? 0);
  setFormValue("sdCardRecordingDurationMinutes", config.sdCardRecordingDurationMinutes ?? 10);
  setFormValue("alarmRecordingDurationSeconds", config.alarmRecordingDurationSeconds ?? 6);
  setFormValue("alarmRecordingIntervalSeconds", config.alarmRecordingIntervalSeconds ?? 30);
  setFormValue("wakeupMode", config.wakeupMode ?? 0);
  setFormValue("timedRecordStart", config.timedRecordStart ?? "00:00");
  setFormValue("timedRecordEnd", config.timedRecordEnd ?? "23:59");
  setFormValue("timedRecordDays", config.timedRecordDays ?? "1111111");
  setFormValue("timedRecordEnable", config.timedRecordEnable ?? 1);
  setFormValue("lowPowerMode", config.lowPowerMode ?? 2);
  setFormValue("iframeInterval", config.iframeInterval ?? 1);
  setFormValue("gapIframeThreshold", config.gapIframeThreshold ?? 20);
  setFormValue("setParamDelay", config.setParamDelay ?? 1);
  setFormValue("readChunk", config.readChunk ?? 65536);
  setFormValue("maxReadChunk", config.maxReadChunk ?? 2097152);
  setFormValue("readTimeout", config.readTimeout ?? 1000);
  setFormValue("previewFps", config.previewFps ?? 8);
  setFormValue("previewWidth", config.previewWidth ?? 960);
  setFormValue("previewQuality", config.previewQuality ?? 6);
  setFormValue("noIframe", config.noIframe ?? false);
  setFormValue("noWaitKeyframe", config.noWaitKeyframe ?? false);
  setFormValue("checkBuffer", config.checkBuffer ?? false);
  setFormValue("getDatetime", config.getDatetime ?? false);
  setFormValue("syncTimeNow", config.syncTimeNow ?? false);
  setFormValue("previewTimeWatch", config.previewTimeWatch ?? false);
  setFormValue("extraParams", Array.isArray(config.extraParams) ? config.extraParams.map((entry) => entry.join("=")).join("\n") : "");
}

function setBusy(active, label = "Camera busy") {
  state.ui.busyCount = Math.max(0, state.ui.busyCount + (active ? 1 : -1));
  if (active) {
    state.ui.activeOperationLabel = label;
  }
  state.ui.isBusy = state.ui.busyCount > 0;
  if (!state.ui.isBusy) {
    state.ui.activeOperationLabel = "";
  }
  els.cameraBusy.classList.toggle("active", state.ui.isBusy);
  els.cameraBusyText.textContent = state.ui.isBusy ? state.ui.activeOperationLabel || "Camera busy" : "Camera busy";
}

function setBusyLabel(label) {
  if (!state.ui.isBusy) return;
  state.ui.activeOperationLabel = label;
  els.cameraBusyText.textContent = label;
}

function holdBusy(key, label) {
  if (state.busyHolds[key]) return;
  state.busyHolds[key] = true;
  setBusy(true, label);
}

function releaseBusy(key, label = "Camera busy") {
  if (!state.busyHolds[key]) return;
  state.busyHolds[key] = null;
  setBusy(false, label);
}

function renderWorkspace() {
  for (const button of els.workspaceButtons) {
    button.classList.toggle("is-active", button.dataset.workspaceTarget === state.ui.activeWorkspace);
  }
  for (const workspace of els.workspaces) {
    workspace.classList.toggle("is-active", workspace.id === state.ui.activeWorkspace);
  }
  els.body.classList.toggle("rail-open", Boolean(els.leftRail?.classList.contains("is-open")));
}

function setActiveWorkspace(workspaceId) {
  if (state.onboarding?.required && workspaceId !== "firstSetupWorkspace") return;
  if (state.ui.activeWorkspace === "recordingsWorkspace" && workspaceId !== "recordingsWorkspace") {
    state.thumbnailAbortController?.abort();
    state.thumbnailAbortController = null;
  }
  state.ui.activeWorkspace = workspaceId;
  renderWorkspace();
  els.leftRail.classList.remove("is-open");
  if (workspaceId === "recordingsWorkspace") {
    ensureRecordingsLoaded().catch((err) => {
      els.sdStatus.textContent = `Could not load recordings: ${err.message}`;
    });
  } else if (workspaceId === "overviewWorkspace" && state.previewPausedForRecordings && !state.running) {
    state.previewPausedForRecordings = false;
    setBusy(true, "Restarting preview");
    sleep(3000)
      .then(() => post("/api/start", buildStartPayload()))
      .then(() => loadState())
      .catch((err) => {
        els.statusMeta.textContent = `Preview restart failed: ${err.message}`;
      })
      .finally(() => setBusy(false, "Restarting preview"));
  }
}

function updateTopbar() {
  const setupState = state.ui.setupAttention ? "Setup needed" : "Ready";
  els.topbarState.textContent = state.running ? "Preview live" : state.ui.setupAttention ? "Setup needed" : "Idle";
  els.overviewConnectionState.textContent = state.running ? "Running" : "Idle";
  els.overviewSetupState.textContent = setupState;
  const streamText = state.config ? `${state.config.quality || "custom"} / ${state.config.stream ?? "?"}` : "Unknown";
  els.overviewStreamState.textContent = streamText.toUpperCase();
  els.startBtn.hidden = state.running || Boolean(state.onboarding?.required);
  els.stopBtn.hidden = !state.running || Boolean(state.onboarding?.required);
  els.startBtn.disabled = state.running;
  els.stopBtn.disabled = !state.running;
}

function filterLogs() {
  const query = String(els.logFilterInput.value || "").trim().toLowerCase();
  state.filteredLogs = query
    ? state.logs.filter((item) => String(item.line || "").toLowerCase().includes(query))
    : state.logs;
  const visible = state.filteredLogs.slice(-300);
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  els.logBox.textContent = visible.map((item) => `[${timeFormatter.format(new Date(item.ts))}] ${item.line}`).join("\n");
  els.logBox.scrollTop = els.logBox.scrollHeight;
}

function clearPreviewRetry() {
  if (state.previewRetryTimer) {
    clearTimeout(state.previewRetryTimer);
    state.previewRetryTimer = null;
  }
}

function schedulePreviewRetry() {
  if (!state.running || state.previewRetryTimer) return;
  state.previewRetryTimer = setTimeout(() => {
    state.previewRetryTimer = null;
    if (!state.running) return;
    els.streamImg.dataset.loading = "1";
    els.streamImg.src = `/stream.mjpg?ts=${Date.now()}`;
  }, 1500);
}

function renderDirtyConfigFields(pendingItems) {
  const dirtyKeys = new Set(pendingItems.map((item) => item.key));
  for (const [key] of CONFIG_ITEMS) {
    const field = els.configForm.elements.namedItem(key);
    if (!field) continue;
    const label = field.closest("label");
    if (!label) continue;
    label.classList.toggle("is-dirty", dirtyKeys.has(key));
  }
}

function renderConfigState() {
  const appliedConfig = state.appliedConfig || state.config;
  const pendingItems = getPendingConfigItems(currentConfig(), appliedConfig);
  const appliedMarkup = renderConfigSummary(appliedConfig, state.setup);
  els.configSummary.innerHTML = appliedMarkup;
  els.controlsAppliedSummary.innerHTML = appliedMarkup;
  els.controlsPendingBadge.textContent = pendingItems.length ? `${pendingItems.length} pending change${pendingItems.length === 1 ? "" : "s"}` : "No pending changes";
  els.controlsPendingBadge.classList.toggle("has-pending", pendingItems.length > 0);
  els.pendingSummary.innerHTML = renderPendingConfigSummary(currentConfig(), appliedConfig);
  renderDirtyConfigFields(pendingItems);
}

function setDashboardMode(setup) {
  state.ui.setupAttention = needsSetupAttention(setup);
  els.body.classList.toggle("dashboard-setup-mode", state.ui.setupAttention);
}

const ONBOARDING_STEPS = ["welcome", "camera_details", "wifi", "reconnect", "camera_settings"];

function visibleOnboardingStep(step) {
  return {
    discovering: "welcome",
    connecting: "camera_details",
    camera_connected: "network_choice",
    wifi_scanning: "wifi",
    wifi_handoff: "wifi",
    verifying: "reconnect",
  }[step] || step || "welcome";
}

function onboardingStepIndex(step) {
  return {
    welcome: 0,
    camera_details: 1,
    network_choice: 2,
    wifi: 2,
    reconnect: 3,
    camera_settings: 4,
    complete: 5,
  }[step] ?? 0;
}

function setOnboardingFormValue(form, name, value) {
  const field = form?.elements.namedItem(name);
  if (field && value !== undefined && value !== null) field.value = String(value);
}

function hydrateOnboarding(config) {
  if (state.onboardingHydrated || !config) return;
  for (const name of ["did", "user", "pwd", "timezone", "ntpServer", "ntpSwitch"]) {
    setOnboardingFormValue(els.onboardingCameraForm, name, config[name]);
  }
  for (const name of [
    "quality", "videoResolution", "nightVisionMode", "recordVideo", "recordMode",
    "recordSound", "loopCoverage", "sdCardRecordingDurationMinutes", "wakeupMode", "lowPowerMode",
  ]) {
    setOnboardingFormValue(els.onboardingSettingsForm, name, config[name]);
  }
  state.onboardingHydrated = true;
}

function renderOnboarding(onboarding = state.onboarding) {
  if (!onboarding) return;
  const required = Boolean(onboarding.required);
  const rawStep = state.onboardingCompleteShown ? "complete" : onboarding.step;
  const step = visibleOnboardingStep(rawStep);
  els.body.classList.toggle("onboarding-required", required);
  els.firstSetupNavBtn.hidden = false;

  if (required || state.onboardingCompleteShown) {
    state.ui.activeWorkspace = "firstSetupWorkspace";
    els.body.classList.remove("startup-checking", "startup-failed");
    renderWorkspace();
  }

  for (const panel of els.onboardingPanels) {
    panel.hidden = panel.dataset.onboardingPanel !== step;
  }

  const stepIndex = onboardingStepIndex(step);
  for (const marker of els.onboardingMarkers) {
    const markerIndex = ONBOARDING_STEPS.indexOf(marker.dataset.onboardingMarker);
    marker.classList.toggle("is-active", markerIndex === Math.min(stepIndex, ONBOARDING_STEPS.length - 1));
    marker.classList.toggle("is-complete", markerIndex < stepIndex);
  }
  els.onboardingProgress.textContent = step === "complete"
    ? "Complete"
    : `Step ${stepIndex + 1} of ${ONBOARDING_STEPS.length}`;
  els.onboardingMessage.textContent = onboarding.message || "Continue first-time setup.";
  els.onboardingStatus.textContent = ["welcome", "camera_details"].includes(step) ? "" : onboarding.message || "";
  els.onboardingStatus.classList.toggle("has-error", /failed|could not|required|not discovered|error/i.test(onboarding.message || ""));

  const targetSsid = onboarding.targetSsid;
  if (targetSsid) {
    els.onboardingReconnectText.textContent = `Connect this computer to ${targetSsid}, wait up to two minutes for the camera to join, then verify the native control path and SD card.`;
  }
  const activeNetworks = Array.isArray(onboarding.activeNetworks) ? onboarding.activeNetworks : [];
  els.onboardingActiveNetworks.textContent = activeNetworks.length
    ? `Active Wi-Fi: ${activeNetworks.map((network) => `${network.device} on ${network.ssid}`).join(" · ")}`
    : "No active Wi-Fi network was detected. Connect either Wi-Fi adapter to the camera network, then retry.";
  if (!required) {
    els.onboardingConnectionSummary.textContent = onboarding.connectionMode === "hotspot"
      ? "The camera is configured to stay on its own hotspot. Connect this computer to the camera hotspot whenever you use the dashboard. You can migrate it to Wi-Fi below."
      : onboarding.connectionMode === "wifi"
        ? `The camera is configured on ${onboarding.targetSsid || "its selected Wi-Fi"}. Connect this computer to that network whenever you use the dashboard.`
        : "Camera credentials, network access, time settings, recording policy, and local dashboard configuration are saved.";
  }
  hydrateOnboarding(state.config);
}

function renderSetup(setup) {
  if (state.onboarding?.required) {
    els.setupPanel.classList.add("setup-hidden");
    return;
  }
  renderSetupPanel({ setup, els, setupFormOpen: state.setupFormOpen });
}

function renderStartupGate(setup) {
  if (state.onboarding?.required) {
    els.body.classList.remove("startup-checking", "startup-failed");
    els.startupGate.setAttribute("aria-busy", "false");
    return;
  }
  const status = setup?.status || "idle";
  if (status === "ready" || status === "configured") {
    els.body.classList.remove("startup-checking", "startup-failed");
    els.startupGate.setAttribute("aria-busy", "false");
    return;
  }
  if (status === "error") {
    els.body.classList.remove("startup-checking");
    els.body.classList.add("startup-failed");
    els.startupGate.setAttribute("aria-busy", "false");
    els.startupTitle.textContent = "Camera not discovered";
    els.startupMessage.textContent = setup.summary.replace(/^Could not read camera time:\s*/, "");
    els.startupRetryBtn.hidden = false;
    return;
  }
  els.body.classList.add("startup-checking");
  els.body.classList.remove("startup-failed");
  els.startupGate.setAttribute("aria-busy", "true");
  els.startupTitle.textContent = "Looking for your camera";
  els.startupMessage.textContent = "Checking that this computer can discover the camera. This may take a moment.";
  els.startupRetryBtn.hidden = true;
}

function maybeAutoStartReadyPreview(setup) {
  if (state.onboarding?.required) return;
  if (state.ui.activeWorkspace !== "overviewWorkspace") return;
  if (!state.recordingsPreloaded) return;
  if (!shouldAutoStartReadyPreview({ setup, running: state.running, readyAutoStarted: state.readyAutoStarted })) return;
  state.readyAutoStarted = true;
  ensurePreviewRunningForSetup().catch((err) => {
    state.readyAutoStarted = false;
    els.statusMeta.textContent = `Preview auto-start failed: ${err.message}`;
  });
}

function applyState(payload) {
  state.running = payload.running;
  state.setup = payload.setup || state.setup;
  state.onboarding = payload.onboarding || state.onboarding;
  state.config = payload.config || state.config;
  state.appliedConfig = payload.appliedConfig || state.appliedConfig;
  const stats = payload.stats || {};
  renderOnboarding(state.onboarding);
  renderStartupGate(payload.setup || null);
  setDashboardMode(payload.setup || null);

  const identity = state.config?.did || currentConfig().did || "Unknown camera";
  els.cameraIdentity.textContent = identity;
  els.statusText.textContent = state.ui.setupAttention ? "setup needed" : state.running ? "running" : "idle";
  els.statusMeta.textContent = state.ui.setupAttention
    ? "Camera needs setup before live monitoring is available."
    : state.running
      ? `Started ${payload.startedAt || ""}`
      : "No stream running";

  els.inputBytes.textContent = fmtBytes(stats.inputBytes || 0);
  els.outputBytes.textContent = fmtBytes(stats.outputBytes || 0);
  els.frames.textContent = String(stats.deliveredFrames || 0);
  els.missing.textContent = String(stats.missingFrames || 0);
  els.dropRate.textContent = `${((stats.estimatedDropRate || 0) * 100).toFixed(2)}%`;
  els.maxGap.textContent = String(stats.maxGap || 0);
  els.waitingKeyframe.textContent = String(stats.waitingKeyframe || 0);
  els.prependedConfig.textContent = String(stats.prependedConfig || 0);

  if (state.running) {
    els.previewEmpty.style.display = "none";
    els.streamImg.style.display = "block";
    if (!els.streamImg.src || els.streamImg.dataset.loading !== "1") {
      clearPreviewRetry();
      els.streamImg.dataset.loading = "1";
      els.streamImg.src = `/stream.mjpg?ts=${Date.now()}`;
    }
  } else {
    clearPreviewRetry();
    els.previewEmpty.style.display = "grid";
    els.streamImg.style.display = "none";
    els.streamImg.removeAttribute("src");
    els.streamImg.dataset.loading = "0";
  }

  if (payload.logs) {
    state.logs = payload.logs;
    filterLogs();
  }

  if (!state.formHydrated && payload.config) {
    applyConfigToForm(payload.config);
    state.formHydrated = true;
    if (els.sdYear && !els.sdYear.value) {
      els.sdYear.value = String(new Date().getFullYear());
    }
  }

  renderSetup(payload.setup || null);
  renderConfigState();
  updateTopbar();
  maybeAutoStartReadyPreview(payload.setup || null);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function loadState() {
  const res = await fetch("/api/state");
  const payload = await res.json();
  applyState(payload);
}

async function loadAppliedConfig() {
  const payload = await post("/api/config/live", {});
  if (!payload.ok) {
    throw new Error(payload.error || "Could not read applied camera settings");
  }
  state.appliedConfig = payload.config || state.appliedConfig;
  renderConfigState();
  return state.appliedConfig;
}

function setRecordingTask(task) {
  state.recordingTask = task;
  if (task) {
    task.files = new Map();
    els.recordingTransferProgress.replaceChildren();
    els.recordingTransferProgress.hidden = task.kind !== "download";
  } else {
    els.recordingTransferProgress.hidden = true;
  }
}

function formatSpeed(bytesPerSecond) {
  return `${fmtBytes(Math.max(0, bytesPerSecond))}/s`;
}

function renderTransferProgress(task) {
  const fragment = document.createDocumentFragment();
  for (const file of task.files.values()) {
    const row = document.createElement("div");
    row.className = `transfer-row${file.done ? " done" : ""}`;
    const percent = file.done ? 100 : file.totalBytes
      ? Math.min(99, Math.max(1, (file.bytes / file.totalBytes) * 100))
      : file.expectedMs
        ? Math.min(99, Math.max(1, (file.elapsedMs / file.expectedMs) * 100))
        : 0;
    row.innerHTML = `
      <div class="transfer-heading">
        <span>${file.index}/${file.total} · ${file.filename}</span>
        <strong>${file.done ? "Complete" : `${percent.toFixed(0)}%`}</strong>
      </div>
      <div class="transfer-track${file.expectedMs ? "" : " indeterminate"}">
        <div class="transfer-fill" style="width:${percent}%"></div>
      </div>
      <div class="transfer-meta">${fmtBytes(file.bytes)} · ${formatSpeed(file.speed)} current · ${formatSpeed(file.averageSpeed)} average</div>`;
    fragment.appendChild(row);
  }
  els.recordingTransferProgress.replaceChildren(fragment);
}

function updateRecordingTaskProgress(line) {
  const task = state.recordingTask;
  if (!task) return;

  const downloadMatch = String(line).match(/^\[recordings\] bulk download (\d+)\/(\d+) (.+)$/);
  if (downloadMatch) {
    const [, index, total, filename] = downloadMatch;
    els.sdStatus.textContent = `Preparing ${task.label}. ${index}/${total}: ${filename}`;
    state.ui.activeOperationLabel = `${task.kind === "download" ? "Downloading" : "Deleting"} ${index}/${total}`;
    setBusy(false);
    setBusy(true, state.ui.activeOperationLabel);
    return;
  }

  const progressMatch = String(line).match(/^\[recordings\] progress (\d+)\/(\d+) (.+) bytes=(\d+) elapsed_ms=(\d+) expected_ms=(\d+) total_bytes=(\d+) done=([01])$/);
  if (progressMatch && task.kind === "download") {
    const [, index, total, filename, bytesText, elapsedText, expectedText, totalBytesText, doneText] = progressMatch;
    const bytes = Number(bytesText);
    const elapsedMs = Number(elapsedText);
    const previous = task.files.get(filename);
    const deltaSeconds = previous ? (elapsedMs - previous.elapsedMs) / 1000 : elapsedMs / 1000;
    const speed = deltaSeconds > 0 ? (bytes - (previous?.bytes || 0)) / deltaSeconds : 0;
    const file = {
      index: Number(index), total: Number(total), filename, bytes, elapsedMs,
      expectedMs: Number(expectedText), totalBytes: Number(totalBytesText), done: doneText === "1",
      speed, averageSpeed: elapsedMs > 0 ? bytes / (elapsedMs / 1000) : 0,
    };
    task.files.set(filename, file);
    renderTransferProgress(task);
    els.sdStatus.textContent = `Preparing ${task.label}. ${index}/${total}: ${filename} · ${formatSpeed(speed)}`;
  }
}

function recordingLabel(item) {
  if (typeof item === "string") return item;
  return item?.filename || item?.file || item?.name || JSON.stringify(item);
}

function recordingFileParam(item) {
  const label = recordingLabel(item).trim();
  try {
    const parsed = JSON.parse(label);
    return parsed.filename || parsed.file || parsed.name || label;
  } catch {
    return label;
  }
}

function parseRecordingFile(file) {
  const name = recordingFileParam(file);
  const match = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_(\d+)_/);
  if (!match) {
    return { name, ts: 0, date: "Unknown date", time: "", duration: 0, durationLabel: "" };
  }
  const [, year, month, day, hour, minute, second, durationRaw] = match;
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const timestamp = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  const duration = Number(durationRaw);
  return {
    name,
    ts: timestamp.getTime(),
    date: `${year}-${month}-${day}`,
    time: timeFormatter.format(timestamp),
    duration,
    durationLabel: `${Math.floor(duration / 60)}m ${String(duration % 60).padStart(2, "0")}s`,
  };
}

function filteredSortedRecordings(items) {
  const filter = String(els.recordingTimeFilter.value || "").trim();
  const rows = items.map((item) => ({ item, meta: parseRecordingFile(item) }));
  const filtered = filter ? rows.filter(({ meta }) => meta.time.startsWith(filter)) : rows;
  const sort = els.recordingSort.value || "newest";
  return filtered.sort((a, b) => {
    if (sort === "oldest") return a.meta.ts - b.meta.ts;
    if (sort === "duration_desc") return b.meta.duration - a.meta.duration;
    if (sort === "duration_asc") return a.meta.duration - b.meta.duration;
    return b.meta.ts - a.meta.ts;
  });
}

function renderRecordingsModeButtons() {
  els.recordingsModeDayBtn.classList.toggle("is-active", state.ui.recordingsMode === "day");
  els.recordingsModeBrowseBtn.classList.toggle("is-active", state.ui.recordingsMode === "browse");
  const browseDisabled = state.ui.recordingsMode === "day";
  els.recordingPrevBtn.disabled = browseDisabled || state.sd.dayPage <= 0;
  const totalVideos = state.sd.groupedFiles.reduce((sum, group) => sum + (group.items?.length || 0), 0);
  const totalPages = Math.ceil(totalVideos / state.sd.dayPageSize);
  els.recordingNextBtn.disabled = browseDisabled || state.sd.dayPage >= totalPages - 1 || totalVideos <= state.sd.dayPageSize;
  els.recordingPageInfo.textContent = browseDisabled
    ? "Selected day"
    : totalPages <= 1
      ? `${totalVideos} videos`
      : `Page ${state.sd.dayPage + 1} of ${totalPages} · ${state.sd.dayPageSize} videos per page`;
}

function renderRecordingDaysList() {
  els.sdDays.innerHTML = state.sd.days.length
    ? state.sd.days.map((day) => `
      <div class="sd-day-row">
        <button class="sd-item sd-day-btn${state.sd.selectedDay === day ? " is-active" : ""}" data-record-day="${escapeHtml(day)}" type="button">${escapeHtml(displayYmd(day))}</button>
        <button class="day-action" data-download-day="${escapeHtml(day)}" type="button" title="Download all recordings for ${escapeHtml(displayYmd(day))}">↓</button>
        <button class="day-action danger" data-delete-day="${escapeHtml(day)}" type="button" title="Delete all recordings for ${escapeHtml(displayYmd(day))}">×</button>
      </div>
    `).join("")
    : renderList(state.sd.days, "No days found.");
}

function renderRecordingFiles() {
  const groups = state.sd.groupedFiles || [];
  const allGroups = groups.map(({ day, items }) => ({
    day,
    rows: filteredSortedRecordings(items),
  })).filter((group) => group.rows.length);
  const totalByDay = new Map(allGroups.map((group) => [group.day, group.rows.length]));
  const showingSingleDay = state.ui.recordingsMode === "day" || (allGroups.length === 1 && state.sd.selectedDay);
  const flatRows = allGroups.flatMap((group) => group.rows.map((row) => ({ day: group.day, ...row })));
  const limit = Math.max(1, Number(state.sd.dayPageSize) || 12);
  const startIndex = showingSingleDay ? 0 : Math.max(0, Number(state.sd.dayPage || 0) * limit);
  const pageRows = showingSingleDay ? flatRows : flatRows.slice(startIndex, startIndex + limit);
  const preparedGroups = [];
  for (const row of pageRows) {
    const last = preparedGroups[preparedGroups.length - 1];
    if (last && last.day === row.day) {
      last.rows.push(row);
    } else {
      preparedGroups.push({ day: row.day, rows: [row] });
    }
  }
  state.sd.visibleRows = preparedGroups.flatMap((group) => group.rows);
  renderRecordingsModeButtons();
  if (!preparedGroups.length) {
    els.sdFiles.innerHTML = renderList([], "No files found.");
    els.sdStatus.textContent = groups.length ? "No videos match the selected time." : "No recordings found for the loaded dates.";
    return;
  }
  els.recordingViewToggleBtn.textContent = state.sd.view === "grid" ? "List view" : "Grid view";
  const totalVideos = flatRows.length;
  const totalPages = Math.max(1, Math.ceil(totalVideos / limit));
  els.recordingsHeading.textContent = showingSingleDay ? `Selected day: ${displayYmd(preparedGroups[0].day)}` : "Browse by dates";
  els.sdStatus.textContent = showingSingleDay
    ? `Showing ${totalVideos} videos for ${displayYmd(preparedGroups[0].day)}.`
    : `Showing ${pageRows.length} of ${totalVideos} videos across ${preparedGroups.length} dates.`;
  let absoluteIndex = 0;
  els.sdFiles.innerHTML = preparedGroups.map(({ day, rows }) => `
    <section class="recording-date-group">
      <div class="recording-date-head">
        <h3>${escapeHtml(displayYmd(day))}</h3>
        <div class="recording-date-summary">
          <span>${totalByDay.get(day) || rows.length} video${(totalByDay.get(day) || rows.length) === 1 ? "" : "s"} total</span>
          <span>${rows.length} shown on this page</span>
          <div class="recording-date-actions">
            <button class="secondary" data-download-day="${escapeHtml(day)}" type="button">Download day</button>
            <button class="danger" data-delete-day="${escapeHtml(day)}" type="button">Delete day</button>
          </div>
        </div>
      </div>
      <div class="recording-date-items ${state.sd.view === "grid" ? "recordings-grid" : "recordings-list-view"}">
        ${rows.map(({ item, meta }) => {
          const currentIndex = absoluteIndex;
          absoluteIndex += 1;
          const label = recordingLabel(item);
          const file = recordingFileParam(item);
          return `
            <div class="recording-row">
              <button class="recording-thumb recording-play" data-recording-index="${currentIndex}" data-recording-file="${escapeHtml(file)}" type="button" aria-label="Play ${escapeHtml(label)}">
                <img data-thumb-file="${escapeHtml(file)}" alt="Thumbnail for ${escapeHtml(label)}" loading="lazy">
                <span>${escapeHtml(meta.time || "video")}</span>
                <span class="play-badge">▶</span>
              </button>
              <div class="recording-main">
                <div class="recording-name">${escapeHtml(label)}</div>
                <div class="recording-meta">${escapeHtml(meta.date)} ${escapeHtml(meta.time)} ${escapeHtml(meta.durationLabel)}</div>
                <div class="recording-item-actions">
                  <button class="secondary recording-download" data-recording-file="${escapeHtml(file)}" type="button">Download</button>
                  <button class="danger recording-delete" data-recording-file="${escapeHtml(file)}" type="button">Delete</button>
                </div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </section>
  `).join("");
  loadVisibleThumbnails();
  if (!showingSingleDay) {
    els.recordingPageInfo.textContent = `Page ${state.sd.dayPage + 1} of ${totalPages} · ${limit} videos per page`;
  }
}

async function loadVisibleThumbnails() {
  state.thumbnailAbortController?.abort();
  const controller = new AbortController();
  state.thumbnailAbortController = controller;
  const images = Array.from(els.sdFiles.querySelectorAll("img[data-thumb-file]"));
  for (const img of images) {
    if (controller.signal.aborted || state.ui.activeWorkspace !== "recordingsWorkspace") break;
    if (img.dataset.loaded === "1") continue;
    img.dataset.loaded = "1";
    if (state.busyHolds.thumbnails === 0) {
      setBusy(true, "Loading thumbnails");
    } else {
      setBusyLabel("Loading thumbnails");
    }
    state.busyHolds.thumbnails += 1;
    try {
      const res = await fetch(`/api/recordings/thumb?file=${encodeURIComponent(img.dataset.thumbFile)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("thumbnail failed");
      const blob = await res.blob();
      img.src = URL.createObjectURL(blob);
      img.closest(".recording-thumb")?.classList.add("has-image");
    } catch {
      img.closest(".recording-thumb")?.classList.add("thumb-failed");
    } finally {
      state.busyHolds.thumbnails = Math.max(0, state.busyHolds.thumbnails - 1);
      if (state.busyHolds.thumbnails === 0) {
        setBusy(false, "Loading thumbnails");
      }
    }
  }
  if (state.thumbnailAbortController === controller) {
    state.thumbnailAbortController = null;
  }
}

function openRecordingModal() {
  els.recordingModal.classList.add("active");
  els.recordingModal.setAttribute("aria-hidden", "false");
  els.body.classList.add("modal-open");
}

function closeRecordingModal() {
  clearInterval(state.recordingCacheTimer);
  state.recordingCacheTimer = null;
  releaseBusy("playback", "Preparing playback");
  els.recordingPlayer.pause();
  els.recordingPlayer.removeAttribute("src");
  els.recordingPlayer.load();
  els.recordingModal.classList.remove("active");
  els.recordingModal.setAttribute("aria-hidden", "true");
  els.body.classList.remove("modal-open");
  state.activeRecordingFile = "";
  state.activeRecordingIndex = -1;
}

function playRecording(file, index = -1) {
  if (!file) return;
  clearInterval(state.recordingCacheTimer);
  state.recordingCacheTimer = null;
  els.recordingPlayer.pause();
  els.recordingPlayer.removeAttribute("src");
  els.recordingPlayer.load();
  state.activeRecordingFile = file;
  state.activeRecordingIndex = index;
  state.lastPlayableTime = 0;
  state.correctingRecordingSeek = false;
  els.recordingModalTitle.textContent = file;
  openRecordingModal();
  const src = `/api/recordings/play?file=${encodeURIComponent(file)}&ts=${Date.now()}`;
  els.recordingPlayer.dataset.playMode = "preparing";
  els.recordingPlayer.dataset.hasPlayed = "0";
  els.recordingPlayer.src = src;
  els.recordingPlayerStatus.textContent = `Preparing a fast, fully seekable copy of ${file}...`;
  holdBusy("playback", "Preparing playback");
  els.recordingPlayer.play().catch((err) => {
    els.recordingPlayerStatus.textContent = `Click play in the video control if autoplay was blocked. ${err.message}`;
  });
  const checkCache = async () => {
    try {
      const res = await fetch(`/api/recordings/play-status?file=${encodeURIComponent(file)}`);
      const payload = await res.json();
      if (payload.ready && state.activeRecordingFile === file) {
        els.recordingPlayer.dataset.playMode = "seekable";
        els.recordingPlayerStatus.textContent = "Ready. The full timeline is seekable.";
        clearInterval(state.recordingCacheTimer);
        state.recordingCacheTimer = null;
        releaseBusy("playback", "Preparing playback");
      } else if (state.activeRecordingFile === file && payload.status === "waiting") {
        els.recordingPlayerStatus.textContent = "Waiting for the camera to become free so the seekable copy can be prepared.";
        setBusyLabel("Waiting for camera");
      } else if (state.activeRecordingFile === file && payload.status === "failed" && payload.error) {
        els.recordingPlayerStatus.textContent = `Seekable copy unavailable: ${payload.error}.`;
        clearInterval(state.recordingCacheTimer);
        state.recordingCacheTimer = null;
        releaseBusy("playback", "Preparing playback");
      }
    } catch {}
  };
  state.recordingCacheTimer = setInterval(checkCache, 1000);
  checkCache();
}

function playNextRecording() {
  const rows = state.sd.visibleRows;
  if (!rows.length) return;
  const nextIndex = state.activeRecordingIndex >= 0 ? state.activeRecordingIndex + 1 : 0;
  const row = rows[nextIndex >= rows.length ? 0 : nextIndex];
  playRecording(recordingFileParam(row.item), nextIndex >= rows.length ? 0 : nextIndex);
}

async function querySd(path, body, kind, label = "Reading camera") {
  els.sdStatus.textContent = "Querying camera...";
  setBusy(true, label);
  try {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || "SD query failed");
    }
    setSdState(kind, payload.payload || {});
    if (payload.stderr) {
      els.sdStatus.textContent += `\n${payload.stderr}`;
    }
  } finally {
    setBusy(false, label);
  }
}

async function querySdPayload(path, body, label = "Reading camera") {
  setBusy(true, label);
  try {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) {
      throw new Error(payload.error || "SD query failed");
    }
    return payload.payload || {};
  } finally {
    setBusy(false, label);
  }
}

function setSdState(kind, payload) {
  if (kind === "status") {
    state.sd.status = payload;
    const json = payload?.json || {};
    els.sdStatus.textContent = json.sdstatu === 1
      ? `SD card ready. ${json.free || "?"} MB free of ${json.total || "?"} MB.`
      : "SD card is not ready.";
  } else if (kind === "days") {
    const json = payload?.json || {};
    const items = [];
    if (Array.isArray(json.days)) {
      for (const day of json.days) items.push(String(day));
    } else if (Array.isArray(json.list)) {
      for (const day of json.list) items.push(String(day));
    } else if (Array.isArray(json.data)) {
      for (const day of json.data) items.push(String(day));
    } else {
      const year = Number(json.year || payload?.year || els.sdYear.value || new Date().getFullYear());
      for (let month = 0; month < 12; month += 1) {
        const mask = Number(json[`month[${month}]`] || 0);
        if (!mask) continue;
        for (let day = 1; day <= 31; day += 1) {
          if (mask & (1 << (day - 1))) {
            items.push(`${year}${String(month + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`);
          }
        }
      }
      const text = payload?.raw_text || "";
      const matches = text.match(/\d{8}/g) || [];
      for (const match of matches) {
        if (/^\d{8}$/.test(match)) {
          const year = Number(match.slice(0, 4));
          const month = Number(match.slice(4, 6));
          const date = Number(match.slice(6, 8));
          if (year >= 2000 && year <= 2200 && month >= 1 && month <= 12 && date >= 1 && date <= 31 && !items.includes(match)) {
            items.push(match);
          }
        }
      }
    }
    state.sd.days = sortRecordingDays(items);
    renderRecordingDaysList();
  }
}

function extractRecordingFiles(payload) {
  const json = payload?.json || {};
  const items = [];
  const addFile = (file) => {
    const candidate = recordingFileParam(file).trim();
    if (/^[\w.-]+\.(?:mp4|avi|h264|h265|hevc)$/i.test(candidate) && !items.includes(candidate)) {
      items.push(candidate);
    }
  };
  if (Array.isArray(json.files)) {
    for (const file of json.files) addFile(file);
  } else if (Array.isArray(json.list)) {
    for (const file of json.list) addFile(file);
  } else if (Array.isArray(json.data)) {
    for (const file of json.data) addFile(file);
  } else if (Number.isFinite(Number(json.record_num))) {
    const count = Number(json.record_num);
    for (let index = 0; index < count; index += 1) {
      const file = json[`record_name[${index}]`];
      if (file) addFile(file);
    }
  } else {
    const text = payload?.raw_text || "";
    const matches = [...text.matchAll(/"record_name\[\d+\]"\s*:\s*"([^"]+)"/g)].map((match) => match[1]);
    for (const file of matches) addFile(file);
  }
  return items;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCameraBusyError(err) {
  return String(err?.message || "").includes("another camera query is already running");
}

async function stopPreviewForRecordings() {
  if (!state.running) return;
  state.previewPausedForRecordings = true;
  setBusy(true, "Stopping preview");
  try {
    await post("/api/stop", {});
    await loadState();
  } finally {
    setBusy(false, "Stopping preview");
  }
}

async function loadRecordingDays(daysToLoad, { page = state.sd.dayPage, selectedDay = "" } = {}) {
  const pageDays = sortRecordingDays(daysToLoad);
  if (!pageDays.length) {
    state.sd.selectedDay = selectedDay;
    state.ui.selectedDay = selectedDay;
    state.sd.groupedFiles = [];
    state.sd.files = [];
    renderRecordingDaysList();
    renderRecordingFiles();
    els.sdStatus.textContent = "No recordings found for the selected date.";
    return;
  }
  state.sd.dayPage = page;
  state.sd.selectedDay = selectedDay;
  state.ui.selectedDay = selectedDay;
  els.sdStatus.textContent = `Loading recordings for ${pageDays.map((day) => displayYmd(day)).join(", ")}...`;
  const groupedFiles = [];
  for (const day of pageDays) {
    const payload = await querySdPayload("/api/sd/files", { ymd: day }, "Loading recordings");
    groupedFiles.push({ day, items: extractRecordingFiles(payload) });
  }
  state.sd.groupedFiles = groupedFiles;
  state.sd.files = groupedFiles.flatMap((group) => group.items);
  els.sdDate.value = displayYmd(selectedDay || pageDays[0]);
  renderRecordingDaysList();
  renderRecordingFiles();
}

async function loadRecordingDayPage(page = 0) {
  const days = sortRecordingDays(state.sd.days);
  state.sd.days = days;
  if (!days.length) {
    state.sd.dayPage = 0;
    state.sd.selectedDay = "";
    state.ui.selectedDay = "";
    state.sd.groupedFiles = [];
    state.sd.files = [];
    renderRecordingDaysList();
    renderRecordingFiles();
    els.sdStatus.textContent = "No recording dates with footage were found.";
    return;
  }
  const scopedDays = state.sd.selectedDay && days.includes(state.sd.selectedDay) ? [state.sd.selectedDay] : days;
  els.sdStatus.textContent = `Loading recordings for ${scopedDays.map((day) => displayYmd(day)).join(", ")}...`;
  const groupedFiles = [];
  for (const day of scopedDays) {
    const payload = await querySdPayload("/api/sd/files", { ymd: day }, "Loading recordings");
    groupedFiles.push({ day, items: extractRecordingFiles(payload) });
  }
  state.sd.groupedFiles = groupedFiles;
  state.sd.files = groupedFiles.flatMap((group) => group.items);
  const totalVideos = state.sd.groupedFiles.reduce((sum, group) => sum + (group.items?.length || 0), 0);
  const maxPage = Math.max(0, Math.ceil(totalVideos / state.sd.dayPageSize) - 1);
  const nextPage = Math.min(Math.max(0, page), maxPage);
  state.ui.recordingsMode = "browse";
  state.sd.dayPage = nextPage;
  if (scopedDays.length === 1) {
    state.sd.selectedDay = scopedDays[0];
    state.ui.selectedDay = scopedDays[0];
  } else {
    state.sd.selectedDay = "";
    state.ui.selectedDay = "";
  }
  renderRecordingDaysList();
  renderRecordingFiles();
}

async function openSpecificRecordingDay(rawValue = els.sdDate.value) {
  const ymd = cameraYmd(rawValue);
  if (!/^\d{8}$/.test(ymd)) {
    throw new Error("Enter a date as YYYY-MM-DD");
  }
  state.ui.recordingsMode = "day";
  state.sd.selectedDay = ymd;
  state.ui.selectedDay = ymd;
  const index = state.sd.days.indexOf(ymd);
  await loadRecordingDays([ymd], {
    page: 0,
    selectedDay: ymd,
  });
}

async function loadLatestRecordings() {
  const year = Number(els.sdYear.value || new Date().getFullYear());
  await querySd("/api/sd/days", { year }, "days", "Loading recordings");
  await loadRecordingDayPage(state.sd.dayPage || 0);
}

async function ensureRecordingsLoaded({ force = false } = {}) {
  if (!force && state.recordingsLoadingPromise) {
    return state.recordingsLoadingPromise;
  }
  if (!force && state.recordingsAutoLoaded && state.sd.days.length) {
    return;
  }
  const task = (async () => {
    await stopPreviewForRecordings();
    let lastError = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await loadLatestRecordings();
        state.recordingsAutoLoaded = true;
        return;
      } catch (err) {
        lastError = err;
        if (!isCameraBusyError(err) || attempt === 11) {
          throw err;
        }
        els.sdStatus.textContent = "Camera is busy finishing another request. Waiting and retrying recordings...";
        setBusy(true, "Waiting for camera");
        await sleep(700);
        setBusy(false, "Waiting for camera");
      }
    }
    throw lastError || new Error("Could not load recordings");
  })();
  state.recordingsLoadingPromise = task.finally(() => {
    state.recordingsLoadingPromise = null;
  });
  return state.recordingsLoadingPromise;
}

async function downloadRecordingGroup(selection, label) {
  const format = els.recordingDownloadFormat.value || "original";
  const formatLabel = format === "original" ? "fast original MP4 archive" : format === "raw" ? "raw HEVC archive" : "converted MP4 archive";
  setBusy(true, "Downloading recordings");
  els.sdStatus.textContent = `Preparing ${label} as a ${formatLabel}. This can take several minutes...`;
  setRecordingTask({ kind: "download", label, format });
  try {
    const res = await fetch("/api/recordings/download-bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, format }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || "Bulk download failed");
    }
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || "homeeye-recordings.zip";
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(href);
    els.sdStatus.textContent = `Downloaded ${filename}.`;
  } catch (err) {
    els.sdStatus.textContent = `Download failed: ${err.message}`;
  } finally {
    setRecordingTask(null);
    setBusy(false, "Downloading recordings");
  }
}

async function deleteRecordingGroup(selection, label) {
  if (!window.confirm(`Permanently delete ${label}? This cannot be undone.`)) return false;
  setBusy(true, "Deleting recordings");
  els.sdStatus.textContent = `Deleting ${label}...`;
  setRecordingTask({ kind: "delete", label });
  try {
    const res = await fetch("/api/recordings/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });
    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || "Delete failed");
    const deleted = payload.deleted?.length || 0;
    const failed = payload.failed?.length || 0;
    els.sdStatus.textContent = failed ? `Deleted ${deleted}; ${failed} failed. ${payload.failed.map((item) => item.file).join(", ")}` : `Deleted ${deleted} recording${deleted === 1 ? "" : "s"}.`;
    return failed === 0;
  } catch (err) {
    els.sdStatus.textContent = `Delete failed: ${err.message}`;
    return false;
  } finally {
    setRecordingTask(null);
    setBusy(false, "Deleting recordings");
  }
}

function removeDayLocally(day) {
  state.sd.days = state.sd.days.filter((item) => item !== day);
  state.sd.groupedFiles = state.sd.groupedFiles.filter((group) => group.day !== day);
  if (state.sd.selectedDay === day) {
    state.sd.selectedDay = "";
    state.ui.selectedDay = "";
    state.ui.recordingsMode = "browse";
  }
  renderRecordingDaysList();
  renderRecordingFiles();
}

function buildStartPayload() {
  const cfg = currentConfig();
  return {
    did: cfg.did,
    user: cfg.user,
    pwd: cfg.pwd,
    quality: "hd",
    stream: 2,
    iframeInterval: cfg.iframeInterval,
    gapIframeThreshold: cfg.gapIframeThreshold,
    setParamDelay: cfg.setParamDelay,
    readChunk: cfg.readChunk,
    maxReadChunk: cfg.maxReadChunk,
    readTimeout: cfg.readTimeout,
    previewFps: cfg.previewFps,
    previewWidth: cfg.previewWidth,
    previewQuality: cfg.previewQuality,
    noIframe: cfg.noIframe,
    noWaitKeyframe: cfg.noWaitKeyframe,
    checkBuffer: cfg.checkBuffer,
    previewTimeWatch: cfg.previewTimeWatch,
  };
}

function buildApplyPayload() {
  const cfg = currentConfig();
  const extraParams = cfg.extraParams
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf("=");
      return idx > 0 ? [line.slice(0, idx).trim(), line.slice(idx + 1).trim()] : null;
    })
    .filter(Boolean);

  return {
    did: cfg.did,
    user: cfg.user,
    pwd: cfg.pwd,
    videoResolution: cfg.videoResolution,
    timeHour: cfg.timeHour,
    nightVisionMode: cfg.nightVisionMode,
    recordVideo: cfg.recordVideo,
    recordMode: cfg.recordMode,
    recordSound: cfg.recordSound,
    recordSoundDuringWakeUpPeriod: cfg.recordSoundDuringWakeUpPeriod,
    loopCoverage: cfg.loopCoverage,
    sdCardRecordingDurationMinutes: cfg.sdCardRecordingDurationMinutes,
    alarmRecordingDurationSeconds: cfg.alarmRecordingDurationSeconds,
    alarmRecordingIntervalSeconds: cfg.alarmRecordingIntervalSeconds,
    wakeupMode: cfg.wakeupMode,
    timedRecordStart: cfg.timedRecordStart,
    timedRecordEnd: cfg.timedRecordEnd,
    timedRecordDays: cfg.timedRecordDays,
    timedRecordEnable: cfg.timedRecordEnable,
    lowPowerMode: cfg.lowPowerMode,
    setParamDelay: cfg.setParamDelay,
    getDatetime: cfg.getDatetime,
    syncTimeNow: cfg.syncTimeNow,
    previewTimeWatch: cfg.previewTimeWatch,
    extraParams,
  };
}

async function ensurePreviewRunningForSetup() {
  if (state.running) return;
  await post("/api/start", buildStartPayload());
}

function applyThumbnailSize() {
  const size = Number(els.recordingThumbSize.value || 210);
  document.documentElement.style.setProperty("--recording-thumb-size", `${size}px`);
}

els.streamImg.addEventListener("load", () => clearPreviewRetry());
els.streamImg.addEventListener("error", () => schedulePreviewRetry());

els.navToggleBtn.addEventListener("click", () => {
  els.leftRail.classList.toggle("is-open");
});

for (const button of els.workspaceButtons) {
  button.addEventListener("click", () => setActiveWorkspace(button.dataset.workspaceTarget));
}

function formValues(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function setLocalOnboardingStep(step, message) {
  state.onboarding = {
    ...(state.onboarding || {}),
    required: step !== "complete",
    step,
    message,
  };
  renderOnboarding(state.onboarding);
}

async function runOnboardingAction(button, label, action) {
  button.disabled = true;
  els.onboardingStatus.classList.remove("has-error");
  els.onboardingStatus.textContent = label;
  setBusy(true, label);
  try {
    const result = await action();
    if (result.onboarding) {
      state.onboarding = result.onboarding;
      renderOnboarding(state.onboarding);
    }
    if (!result.ok) throw new Error(result.error || `${label} failed`);
    return result;
  } catch (err) {
    els.onboardingStatus.textContent = err.message;
    els.onboardingStatus.classList.add("has-error");
    throw err;
  } finally {
    setBusy(false, label);
    button.disabled = false;
  }
}

els.onboardingBeginBtn.addEventListener("click", () => {
  setLocalOnboardingStep("camera_details", "Enter the camera identity and local time settings.");
});

els.onboardingDiscoverBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingDiscoverBtn,
      "Looking for camera hotspot",
      () => post("/api/onboarding/discover", {}),
    );
  } catch {}
});

els.onboardingConnectBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(els.onboardingConnectBtn, "Connecting to camera", () => {
      const values = formValues(els.onboardingCameraForm);
      return post("/api/onboarding/connect", {
        ...values,
        ntpSwitch: Number(values.ntpSwitch),
      });
    });
  } catch {}
});

els.onboardingKeepHotspotBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingKeepHotspotBtn,
      "Verifying hotspot mode",
      () => post("/api/onboarding/hotspot/keep", {}),
    );
  } catch {}
});

els.onboardingChooseWifiBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingChooseWifiBtn,
      "Opening Wi-Fi setup",
      () => post("/api/onboarding/wifi/begin", {}),
    );
  } catch {}
});

els.onboardingWifiScanBtn.addEventListener("click", async () => {
  try {
    const result = await runOnboardingAction(
      els.onboardingWifiScanBtn,
      "Scanning Wi-Fi from camera",
      () => post("/api/onboarding/wifi/scan", {}),
    );
    els.onboardingWifiList.replaceChildren();
    for (const network of result.networks || []) {
      const option = document.createElement("option");
      option.value = network.ssid;
      option.label = `${network.ssid} · signal ${network.signal ?? "?"} · encryption ${network.encryption ?? "?"}`;
      option.dataset.encryption = String(network.encryption ?? "");
      els.onboardingWifiList.appendChild(option);
    }
  } catch {}
});

els.onboardingWifiForm.elements.namedItem("ssid").addEventListener("input", () => {
  const ssid = els.onboardingWifiForm.elements.namedItem("ssid").value;
  const match = Array.from(els.onboardingWifiList.options).find((option) => option.value === ssid);
  if (match?.dataset.encryption) {
    els.onboardingWifiForm.elements.namedItem("encryption").value = match.dataset.encryption;
  }
});

els.onboardingWifiSkipBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingWifiSkipBtn,
      "Keeping current camera network",
      () => post("/api/onboarding/wifi/skip", {}),
    );
  } catch {}
});

els.onboardingWifiApplyBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(els.onboardingWifiApplyBtn, "Sending Wi-Fi settings", () => {
      const values = formValues(els.onboardingWifiForm);
      return post("/api/onboarding/wifi/apply", {
        ...values,
        encryption: Number(values.encryption),
      });
    });
  } catch {}
});

els.onboardingBackWifiBtn.addEventListener("click", () => {
  setLocalOnboardingStep("wifi", "Choose the camera network.");
});

els.onboardingVerifyBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingVerifyBtn,
      "Verifying camera",
      () => post("/api/onboarding/verify", {}),
    );
  } catch {}
});

els.onboardingCompleteBtn.addEventListener("click", async () => {
  try {
    const result = await runOnboardingAction(els.onboardingCompleteBtn, "Applying initial camera setup", () => {
      const camera = formValues(els.onboardingCameraForm);
      const settings = formValues(els.onboardingSettingsForm);
      return post("/api/onboarding/complete", {
        ...camera,
        ...settings,
        ntpSwitch: Number(camera.ntpSwitch),
        videoResolution: Number(settings.videoResolution),
        nightVisionMode: Number(settings.nightVisionMode),
        recordVideo: Number(settings.recordVideo),
        recordSound: Number(settings.recordSound),
        loopCoverage: Number(settings.loopCoverage),
        sdCardRecordingDurationMinutes: Number(settings.sdCardRecordingDurationMinutes),
        wakeupMode: Number(settings.wakeupMode),
        lowPowerMode: Number(settings.lowPowerMode),
      });
    });
    state.onboardingCompleteShown = true;
    state.onboarding = result.onboarding || { required: false, step: "complete", message: "Setup complete." };
    applyConfigToForm(result.config || state.config);
    renderOnboarding({ ...state.onboarding, step: "complete" });
  } catch {}
});

els.onboardingOpenDashboardBtn.addEventListener("click", async () => {
  state.onboardingCompleteShown = false;
  await loadState();
  setActiveWorkspace("overviewWorkspace");
});

els.onboardingSetupWifiLaterBtn.addEventListener("click", async () => {
  try {
    await runOnboardingAction(
      els.onboardingSetupWifiLaterBtn,
      "Opening Wi-Fi setup",
      () => post("/api/onboarding/wifi/begin", {}),
    );
  } catch {}
});

els.startBtn.addEventListener("click", async () => {
  els.startBtn.disabled = true;
  setBusy(true, "Starting preview");
  try {
    await post("/api/start", buildStartPayload());
    await loadState();
  } finally {
    setBusy(false, "Starting preview");
    els.startBtn.disabled = false;
  }
});

els.stopBtn.addEventListener("click", async () => {
  els.stopBtn.disabled = true;
  setBusy(true, "Stopping preview");
  try {
    await post("/api/stop", {});
    await loadState();
  } finally {
    setBusy(false, "Stopping preview");
    els.stopBtn.disabled = false;
  }
});

els.applyBtn.addEventListener("click", async () => {
  els.applyBtn.disabled = true;
  els.applyStatus.textContent = "Applying...";
  setBusy(true, "Applying settings");
  try {
    const result = await post("/api/apply", buildApplyPayload());
    if (!result.ok) throw new Error(result.error || "Apply failed");
    await loadState();
    const appliedConfig = await loadAppliedConfig().catch(() => null);
    if (appliedConfig) {
      applyConfigToForm(appliedConfig);
      renderConfigState();
    }
    const lines = ["Applied successfully."];
    if (result.stderr) lines.push(result.stderr);
    if (result.stdout) lines.push(result.stdout);
    els.applyStatus.textContent = lines.join("\n").trim();
  } catch (err) {
    els.applyStatus.textContent = `Apply failed: ${err.message}`;
  } finally {
    setBusy(false, "Applying settings");
    els.applyBtn.disabled = false;
  }
});

function openSetupForm() {
  state.setupFormOpen = true;
  renderSetup(state.setup);
  els.setupApplyStatus.textContent = "Choose the setup options and apply them to the camera.";
}

els.setupOpenBtn.addEventListener("click", openSetupForm);

els.startupRetryBtn.addEventListener("click", async () => {
  renderStartupGate({ status: "refreshing" });
  try {
    const result = await post("/api/setup/refresh", {});
    if (!result.ok) throw new Error(result.error || "Camera check failed");
    renderStartupGate(result.setup);
  } catch (err) {
    renderStartupGate({
      status: "error",
      summary: err.message,
    });
  }
});

els.setupRefreshBtn.addEventListener("click", async () => {
  els.setupRefreshBtn.disabled = true;
  setBusy(true, "Checking setup");
  try {
    const result = await post("/api/setup/refresh", {});
    if (!result.ok) throw new Error(result.error || "Setup refresh failed");
    await loadState();
  } catch (err) {
    els.setupApplyStatus.textContent = `Refresh failed: ${err.message}`;
  } finally {
    setBusy(false, "Checking setup");
    els.setupRefreshBtn.disabled = false;
  }
});

els.setupApplyBtn.addEventListener("click", async () => {
  els.setupApplyBtn.disabled = true;
  els.setupApplyStatus.textContent = "Applying setup changes...";
  setBusy(true, "Applying setup");
  try {
    const result = await post("/api/setup/apply", currentSetupConfig(els.setupForm));
    if (!result.ok) throw new Error(result.error || "Setup apply failed");
    state.setupFormOpen = false;
    applyState({
      running: state.running,
      config: result.config || state.config,
      stats: state.running ? undefined : {
        inputBytes: 0, outputBytes: 0, deliveredFrames: 0, missingFrames: 0, gapCount: 0, maxGap: 0, waitingKeyframe: 0, prependedConfig: 0, estimatedDropRate: 0,
      },
      startedAt: state.running ? undefined : null,
      setup: result.setup || { status: "configured", needsSetup: false, reason: "configured", summary: "Setup changes applied. Live monitoring is ready." },
    });
    await ensurePreviewRunningForSetup();
    await loadState();
    const appliedConfig = await loadAppliedConfig().catch(() => null);
    if (appliedConfig) {
      applyConfigToForm(appliedConfig);
      renderConfigState();
    }
    const lines = ["Setup changes applied."];
    if (result.stderr) lines.push(result.stderr);
    if (result.stdout) lines.push(result.stdout);
    els.setupApplyStatus.textContent = lines.join("\n").trim();
  } catch (err) {
    els.setupApplyStatus.textContent = `Setup failed: ${err.message}`;
  } finally {
    setBusy(false, "Applying setup");
    els.setupApplyBtn.disabled = false;
  }
});

els.clearLogsBtn.addEventListener("click", () => {
  state.logs = [];
  filterLogs();
});

els.logFilterInput.addEventListener("input", filterLogs);
els.logPresetBtn.addEventListener("click", () => {
  els.logFilterInput.value = "camera";
  filterLogs();
});

els.configForm.addEventListener("input", renderConfigState);
els.configForm.addEventListener("change", renderConfigState);

if (!els.sdYear.value) {
  els.sdYear.value = String(new Date().getFullYear());
}

els.sdStatusBtn.addEventListener("click", async () => {
  els.sdStatusBtn.disabled = true;
  try {
    await querySd("/api/sd/status", null, "status", "Checking SD status");
  } catch (err) {
    els.sdStatus.textContent = err.message;
  } finally {
    els.sdStatusBtn.disabled = false;
  }
});

els.diagnosticsSdStatusBtn.addEventListener("click", () => els.sdStatusBtn.click());

els.sdDaysBtn.addEventListener("click", async () => {
  els.sdDaysBtn.disabled = true;
  try {
    await querySd("/api/sd/days", { year: Number(els.sdYear.value || new Date().getFullYear()) }, "days", "Loading recording dates");
  } catch (err) {
    els.sdStatus.textContent = err.message;
  } finally {
    els.sdDaysBtn.disabled = false;
  }
});

els.diagnosticsReloadDatesBtn.addEventListener("click", () => els.sdDaysBtn.click());

els.sdFilesBtn.addEventListener("click", async () => {
  els.sdFilesBtn.disabled = true;
  try {
    await ensureRecordingsLoaded({ force: true });
  } catch (err) {
    els.sdStatus.textContent = err.message;
  } finally {
    els.sdFilesBtn.disabled = false;
  }
});

els.recordingOpenDayBtn.addEventListener("click", async () => {
  els.recordingOpenDayBtn.disabled = true;
  try {
    await openSpecificRecordingDay();
  } catch (err) {
    els.sdStatus.textContent = err.message;
  } finally {
    els.recordingOpenDayBtn.disabled = false;
  }
});

els.recordingsModeDayBtn.addEventListener("click", async () => {
  state.ui.recordingsMode = "day";
  if (state.sd.selectedDay || els.sdDate.value) {
    try {
      await openSpecificRecordingDay(state.sd.selectedDay || els.sdDate.value);
    } catch (err) {
      els.sdStatus.textContent = err.message;
    }
  }
  renderRecordingsModeButtons();
});

els.recordingsModeBrowseBtn.addEventListener("click", async () => {
  state.ui.recordingsMode = "browse";
  await loadRecordingDayPage(state.sd.dayPage || 0);
});

els.recordingSort.addEventListener("change", renderRecordingFiles);
els.recordingTimeFilter.addEventListener("input", renderRecordingFiles);
els.recordingThumbSize.addEventListener("input", applyThumbnailSize);

els.recordingViewToggleBtn.addEventListener("click", () => {
  state.sd.view = state.sd.view === "grid" ? "list" : "grid";
  renderRecordingFiles();
});

els.recordingPrevBtn.addEventListener("click", () => loadRecordingDayPage(state.sd.dayPage - 1).catch((err) => {
  els.sdStatus.textContent = err.message;
}));

els.recordingNextBtn.addEventListener("click", () => loadRecordingDayPage(state.sd.dayPage + 1).catch((err) => {
  els.sdStatus.textContent = err.message;
}));

els.sdDays.addEventListener("click", async (event) => {
  const dayButton = event.target.closest("[data-record-day]");
  const downloadButton = event.target.closest("[data-download-day]");
  const deleteButton = event.target.closest("[data-delete-day]");
  if (dayButton) {
    els.sdDate.value = displayYmd(dayButton.dataset.recordDay);
    try {
      await openSpecificRecordingDay(dayButton.dataset.recordDay);
    } catch (err) {
      els.sdStatus.textContent = err.message;
    }
    return;
  }
  if (downloadButton) {
    await downloadRecordingGroup({ scope: "date", ymd: downloadButton.dataset.downloadDay }, `recordings for ${displayYmd(downloadButton.dataset.downloadDay)}`);
    return;
  }
  if (deleteButton) {
    const day = deleteButton.dataset.deleteDay;
    const ok = await deleteRecordingGroup({ scope: "date", ymd: day }, `recordings for ${displayYmd(day)}`);
    if (ok) {
      removeDayLocally(day);
      if (state.ui.recordingsMode === "browse") {
        await loadRecordingDayPage(state.sd.dayPage).catch(() => {});
      }
    }
  }
});

els.sdFiles.addEventListener("click", async (event) => {
  const playButton = event.target.closest(".recording-play");
  const downloadButton = event.target.closest(".recording-download");
  const deleteButton = event.target.closest(".recording-delete");
  const dayDownloadButton = event.target.closest(".recording-date-actions [data-download-day]");
  const dayDeleteButton = event.target.closest(".recording-date-actions [data-delete-day]");
  if (playButton) {
    playRecording(playButton.dataset.recordingFile, Number(playButton.dataset.recordingIndex));
    return;
  }
  if (downloadButton) {
    await downloadRecordingGroup({ scope: "file", file: downloadButton.dataset.recordingFile }, downloadButton.dataset.recordingFile);
    return;
  }
  if (deleteButton) {
    const ok = await deleteRecordingGroup({ scope: "file", file: deleteButton.dataset.recordingFile }, deleteButton.dataset.recordingFile);
    if (ok) {
      for (const group of state.sd.groupedFiles) {
        group.items = group.items.filter((item) => recordingFileParam(item) !== deleteButton.dataset.recordingFile);
      }
      state.sd.groupedFiles = state.sd.groupedFiles.filter((group) => group.items.length);
      renderRecordingFiles();
    }
    return;
  }
  if (dayDownloadButton) {
    await downloadRecordingGroup({ scope: "date", ymd: dayDownloadButton.dataset.downloadDay }, `recordings for ${displayYmd(dayDownloadButton.dataset.downloadDay)}`);
    return;
  }
  if (dayDeleteButton) {
    const day = dayDeleteButton.dataset.deleteDay;
    const ok = await deleteRecordingGroup({ scope: "date", ymd: day }, `recordings for ${displayYmd(day)}`);
    if (ok) {
      removeDayLocally(day);
      if (state.ui.recordingsMode === "browse") {
        await loadRecordingDayPage(state.sd.dayPage).catch(() => {});
      }
    }
  }
});

els.recordingDownloadAllBtn.addEventListener("click", () => downloadRecordingGroup({
  scope: "all",
  year: Number(els.sdYear.value || new Date().getFullYear()),
}, "all recordings"));
els.recordingDeleteAllBtn.addEventListener("click", async () => {
  const ok = await deleteRecordingGroup({
    scope: "all",
    year: Number(els.sdYear.value || new Date().getFullYear()),
  }, "all recordings");
  if (ok) {
    state.sd.days = [];
    state.sd.groupedFiles = [];
    renderRecordingDaysList();
    renderRecordingFiles();
  }
});

els.recordingNextModalBtn.addEventListener("click", playNextRecording);
els.recordingDownloadBtn.addEventListener("click", () => {
  if (!state.activeRecordingFile) return;
  downloadRecordingGroup({ scope: "file", file: state.activeRecordingFile }, state.activeRecordingFile);
});

for (const closeTarget of document.querySelectorAll("[data-recording-close]")) {
  closeTarget.addEventListener("click", closeRecordingModal);
}

els.recordingPlayer.addEventListener("loadeddata", () => {
  els.recordingPlayerStatus.textContent = els.recordingPlayer.dataset.playMode === "direct"
    ? "Playing through fast native transfer."
    : els.recordingPlayer.dataset.playMode === "seekable"
      ? "Ready. The full timeline is seekable."
      : els.recordingPlayer.dataset.playMode === "preparing"
        ? "Playing now. The seekable copy continues preparing in the background."
        : "Playing through compatibility mode.";
  if (els.recordingPlayer.dataset.playMode === "legacy") {
    releaseBusy("playback", "Opening compatibility playback");
  }
});

els.recordingPlayer.addEventListener("playing", () => {
  els.recordingPlayer.dataset.hasPlayed = "1";
});

els.recordingPlayer.addEventListener("timeupdate", () => {
  if (!els.recordingPlayer.seeking && !state.correctingRecordingSeek) {
    state.lastPlayableTime = els.recordingPlayer.currentTime;
  }
});

els.recordingPlayer.addEventListener("pointerdown", () => {
  state.recordingPointerTime = els.recordingPlayer.currentTime;
  state.recordingPointerAt = Date.now();
});

els.recordingPlayer.addEventListener("seeking", () => {
  if (!["direct", "preparing"].includes(els.recordingPlayer.dataset.playMode) || state.correctingRecordingSeek) return;
  const target = els.recordingPlayer.currentTime;
  let bufferedStart = 0;
  let bufferedEnd = 0;
  if (els.recordingPlayer.buffered.length) {
    bufferedStart = els.recordingPlayer.buffered.start(0);
    bufferedEnd = els.recordingPlayer.buffered.end(els.recordingPlayer.buffered.length - 1);
  }
  const timelineClick = Date.now() - state.recordingPointerAt < 1500;
  if (!timelineClick && Math.abs(target - state.lastPlayableTime) <= 2 && target >= bufferedStart && target <= bufferedEnd) return;
  state.correctingRecordingSeek = true;
  const restoreTime = timelineClick ? state.recordingPointerTime : state.lastPlayableTime;
  els.recordingPlayer.currentTime = Math.min(restoreTime, bufferedEnd || restoreTime);
  els.recordingPlayerStatus.textContent = `Timeline seeking is unavailable during fast progressive playback. Streamed through ${Math.floor(bufferedEnd / 60)}:${String(Math.floor(bufferedEnd % 60)).padStart(2, "0")}.`;
  requestAnimationFrame(() => {
    state.correctingRecordingSeek = false;
    els.recordingPlayer.play().catch(() => {});
  });
});

els.recordingPlayer.addEventListener("error", () => {
  if (!["direct", "preparing", "seekable"].includes(els.recordingPlayer.dataset.playMode) || !state.activeRecordingFile) return;
  if (els.recordingPlayer.dataset.hasPlayed === "1") {
    els.recordingPlayerStatus.textContent = "Fast stream stopped. Select the recording again to restart it.";
    return;
  }
  const activeFile = state.activeRecordingFile;
  (async () => {
    let reason = "Fast seekable playback was unavailable";
    try {
      const res = await fetch(`/api/recordings/play-status?file=${encodeURIComponent(activeFile)}`);
      const payload = await res.json();
      if (payload?.error) {
        reason = `Seekable copy unavailable: ${payload.error}`;
      } else if (payload?.status === "waiting") {
        reason = "Seekable copy is still waiting for the camera";
      }
    } catch {}
    if (state.activeRecordingFile !== activeFile) return;
    els.recordingPlayer.dataset.playMode = "legacy";
    els.recordingPlayerStatus.textContent = `${reason}. Retrying in compatibility mode...`;
    setBusyLabel("Opening compatibility playback");
    els.recordingPlayer.src = `/api/recordings/play-legacy?file=${encodeURIComponent(activeFile)}&ts=${Date.now()}`;
    els.recordingPlayer.play().catch(() => {});
  })();
});

const source = new EventSource("/events");
source.onmessage = (event) => {
  const payload = JSON.parse(event.data);
  if (payload.type === "log" && payload.entry?.line) {
    state.logs = [...state.logs, payload.entry].slice(-500);
    updateRecordingTaskProgress(payload.entry.line);
    filterLogs();
    return;
  }
  if (payload.type === "state") {
    applyState(payload);
  }
};

applyThumbnailSize();
renderWorkspace();
renderRecordingsModeButtons();
loadState().then(() => {
  state.recordingsPreloaded = true;
  maybeAutoStartReadyPreview(state.setup);
}).catch((err) => {
  els.statusMeta.textContent = err.message;
});
