import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS, normalizeConfig, toBool } from "./helpers/server/config.js";
import { buildControlActionGroups, buildSetupActionGroups, buildTimeSyncActionGroups } from "./helpers/server/cameraActions.js";
import { buildControlPythonArgs, buildFfmpegArgs, buildStreamPythonArgs } from "./helpers/server/pythonArgs.js";
import { readPersistedSetupState, writePersistedSetupState } from "./helpers/server/setupPersistence.js";
import { CAMERA_TIMEZONE, evaluateSetupFromDatetime, parseQueryJson } from "./helpers/server/setupStatus.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(__dirname, "public");
const CLIENT_HELPERS_DIR = path.join(__dirname, "helpers", "client");
const THUMB_DIR = path.join(__dirname, ".cache", "recording-thumbs");
const PLAYABLE_DIR = path.join(__dirname, ".cache", "recording-videos");
const PY_SCRIPT = path.join(ROOT, "homeeye_live_hevc.py");
const ANDROID_LIBS = path.join(ROOT, "android_compat_libs");
const CAMERA_NOT_DISCOVERED_MESSAGE =
  "Camera was not discovered. Check that this computer is connected to the same Wi-Fi network as the camera, then try again.";

const state = {
  running: false,
  desiredRunning: false,
  pipelineId: 0,
  config: { ...DEFAULTS },
  appliedConfig: null,
  recordParams: null,
  timedRecordParams: null,
  process: null,
  ffmpeg: null,
  startedAt: null,
  lastFrameAt: null,
  lastRestartAt: null,
  readErrorStreak: 0,
  restartTimer: null,
  stats: {
    inputBytes: 0,
    outputBytes: 0,
    deliveredFrames: 0,
    missingFrames: 0,
    gapCount: 0,
    maxGap: 0,
    waitingKeyframe: 0,
    prependedConfig: 0,
    lastSequence: null,
    lastHandle: null,
    lastError: "",
    lastWarning: "",
    estimatedDropRate: 0,
  },
  logs: [],
  clients: new Set(),
  videoClients: new Set(),
  sockets: new Set(),
  queryBusy: false,
  timeWatchBusy: false,
  lastTimeWatchAt: null,
  setup: {
    status: "idle",
    checkedAt: null,
    needsSetup: false,
    reason: "not_checked",
    summary: "Camera setup has not been checked yet.",
    cameraDatetime: null,
    targetTimezone: CAMERA_TIMEZONE,
  },
  onboarding: {
    required: true,
    step: "welcome",
    message: "Complete first-time setup before using the dashboard.",
    wifiNetworks: [],
    connectionMode: "unknown",
  },
};

const playableJobs = new Map();
fs.mkdirSync(PLAYABLE_DIR, { recursive: true });

function persistCurrentConfig(timestamp = new Date().toISOString()) {
  writePersistedSetupState({
    configured: true,
    did: state.config.did,
    configuredAt: timestamp,
    connectionMode: state.onboarding.connectionMode || "unknown",
    targetSsid: state.onboarding.targetSsid || "",
    config: {
      ...state.config,
      syncTimeNow: false,
      getDatetime: false,
    },
  });
}

const persistedSetupState = readPersistedSetupState();
if (persistedSetupState?.config) {
  state.config = normalizeConfig({ ...state.config, ...persistedSetupState.config, did: persistedSetupState.did || state.config.did });
}
state.onboarding = {
  required: persistedSetupState?.configured !== true,
  step: persistedSetupState?.onboardingStep || (persistedSetupState?.configured ? "complete" : "welcome"),
  message: persistedSetupState?.configured
    ? "Camera setup is complete."
    : "Complete first-time setup before using the dashboard.",
  wifiNetworks: [],
  connectionMode: persistedSetupState?.connectionMode || "unknown",
  targetSsid: persistedSetupState?.targetSsid || "",
};
state.appliedConfig = normalizeConfig({ ...state.config });

function persistOnboardingDraft(step = state.onboarding.step) {
  writePersistedSetupState({
    configured: false,
    did: state.config.did,
    onboardingStep: step,
    connectionMode: state.onboarding.connectionMode || "unknown",
    targetSsid: state.onboarding.targetSsid || "",
    config: { ...state.config },
  });
}

function updateOnboarding(step, message, extra = {}) {
  state.onboarding = {
    ...state.onboarding,
    required: step !== "complete",
    step,
    message,
    ...extra,
  };
  if (step !== "complete") persistOnboardingDraft(step);
  broadcastState();
}

function appendLog(line) {
  const entry = {
    ts: new Date().toISOString(),
    line: String(line).trimEnd(),
  };
  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.splice(0, state.logs.length - 500);
  }
  broadcast({ type: "log", entry });
}

function computeDropRate() {
  const seen = state.stats.deliveredFrames + state.stats.missingFrames;
  state.stats.estimatedDropRate = seen > 0 ? state.stats.missingFrames / seen : 0;
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of state.clients) {
    try {
      res.write(data);
    } catch {
      state.clients.delete(res);
    }
  }
}

function broadcastState() {
  computeDropRate();
  broadcast({
    type: "state",
    running: state.running,
    config: state.config,
    appliedConfig: state.appliedConfig,
    recordParams: state.recordParams,
    timedRecordParams: state.timedRecordParams,
    stats: state.stats,
    startedAt: state.startedAt,
    setup: state.setup,
    onboarding: state.onboarding,
  });
}

async function refreshSetupStatus(label = "refresh") {
  if (state.setup.status === "refreshing" || state.queryBusy) {
    return state.setup;
  }
  state.setup = {
    ...state.setup,
    status: "refreshing",
    summary: `Checking camera time for ${label}...`,
  };
  broadcastState();
  try {
    let result;
    try {
      result = await runPythonQuery([
        "--quiet",
        "--get-datetime-auto",
        "--did",
        state.config.did,
        "--user",
        state.config.user,
        "--pwd",
        state.config.pwd,
      ]);
    } catch (autoErr) {
      appendLog(`[setup] app datetime query failed, falling back: ${autoErr.message}`);
      result = await runPythonQuery([
        "--quiet",
        "--get-datetime",
        "--did",
        state.config.did,
        "--user",
        state.config.user,
        "--pwd",
        state.config.pwd,
      ]);
    }
    const parsed = parseQueryJson(result.stdout);
    const payload = parsed || { raw_text: result.stdout.trim() };
    const evaluation = evaluateSetupFromDatetime(payload, state.config.timezone || CAMERA_TIMEZONE);
    state.setup = {
      status: "ready",
      checkedAt: new Date().toISOString(),
      needsSetup: evaluation.needsSetup,
      reason: evaluation.reason,
      summary: evaluation.summary,
      cameraYear: evaluation.cameraYear,
      targetYear: evaluation.targetYear,
      cameraTime: evaluation.cameraTime,
      cameraTimezoneSec: evaluation.cameraTimezoneSec,
      targetTimezoneSec: evaluation.targetTimezoneSec,
      cameraDstSwitch: evaluation.cameraDstSwitch,
      targetDstSwitch: evaluation.targetDstSwitch,
      timeDeltaSeconds: evaluation.timeDeltaSeconds,
      cameraDatetime: payload,
      targetTimezone: state.config.timezone || CAMERA_TIMEZONE,
      details: evaluation,
    };
    appendLog(`[setup] ${state.setup.summary}`);
  } catch (err) {
    state.setup = {
      ...state.setup,
      status: "error",
      checkedAt: new Date().toISOString(),
      needsSetup: true,
      reason: "query_failed",
      summary: `Could not read camera time: ${err.message}`,
      cameraDatetime: null,
      targetTimezone: state.config.timezone || CAMERA_TIMEZONE,
    };
    appendLog(`[setup] ${state.setup.summary}`);
  }
  broadcastState();
  return state.setup;
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function clearRestartTimer() {
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
}

function schedulePipelineRestart(reason = "unexpected exit") {
  if (!state.desiredRunning || state.queryBusy || state.restartTimer) return;
  appendLog(`[server] scheduling restart after ${reason}`);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    if (!state.desiredRunning || state.queryBusy || state.running) return;
    startPipeline(state.config);
  }, 2000);
}

function stopPipeline(reason = "stopped", options = {}) {
  const { preserveDesiredRunning = false } = options;
  if (!preserveDesiredRunning) {
    state.desiredRunning = false;
  }
  clearRestartTimer();
  if (state.ffmpeg) {
    try {
      state.ffmpeg.kill("SIGTERM");
    } catch {}
    state.ffmpeg = null;
  }
  if (state.process) {
    try {
      state.process.kill("SIGTERM");
    } catch {}
    state.process = null;
  }
  state.running = false;
  state.startedAt = null;
  state.lastFrameAt = null;
  state.readErrorStreak = 0;
  for (const res of state.videoClients) {
    try {
      res.end();
    } catch {}
  }
  state.videoClients.clear();
  appendLog(`[server] ${reason}`);
  broadcastState();
}

function runPythonQuery(extraArgs) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    };
    const proc = spawn("python3", [PY_SCRIPT, "--quiet", ...extraArgs], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const details = stderr.trim() || stdout.trim() || `query exited with code ${code}`;
        const message = /PPCS_Connect failed:\s*-8\b/.test(details)
          ? CAMERA_NOT_DISCOVERED_MESSAGE
          : details;
        reject(new Error(message));
      }
    });
  });
}

function runHostCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function activeWifiNetworks() {
  try {
    const result = await runHostCommand("nmcli", ["-t", "--escape", "no", "-f", "ACTIVE,SSID,DEVICE", "dev", "wifi"]);
    return result.stdout.split(/\r?\n/).map((line) => {
      const parts = line.split(":");
      if (parts.length < 3 || parts[0] !== "yes") return null;
      return {
        ssid: parts.slice(1, -1).join(":"),
        device: parts.at(-1),
      };
    }).filter(Boolean);
  } catch (err) {
    appendLog(`[setup] host Wi-Fi discovery unavailable: ${err.message}`);
    return [];
  }
}

async function discoverSetupCamera() {
  updateOnboarding("discovering", "Looking for a camera hotspot connected to this computer...");
  const activeNetworks = await activeWifiNetworks();
  const hotspot = activeNetworks.find((network) => /^AYSA-/i.test(network.ssid));
  if (!hotspot) {
    updateOnboarding(
      "welcome",
      "No AYSA camera hotspot is connected. Connect this computer to the camera hotspot, then check again.",
      { activeNetworks },
    );
    return { ok: false, error: "No connected AYSA camera hotspot was found.", activeNetworks };
  }

  state.config = normalizeConfig({
    ...state.config,
    did: hotspot.ssid,
    user: state.config.user || "admin",
    pwd: state.config.pwd || "6666",
  });
  try {
    const result = await runPythonQuery(["--get-datetime-auto", ...cameraArgs()]);
    const payload = parsePythonPayload(result);
    updateOnboarding(
      "network_choice",
      `Camera ${hotspot.ssid} was found on its hotspot. Choose whether to keep using the hotspot or move it to Wi-Fi.`,
      {
        detectedHotspot: hotspot,
        camera: payload,
      },
    );
    return { ok: true, hotspot, camera: payload };
  } catch (err) {
    updateOnboarding(
      "camera_details",
      `The ${hotspot.ssid} hotspot was found, but camera login failed. Confirm its credentials.`,
      { detectedHotspot: hotspot },
    );
    return { ok: false, error: err.message, hotspot };
  }
}

async function runSdQuery(extraArgs, label) {
  if (state.queryBusy) {
    throw new Error("another camera query is already running");
  }
  state.queryBusy = true;
  const wasRunning = state.running && state.process && state.ffmpeg;
  const savedConfig = wasRunning ? { ...state.config } : null;
  if (wasRunning) {
    stopPipeline(`suspending for ${label}`);
  }
  try {
    const result = await runPythonQuery(extraArgs);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout.trim() || "{}");
    } catch {
      payload = { raw_text: result.stdout.trim() };
    }
    return { ok: true, payload, stderr: result.stderr.trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (savedConfig) {
      startPipeline(savedConfig);
    }
    state.queryBusy = false;
  }
}

async function runControlApply(cfg) {
  if (state.queryBusy) {
    throw new Error("another camera query is already running");
  }
  state.queryBusy = true;
  try {
    let lastResult = { stdout: "", stderr: "" };
    for (const args of buildControlActionGroups(cfg)) {
      lastResult = await runPythonQuery(args);
      appendLog(`[apply] python3 ${args.join(" ")}`);
      if (lastResult.stderr) {
        appendLog(`[apply] ${lastResult.stderr}`);
      }
    }
    appendLog("[apply] control settings applied");
    return { ok: true, stdout: lastResult.stdout.trim(), stderr: lastResult.stderr.trim() };
  } catch (err) {
    appendLog(`[apply] ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    state.queryBusy = false;
  }
}

async function runTimeSync(cfg) {
  if (state.queryBusy) {
    throw new Error("another camera query is already running");
  }
  state.queryBusy = true;
  try {
    let lastResult = { stdout: "", stderr: "" };
    for (const args of buildTimeSyncActionGroups(cfg)) {
      lastResult = await runPythonQuery(args);
      appendLog(`[time] python3 ${args.join(" ")}`);
      if (lastResult.stderr) {
        appendLog(`[time] ${lastResult.stderr}`);
      }
    }
    return { ok: true, stdout: lastResult.stdout.trim(), stderr: lastResult.stderr.trim() };
  } catch (err) {
    appendLog(`[time] ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    state.queryBusy = false;
  }
}

async function runSetupApply(body) {
  const current = normalizeConfig(state.config);
  const setupOptions = {
    syncTimeNow: toBool(body.syncTimeNow ?? true),
    disableNightVision: toBool(body.disableNightVision ?? false),
    disableRecording: toBool(body.disableRecording ?? false),
    turnOffSleep: toBool(body.turnOffSleep ?? false),
    lowPowerMode: body.lowPowerMode == null ? current.lowPowerMode : Number(body.lowPowerMode),
    videoResolution: body.videoResolution == null ? current.videoResolution : Number(body.videoResolution),
    timeHour: body.timeHour == null ? current.timeHour : Number(body.timeHour),
    quality: String(body.quality || current.quality || ""),
    stream: body.stream == null ? current.stream : Number(body.stream),
  };

  const nextConfig = normalizeConfig({
    ...current,
    ...body,
    quality: setupOptions.quality,
    stream: setupOptions.stream,
    videoResolution: setupOptions.videoResolution,
    timeHour: setupOptions.timeHour,
    lowPowerMode: setupOptions.lowPowerMode,
    nightVisionMode: setupOptions.disableNightVision ? 0 : current.nightVisionMode,
    recordVideo: setupOptions.disableRecording ? 0 : current.recordVideo,
    wakeupMode: setupOptions.turnOffSleep ? 0 : current.wakeupMode,
    syncTimeNow: setupOptions.syncTimeNow,
  });
  let result;
  if (state.queryBusy) {
    throw new Error("another camera query is already running");
  }
  state.queryBusy = true;
  try {
    let lastResult = { stdout: "", stderr: "" };
    for (const args of buildSetupActionGroups(nextConfig, { syncTimeNow: setupOptions.syncTimeNow })) {
      lastResult = await runPythonQuery(args);
      appendLog(`[setup] python3 ${args.join(" ")}`);
      if (lastResult.stderr) {
        appendLog(`[setup] ${lastResult.stderr}`);
      }
    }
    result = { ok: true, stdout: lastResult.stdout.trim(), stderr: lastResult.stderr.trim() };
  } catch (err) {
    appendLog(`[setup] ${err.message}`);
    result = { ok: false, error: err.message };
  } finally {
    state.queryBusy = false;
  }
  if (result.ok) {
    state.config = {
      ...nextConfig,
      syncTimeNow: false,
      getDatetime: false,
    };
    state.setup = {
      ...state.setup,
      status: "configured",
      checkedAt: new Date().toISOString(),
      needsSetup: false,
      reason: "configured",
      summary: "Setup changes applied. Live monitoring is ready.",
      targetTimezone: nextConfig.timezone || CAMERA_TIMEZONE,
    };
    state.onboarding = {
      required: false,
      step: "complete",
      message: "First-time setup is complete.",
      wifiNetworks: [],
      connectionMode: state.onboarding.connectionMode || "unknown",
    };
    persistCurrentConfig(state.setup.checkedAt);
    try {
      await queryAppliedConfig();
    } catch (liveErr) {
      appendLog(`[setup] applied config refresh failed: ${liveErr.message}`);
      state.appliedConfig = state.config;
    }
    broadcastState();
  }
  return { ...result, config: state.config, setup: state.setup };
}

async function ensureValidCameraSetup(label = "setup health check") {
  if (state.queryBusy) {
    return state.setup;
  }
  const setup = await refreshSetupStatus(label);
  if (!setup.needsSetup) {
    return setup;
  }
  const result = await runTimeSync(state.config);
  if (result.ok) {
    return refreshSetupStatus(`${label} after sync`);
  }
  return setup;
}

function startPipeline(nextConfig) {
  state.desiredRunning = true;
  clearRestartTimer();
  stopPipeline("restarting", { preserveDesiredRunning: true });
  state.pipelineId += 1;
  const pipelineId = state.pipelineId;
  state.config = normalizeConfig({ ...state.config, ...nextConfig });
  state.lastRestartAt = new Date().toISOString();
  state.lastFrameAt = null;
  state.readErrorStreak = 0;
  state.stats = {
    inputBytes: 0,
    outputBytes: 0,
    deliveredFrames: 0,
    missingFrames: 0,
    gapCount: 0,
    maxGap: 0,
    waitingKeyframe: 0,
    prependedConfig: 0,
    lastSequence: null,
    lastHandle: null,
    lastError: "",
    lastWarning: "",
    estimatedDropRate: 0,
  };

  const pythonEnv = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const streamArgs = buildStreamPythonArgs(PY_SCRIPT, state.config);
  const ffmpegArgs = buildFfmpegArgs(state.config);
  const py = spawn("python3", streamArgs, {
    cwd: ROOT,
    env: pythonEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ff = spawn("ffmpeg", ffmpegArgs, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  state.process = py;
  state.ffmpeg = ff;
  state.running = true;
  state.startedAt = new Date().toISOString();

  py.stdout.pipe(ff.stdin);

  py.stderr.setEncoding("utf8");
  ff.stderr.setEncoding("utf8");

  py.stderr.on("data", (chunk) => {
    if (pipelineId !== state.pipelineId) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      appendLog(`[py] ${line}`);
      if (line.startsWith("handle=")) {
        state.stats.lastHandle = line.slice("handle=".length);
      } else if (line.startsWith("read ret=-")) {
        state.readErrorStreak += 1;
        const stalledForMs = state.lastFrameAt ? (Date.now() - Date.parse(state.lastFrameAt)) : Number.POSITIVE_INFINITY;
        if (state.readErrorStreak >= 10 && stalledForMs >= 3000) {
          appendLog("[server] stream read stalled, restarting pipeline");
          setTimeout(() => {
            if (state.process === py && state.ffmpeg === ff) {
              startPipeline(state.config);
            }
          }, 0);
        }
      } else if (line.startsWith("seq_gap=")) {
        const m = line.match(/seq_gap=\d+->\d+ missing=(\d+)/);
        if (m) {
          const missing = Number(m[1]);
          state.stats.gapCount += 1;
          state.stats.missingFrames += missing;
          state.stats.maxGap = Math.max(state.stats.maxGap, missing);
        }
      } else if (line.startsWith("in=") && line.includes(" hevc=")) {
        state.readErrorStreak = 0;
        state.lastFrameAt = new Date().toISOString();
        state.stats.deliveredFrames += 1;
        const m = line.match(/in=\d+ hevc=(\d+)/);
        if (m) state.stats.outputBytes = Number(m[1]);
      } else if (line.startsWith("waiting_keyframe=1")) {
        state.stats.waitingKeyframe += 1;
      } else if (line.startsWith("prepended_hevc_config=1")) {
        state.stats.prependedConfig += 1;
      } else if (line.startsWith("in=")) {
        const m = line.match(/in=(\d+)/);
        if (m) state.stats.inputBytes = Number(m[1]);
      } else if (line.includes("error") || line.includes("Error") || line.includes("Traceback")) {
        state.stats.lastError = line;
      } else if (line.includes("warning") || line.includes("Warning")) {
        state.stats.lastWarning = line;
      }
    }
    computeDropRate();
    broadcastState();
  });

  ff.stderr.on("data", (chunk) => {
    if (pipelineId !== state.pipelineId) return;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      appendLog(`[ffmpeg] ${line}`);
      if (line.toLowerCase().includes("error")) {
        state.stats.lastError = line;
      } else if (line.toLowerCase().includes("warning")) {
        state.stats.lastWarning = line;
      }
    }
    broadcastState();
  });

  ff.stdout.on("data", (chunk) => {
    if (pipelineId !== state.pipelineId) return;
    state.lastFrameAt = new Date().toISOString();
    for (const res of state.videoClients) {
      try {
        res.write(chunk);
      } catch {
        state.videoClients.delete(res);
      }
    }
  });

  const cleanup = (origin) => (code, signal) => {
    if (pipelineId !== state.pipelineId) {
      appendLog(`[server] ignoring stale ${origin} exit code=${code} signal=${signal || ""}`.trim());
      return;
    }
    appendLog(`[server] ${origin} exited code=${code} signal=${signal || ""}`.trim());
    if (state.process === py) state.process = null;
    if (state.ffmpeg === ff) state.ffmpeg = null;
    state.running = false;
    state.startedAt = null;
    broadcastState();
    for (const res of state.videoClients) {
      try {
        res.end();
      } catch {}
    }
    state.videoClients.clear();
    schedulePipelineRestart(`${origin} exit`);
  };

  py.on("exit", cleanup("python"));
  ff.on("exit", cleanup("ffmpeg"));

  py.on("error", (err) => {
    if (pipelineId !== state.pipelineId) return;
    appendLog(`[py] ${err.message}`);
    state.stats.lastError = err.message;
    broadcastState();
  });
  ff.on("error", (err) => {
    if (pipelineId !== state.pipelineId) return;
    appendLog(`[ffmpeg] ${err.message}`);
    state.stats.lastError = err.message;
    broadcastState();
  });

  appendLog(`[server] started`);
  appendLog(`[server] python3 ${streamArgs.slice(1).join(" ")}`);
  appendLog(`[server] ffmpeg ${ffmpegArgs.join(" ")}`);
  broadcastState();
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}

function sanitizeRecordingFile(file) {
  const filename = String(file || "").trim();
  if (!filename || filename.includes("/") || filename.includes("\\") || !/^[\w.-]+$/.test(filename)) {
    throw new Error("file is required");
  }
  return filename;
}

function thumbPathFor(filename) {
  return path.join(THUMB_DIR, `${filename}.jpg`);
}

function cameraRecordListDate(ymd) {
  return `${ymd.slice(0, 4)}_${ymd.slice(4, 6)}_${ymd.slice(6, 8)}`;
}

function cameraArgs() {
  return ["--did", state.config.did, "--user", state.config.user, "--pwd", state.config.pwd];
}

function parsePythonPayload(result) {
  return JSON.parse(result.stdout.trim() || "{}");
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function mergeAppliedConfig(baseConfig, parmsPayload, recordPayload) {
  const parms = parmsPayload?.json || {};
  const record = recordPayload?.json || {};
  const timed = recordPayload?.timedJson || {};
  const timedModel = Array.isArray(timed.tpModelArray) ? timed.tpModelArray[0] || {} : {};
  return normalizeConfig({
    ...baseConfig,
    videoResolution: firstDefined(parms.video_resolution, parms.videoResolution, baseConfig.videoResolution),
    timeHour: firstDefined(parms.timeHour, baseConfig.timeHour),
    nightVisionMode: firstDefined(parms.icut, parms.night_vision_mode, baseConfig.nightVisionMode),
    lowPowerMode: firstDefined(parms.low_power_mode, parms.lowPowerMode, baseConfig.lowPowerMode),
    recordVideo: firstDefined(record.videoRecord, baseConfig.recordVideo),
    wakeupMode: firstDefined(record.wakeup_mode, baseConfig.wakeupMode),
    recordMode: firstDefined(formatRecordMode(timed.timedrecord_programme), baseConfig.recordMode),
    recordSound: firstDefined(record.record_sound, baseConfig.recordSound),
    recordSoundDuringWakeUpPeriod: firstDefined(record.record_sound_during_wake_up_period, baseConfig.recordSoundDuringWakeUpPeriod),
    loopCoverage: firstDefined(record.loop_coverage, baseConfig.loopCoverage),
    sdCardRecordingDurationMinutes: firstDefined(record.sd_card_recording_duration_minutes, baseConfig.sdCardRecordingDurationMinutes),
    alarmRecordingDurationSeconds: firstDefined(record.alarm_recording_duration_s, baseConfig.alarmRecordingDurationSeconds),
    alarmRecordingIntervalSeconds: firstDefined(record.alarm_recording_interval_s, baseConfig.alarmRecordingIntervalSeconds),
    timedRecordStart: firstDefined(formatClockValue(timedModel.RepeatPro_StartTimeInt), baseConfig.timedRecordStart),
    timedRecordEnd: firstDefined(formatClockValue(timedModel.RepeatPro_EndTimeInt), baseConfig.timedRecordEnd),
    timedRecordDays: firstDefined(formatDaysMask(timedModel.periodArray), baseConfig.timedRecordDays),
    timedRecordEnable: firstDefined(timedModel.timedrecordRepeatSwitch, baseConfig.timedRecordEnable),
  });
}

function formatClockValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  const hh = String(Math.floor(num / 100)).padStart(2, "0");
  const mm = String(num % 100).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatDaysMask(periodArray) {
  if (!Array.isArray(periodArray) || !periodArray.length) return "1111111";
  const days = new Set();
  for (const entry of periodArray) {
    const day = Number(entry?.weekInt);
    if (day >= 1 && day <= 7) days.add(day);
  }
  return Array.from({ length: 7 }, (_, index) => (days.has(index + 1) ? "1" : "0")).join("");
}

function formatRecordMode(value) {
  return {
    0: "privacy",
    1: "full_day",
    2: "alarm",
    3: "timed",
    privacy: "privacy",
    full_day: "full_day",
    alarm: "alarm",
    timed: "timed",
  }[value] || "full_day";
}

async function queryAppliedConfig() {
  if (state.queryBusy) {
    throw new Error("another camera query is already running");
  }
  state.queryBusy = true;
  try {
    const parmsResult = await runPythonQuery(["--get-parms-auto", ...cameraArgs()]);
    const recordResult = await runPythonQuery(["--get-record-param", ...cameraArgs()]);
    const timedResult = await runPythonQuery(["--get-timed-record-para", ...cameraArgs()]);
    const appliedConfig = mergeAppliedConfig(
      state.config,
      parsePythonPayload(parmsResult),
      parsePythonPayload(recordResult),
      { ...parsePythonPayload(timedResult), timedJson: parsePythonPayload(timedResult) },
    );
    state.appliedConfig = appliedConfig;
    state.recordParams = parsePythonPayload(recordResult);
    state.timedRecordParams = parsePythonPayload(timedResult);
    broadcastState();
    return appliedConfig;
  } finally {
    state.queryBusy = false;
  }
}

function recordingFilesFromPayload(payload) {
  const json = payload?.json || {};
  const files = [];
  const count = Number(json.record_num || 0);
  for (let index = 0; index < count; index += 1) {
    const value = json[`record_name[${index}]`];
    if (!value) continue;
    try {
      files.push(sanitizeRecordingFile(value));
    } catch {}
  }
  return [...new Set(files)];
}

async function listRecordingFiles(ymd) {
  const result = await runPythonQuery([
    "--sd-record-list", cameraRecordListDate(ymd),
    ...cameraArgs(),
  ]);
  return recordingFilesFromPayload(parsePythonPayload(result));
}

async function listRecordingDays(year) {
  const result = await runPythonQuery(["--sd-record-day", String(year), ...cameraArgs()]);
  const payload = parsePythonPayload(result);
  const json = payload?.json || {};
  const days = [];
  for (let month = 0; month < 12; month += 1) {
    const mask = Number(json[`month[${month}]`] || 0);
    for (let day = 1; day <= 31; day += 1) {
      if (mask & (1 << (day - 1))) {
        days.push(`${year}${String(month + 1).padStart(2, "0")}${String(day).padStart(2, "0")}`);
      }
    }
  }
  return days;
}

async function resolveRecordingSelection(body) {
  // Accept the pre-scope client payloads so an already-open dashboard remains usable after a server update.
  if (!body.scope && Array.isArray(body.files)) {
    return [...new Set(body.files.map(sanitizeRecordingFile))];
  }
  if (!body.scope && body.day) {
    body = { ...body, scope: "date", ymd: body.day };
  }
  if (!body.scope && body.all) {
    body = { ...body, scope: "all", year: body.year || new Date().getFullYear() };
  }
  if (body.scope === "file") {
    return [sanitizeRecordingFile(body.file)];
  }
  if (body.scope === "date") {
    const ymd = String(body.ymd || "");
    if (!/^\d{8}$/.test(ymd)) throw new Error("ymd must be YYYYMMDD");
    return listRecordingFiles(ymd);
  }
  if (body.scope === "all") {
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new Error("valid year is required");
    const days = await listRecordingDays(year);
    const groups = [];
    for (const ymd of days) groups.push(await listRecordingFiles(ymd));
    return [...new Set(groups.flat())];
  }
  throw new Error("scope must be file, date, or all");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, options);
    let stderr = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function saveRecordingMp4(filename, outputPath, onProgress = () => {}) {
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const py = spawn("python3", [
    PY_SCRIPT, "--quiet", "--record-play-file", filename, "--no-wait-keyframe",
    "--out", "-", ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
  ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-f", "hevc", "-i", "pipe:0",
    "-an", "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "ultrafast",
    "-crf", "32", "-movflags", "+faststart", "-y", outputPath,
  ], { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"] });
  let inputBytes = 0;
  py.stdout.on("data", (chunk) => {
    inputBytes += chunk.length;
    onProgress(inputBytes);
  });
  py.stdout.pipe(ff.stdin);
  let pyError = "";
  py.stderr.setEncoding("utf8");
  py.stderr.on("data", (chunk) => { pyError += chunk; });
  try {
    await new Promise((resolve, reject) => {
      ff.stderr.setEncoding("utf8");
      let ffError = "";
      ff.stderr.on("data", (chunk) => { ffError += chunk; });
      py.on("error", reject);
      ff.on("error", reject);
      ff.on("exit", (code) => code === 0
        ? resolve()
        : reject(new Error(ffError.trim() || pyError.trim() || `recording conversion exited with code ${code}`)));
    });
  } finally {
    if (!py.killed) py.kill("SIGTERM");
    if (!ff.killed) ff.kill("SIGTERM");
  }
}

async function saveRecordingHevc(filename, outputPath, onProgress = () => {}) {
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const py = spawn("python3", [
    PY_SCRIPT, "--quiet", "--record-play-file", filename, "--no-wait-keyframe",
    "--out", outputPath, ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
  ], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
  let pyError = "";
  py.stderr.setEncoding("utf8");
  py.stderr.on("data", (chunk) => { pyError += chunk; });
  const progressTimer = setInterval(() => {
    try {
      onProgress(fs.statSync(outputPath).size);
    } catch {}
  }, 500);
  try {
    await new Promise((resolve, reject) => {
      py.on("error", reject);
      py.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(pyError.trim() || `recording export exited with code ${code}`));
      });
    });
  } finally {
    clearInterval(progressTimer);
    try {
      onProgress(fs.statSync(outputPath).size);
    } catch {}
  }
}

async function saveRecordingOriginal(filename, outputPath, onProgress = () => {}) {
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const py = spawn("python3", [
    PY_SCRIPT, "--quiet", "--record-download-file", filename,
    "--out", outputPath, ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
  ], { cwd: ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
  let pyError = "";
  let totalBytes = 0;
  py.stderr.setEncoding("utf8");
  py.stderr.on("data", (chunk) => {
    pyError += chunk;
    const match = pyError.match(/download_total=(\d+)/);
    if (match) totalBytes = Number(match[1]);
  });
  const progressTimer = setInterval(() => {
    try {
      onProgress(fs.statSync(outputPath).size, totalBytes);
    } catch {}
  }, 500);
  try {
    await new Promise((resolve, reject) => {
      py.on("error", reject);
      py.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(pyError.trim() || `native recording download exited with code ${code}`));
      });
    });
  } finally {
    clearInterval(progressTimer);
    try {
      onProgress(fs.statSync(outputPath).size, totalBytes);
    } catch {}
  }
}

function recordingDurationMs(filename) {
  const seconds = Number(String(filename).match(/_(\d+)_S(?:\.|$)/i)?.[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

async function withExclusiveCamera(label, operation) {
  if (state.queryBusy) throw new Error("another camera operation is already running");
  state.queryBusy = true;
  const savedConfig = state.running && state.process && state.ffmpeg ? { ...state.config } : null;
  if (savedConfig) stopPipeline(`suspending for ${label}`, { preserveDesiredRunning: true });
  try {
    return await operation();
  } finally {
    state.queryBusy = false;
    if (savedConfig && !state.running) startPipeline(savedConfig);
  }
}

async function deleteRecordings(files) {
  const deleted = [];
  const failed = [];
  for (let index = 0; index < files.length; index += 1) {
    const filename = files[index];
    appendLog(`[recordings] delete ${index + 1}/${files.length} ${filename}`);
    try {
      await runPythonQuery(["--delete-record-file", filename, ...cameraArgs()]);
      deleted.push(filename);
      fs.rmSync(thumbPathFor(filename), { force: true });
    } catch (err) {
      failed.push({ file: filename, error: err.message });
    }
  }
  return { deleted, failed };
}

function playablePaths(filename) {
  const stem = path.parse(filename).name;
  return {
    final: path.join(PLAYABLE_DIR, `${stem}-browser.mp4`),
    part: path.join(PLAYABLE_DIR, `${stem}-browser.mp4.part`),
  };
}

function ensurePlayableRecording(filename) {
  const paths = playablePaths(filename);
  if (fs.existsSync(paths.final)) return { status: "ready", ...paths, promise: Promise.resolve() };
  const existing = playableJobs.get(filename);
  if (existing) return existing;

  const job = { status: "preparing", error: "", bytes: 0, ...paths, promise: null };
  playableJobs.set(filename, job);
  fs.rmSync(paths.part, { force: true });
  job.promise = (async () => {
    const waitDeadline = Date.now() + 30_000;
    while (state.queryBusy && Date.now() < waitDeadline) {
      job.status = "waiting";
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (state.queryBusy) throw new Error("camera remained busy for 30 seconds");
    job.status = "preparing";
    return withExclusiveCamera("seekable recording preparation", async () => {
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
    };
    const py = spawn("python3", [
      PY_SCRIPT, "--quiet", "--record-download-file", filename, "--out", "-",
      ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
    ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-an",
      "-vf", "scale=640:-2", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
      "-crf", "32", "-g", "24", "-keyint_min", "24",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-frag_duration", "1000000", "-flush_packets", "1", "-f", "mp4", "-y", paths.part,
    ], { cwd: ROOT, stdio: ["pipe", "ignore", "pipe"] });
    py.stdout.pipe(ff.stdin);
    ff.stdin.on("error", (err) => {
      if (err.code !== "EPIPE") appendLog(`[recordings cache input] ${err.message}`);
    });
    let errors = "";
    py.stderr.setEncoding("utf8");
    ff.stderr.setEncoding("utf8");
    py.stderr.on("data", (chunk) => { errors += chunk; });
    ff.stderr.on("data", (chunk) => { errors += chunk; });
    const sizeTimer = setInterval(() => {
      try {
        job.bytes = fs.statSync(paths.part).size;
        appendLog(`[recordings] cache ${filename} bytes=${job.bytes}`);
      } catch {}
    }, 1000);
    try {
      await new Promise((resolve, reject) => {
        py.on("error", reject);
        ff.on("error", reject);
        ff.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(errors.trim() || `recording cache conversion exited with code ${code}`));
        });
      });
    } finally {
      clearInterval(sizeTimer);
      if (!py.killed && py.exitCode === null) py.kill("SIGTERM");
      if (!ff.killed && ff.exitCode === null) ff.kill("SIGTERM");
    }
    fs.renameSync(paths.part, paths.final);
    job.bytes = fs.statSync(paths.final).size;
    job.status = "ready";
    appendLog(`[recordings] cache ready ${filename} bytes=${job.bytes}`);
    });
  })().catch((err) => {
    job.status = "failed";
    job.error = err.message;
    fs.rmSync(paths.part, { force: true });
    appendLog(`[recordings cache] ${filename}: ${err.message}`);
    throw err;
  }).finally(() => {
    setTimeout(() => playableJobs.delete(filename), 60_000);
  });
  job.promise.catch(() => {});
  return job;
}

function serveRecordingFile(req, res, filePath) {
  const size = fs.statSync(filePath).size;
  const match = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = size - 1;
  if (match) {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isFinite(start) || start < 0 || start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
  }
  res.writeHead(match ? 206 : 200, {
    "Content-Type": "video/mp4",
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
    ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    "Cache-Control": "private, max-age=3600",
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

async function streamGrowingRecording(req, res, job) {
  let offset = 0;
  let closed = false;
  res.on("close", () => { closed = true; });
  res.on("error", () => { closed = true; });

  while (!closed) {
    const currentPath = fs.existsSync(job.final) ? job.final : job.part;
    let size = 0;
    try {
      size = fs.statSync(currentPath).size;
    } catch {}
    if (size > offset) {
      await new Promise((resolve) => {
        const stream = fs.createReadStream(currentPath, { start: offset, end: size - 1 });
        stream.on("error", resolve);
        stream.on("end", resolve);
        stream.pipe(res, { end: false });
      });
      offset = size;
      continue;
    }
    if (job.status === "ready") {
      if (!res.writableEnded && !res.destroyed) res.end();
      return;
    }
    if (job.status === "failed") {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: job.error });
      else if (!res.writableEnded) res.end();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function serveSeekableRecording(req, res, file) {
  let filename;
  try {
    filename = sanitizeRecordingFile(file);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }
  const job = ensurePlayableRecording(filename);
  if (job.status === "ready") {
    serveRecordingFile(req, res, job.final);
    return;
  }
  if (req.headers.range) {
    try {
      await job.promise;
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
      return;
    }
    if (!res.destroyed) serveRecordingFile(req, res, job.final);
    return;
  }
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
  });
  await streamGrowingRecording(req, res, job);
}

function proxyRecording(req, res, file, asDownload, nativeTransfer = true) {
  let filename;
  try {
    filename = sanitizeRecordingFile(file);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }

  const wasRunning = state.running && state.process && state.ffmpeg;
  const savedConfig = wasRunning ? { ...state.config } : null;
  if (wasRunning) {
    stopPipeline("suspending for recording playback", { preserveDesiredRunning: true });
  }

  appendLog(`[recordings] ${nativeTransfer ? "direct play" : "legacy play"} ${filename}`);
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const pyArgs = nativeTransfer
    ? [
      PY_SCRIPT, "--quiet", "--record-download-file", filename, "--out", "-",
      ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
    ]
    : [
      PY_SCRIPT, "--quiet", "--record-play-file", filename, "--no-wait-keyframe", "--out", "-",
      ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
    ];
  const py = spawn("python3", pyArgs, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ffInputArgs = nativeTransfer ? ["-i", "pipe:0"] : ["-f", "hevc", "-i", "pipe:0"];
  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    ...ffInputArgs,
    "-an",
    "-vf",
    "scale=640:-2",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-crf",
    "32",
    "-g",
    "24",
    "-keyint_min",
    "24",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "pipe:1",
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  py.stdout.pipe(ff.stdin);
  ff.stdin.on("error", (err) => {
    if (err.code !== "EPIPE") appendLog(`[recordings ffmpeg input] ${err.message}`);
  });
  py.stderr.setEncoding("utf8");
  ff.stderr.setEncoding("utf8");
  py.stderr.on("data", (chunk) => appendLog(`[recordings py] ${String(chunk).trim()}`));
  ff.stderr.on("data", (chunk) => appendLog(`[recordings ffmpeg] ${String(chunk).trim()}`));

  const headers = {
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
  };
  if (asDownload) {
    headers["Content-Disposition"] = `attachment; filename="${filename.replace(/\.mp4$/i, "")}-browser.mp4"`;
  }
  res.writeHead(200, headers);
  ff.stdout.pipe(res);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    ff.stdout.unpipe(res);
    if (!py.killed) py.kill("SIGTERM");
    if (!ff.killed) ff.kill("SIGTERM");
    if (savedConfig) {
      setTimeout(() => {
        if (!state.running) startPipeline(savedConfig);
      }, 1000);
    }
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("error", (err) => {
    if (err.code !== "ERR_STREAM_WRITE_AFTER_END" && err.code !== "EPIPE") {
      appendLog(`[recordings response] ${err.message}`);
    }
    cleanup();
  });
  py.on("error", (err) => appendLog(`[recordings py] ${err.message}`));
  ff.on("error", (err) => appendLog(`[recordings ffmpeg] ${err.message}`));
  py.on("exit", (code, signal) => appendLog(`[recordings py] exited code=${code} signal=${signal || ""}`.trim()));
  ff.on("exit", (code, signal) => {
    appendLog(`[recordings ffmpeg] exited code=${code} signal=${signal || ""}`.trim());
    if (!res.writableEnded && !res.destroyed) res.end();
  });
}

function downloadOriginalRecording(req, res, file) {
  let filename;
  try {
    filename = sanitizeRecordingFile(file);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }
  if (state.queryBusy) {
    sendJson(res, 409, { ok: false, error: "camera is busy" });
    return;
  }
  state.queryBusy = true;
  const savedConfig = state.running && state.process && state.ffmpeg ? { ...state.config } : null;
  if (savedConfig) stopPipeline("suspending for native recording download", { preserveDesiredRunning: true });
  appendLog(`[recordings] direct download ${filename}`);
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const py = spawn("python3", [
    PY_SCRIPT, "--quiet", "--record-download-file", filename, "--out", "-",
    ...cameraArgs(), "--read-timeout", "1000", "--check-buffer",
  ], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let bytes = 0;
  let stderr = "";
  py.stderr.setEncoding("utf8");
  py.stderr.on("data", (chunk) => { stderr += chunk; });
  py.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    appendLog(`[recordings] direct progress ${filename} bytes=${bytes}`);
  });
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  py.stdout.pipe(res);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.queryBusy = false;
    if (savedConfig && !state.running) {
      setTimeout(() => {
        if (!state.running) startPipeline(savedConfig);
      }, 1000);
    }
  };
  res.on("close", () => {
    if (!py.killed && py.exitCode === null) py.kill("SIGTERM");
    cleanup();
  });
  py.on("error", (err) => {
    appendLog(`[recordings direct] ${err.message}`);
    if (!res.writableEnded) res.end();
    cleanup();
  });
  py.on("exit", (code) => {
    if (code !== 0) appendLog(`[recordings direct] ${stderr.trim() || `exited with code ${code}`}`);
    if (!res.writableEnded) res.end();
    cleanup();
  });
}

function proxyRecordingThumbnail(req, res, file) {
  let filename;
  try {
    filename = sanitizeRecordingFile(file);
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
    return;
  }
  const cachedPath = thumbPathFor(filename);
  if (fs.existsSync(cachedPath)) {
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    });
    fs.createReadStream(cachedPath).pipe(res);
    return;
  }
  if (state.queryBusy) {
    sendJson(res, 409, { ok: false, error: "camera is busy" });
    return;
  }
  state.queryBusy = true;
  appendLog(`[recordings] thumbnail ${filename}`);
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: [ANDROID_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
  };
  const py = spawn("python3", [
    PY_SCRIPT,
    "--quiet",
    "--record-play-file",
    filename,
    "--no-wait-keyframe",
    "--out",
    "-",
    "--did",
    state.config.did,
    "--user",
    state.config.user,
    "--pwd",
    state.config.pwd,
    "--read-timeout",
    "1000",
  ], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const ff = spawn("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "hevc",
    "-i",
    "pipe:0",
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-2",
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "pipe:1",
  ], {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = [];
  let total = 0;
  let ffDone = false;
  let pyDone = false;
  let responseFinished = false;
  let cancelled = false;
  const terminate = (proc) => {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 500).unref();
  };
  const timer = setTimeout(() => {
    terminate(py);
    terminate(ff);
  }, 12000);
  py.stdout.pipe(ff.stdin);
  ff.stdout.on("data", (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  });
  const cleanup = () => {
    if (responseFinished) return;
    responseFinished = true;
    clearTimeout(timer);
    state.queryBusy = false;
  };
  const finish = () => {
    if (!ffDone || !pyDone || responseFinished) return;
    cleanup();
    if (cancelled || res.destroyed || res.writableEnded) return;
    if (total > 0) {
      fs.mkdirSync(THUMB_DIR, { recursive: true });
      fs.writeFileSync(cachedPath, Buffer.concat(chunks));
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(Buffer.concat(chunks));
      return;
    }
    sendJson(res, 502, { ok: false, error: "thumbnail failed" });
  };
  ff.on("exit", () => {
    ffDone = true;
    terminate(py);
    finish();
  });
  py.on("exit", () => {
    pyDone = true;
    if (!ffDone) terminate(ff);
    finish();
  });
  py.on("error", (err) => {
    appendLog(`[recordings thumb py] ${err.message}`);
    pyDone = true;
    terminate(ff);
    finish();
  });
  ff.on("error", (err) => {
    appendLog(`[recordings thumb ffmpeg] ${err.message}`);
    ffDone = true;
    terminate(py);
    finish();
  });
  req.on("close", () => {
    if (!res.writableEnded) {
      cancelled = true;
      terminate(py);
      terminate(ff);
      cleanup();
    }
  });
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
  }[ext] || "application/octet-stream";
}

function serveFile(res, rootDir, requestPath) {
  const safePath = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(rootDir, safePath);
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

function servePublic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  serveFile(res, PUBLIC_DIR, urlPath);
}

function serveClientHelper(req, res, pathname) {
  const relativePath = pathname.replace(/^\/helpers\/client\//, "");
  serveFile(res, CLIENT_HELPERS_DIR, relativePath);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, {
      running: state.running,
      config: state.config,
      appliedConfig: state.appliedConfig,
      recordParams: state.recordParams,
      timedRecordParams: state.timedRecordParams,
      stats: state.stats,
      startedAt: state.startedAt,
      logs: state.logs.slice(-100),
      setup: state.setup,
      onboarding: state.onboarding,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
    });
    res.write("\n");
    state.clients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {}
    }, 15000);
    req.on("close", () => {
      clearInterval(ping);
      state.clients.delete(res);
    });
    broadcastState();
    return;
  }

  if (req.method === "GET" && url.pathname === "/stream.mjpg") {
    if (!state.running || !state.ffmpeg) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Stream is not running");
      return;
    }
    res.writeHead(200, {
      "Content-Type": 'multipart/x-mixed-replace; boundary=homeeye',
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    state.videoClients.add(res);
    req.on("close", () => {
      state.videoClients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/connect") {
    try {
      const body = await parseJsonBody(req);
      const did = String(body.did || "").trim();
      const user = String(body.user || "admin").trim();
      const pwd = String(body.pwd || "");
      if (!did) throw new Error("Camera DID is required.");
      if (!user) throw new Error("Camera username is required.");

      state.config = normalizeConfig({
        ...state.config,
        did,
        user,
        pwd,
        timezone: body.timezone,
        ntpSwitch: body.ntpSwitch,
        ntpServer: body.ntpServer,
      });
      updateOnboarding("connecting", "Checking the camera connection...");
      const result = await runPythonQuery(["--get-datetime-auto", ...cameraArgs()]);
      const payload = parsePythonPayload(result);
      state.setup = {
        ...state.setup,
        status: "idle",
        needsSetup: true,
        reason: "first_run",
        summary: "Camera connected. Continue with network setup.",
        cameraDatetime: payload,
        targetTimezone: state.config.timezone,
      };
      updateOnboarding(
        "network_choice",
        "Camera connected successfully. Choose whether to keep its current hotspot or move it to Wi-Fi.",
      );
      sendJson(res, 200, { ok: true, onboarding: state.onboarding, camera: payload });
    } catch (err) {
      updateOnboarding("camera_details", err.message);
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/discover") {
    const result = await discoverSetupCamera();
    sendJson(res, result.ok ? 200 : 400, {
      ...result,
      onboarding: state.onboarding,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/hotspot/keep") {
    try {
      updateOnboarding("verifying", "Verifying camera control on its hotspot...", {
        connectionMode: "hotspot",
      });
      const result = await runPythonQuery(["--sd-status", ...cameraArgs()]);
      const payload = parsePythonPayload(result);
      updateOnboarding(
        "camera_settings",
        "Camera hotspot mode works. Choose the initial camera settings.",
        { connectionMode: "hotspot", sdStatus: payload },
      );
      sendJson(res, 200, { ok: true, payload, onboarding: state.onboarding });
    } catch (err) {
      updateOnboarding("network_choice", err.message);
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/wifi/begin") {
    updateOnboarding(
      "wifi",
      "Scan for a private 2.4 GHz Wi-Fi network or enter its credentials.",
      { connectionMode: "wifi" },
    );
    sendJson(res, 200, { ok: true, onboarding: state.onboarding });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/wifi/scan") {
    try {
      if (!state.config.did) throw new Error("Connect to the camera first.");
      updateOnboarding("wifi_scanning", "Asking the camera to scan nearby Wi-Fi networks...");
      const result = await runPythonQuery(["--scan-wifi", ...cameraArgs()]);
      const payload = parsePythonPayload(result);
      const networks = Array.isArray(payload.networks) ? payload.networks : [];
      updateOnboarding("wifi", `Found ${networks.length} Wi-Fi network${networks.length === 1 ? "" : "s"}.`, {
        wifiNetworks: networks,
      });
      sendJson(res, 200, { ok: true, networks, payload, onboarding: state.onboarding });
    } catch (err) {
      updateOnboarding("wifi", err.message);
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/wifi/apply") {
    try {
      const body = await parseJsonBody(req);
      const ssid = String(body.ssid || "").trim();
      const password = String(body.password || "");
      const encryption = Number(body.encryption);
      if (!ssid) throw new Error("Target Wi-Fi name is required.");
      if (!Number.isInteger(encryption)) throw new Error("Wi-Fi encryption code is required.");
      updateOnboarding("wifi_handoff", `Sending ${ssid} to the camera...`);
      const result = await runPythonQuery([
        "--set-wifi-ssid", ssid,
        "--set-wifi-pwd", password,
        "--set-wifi-encryption", String(encryption),
        ...cameraArgs(),
      ]);
      updateOnboarding(
        "reconnect",
        `Wi-Fi settings were sent. Connect this computer to ${ssid}, wait for the camera to join, then verify it.`,
        { targetSsid: ssid, wifiNetworks: [], connectionMode: "wifi" },
      );
      sendJson(res, 200, {
        ok: true,
        payload: parsePythonPayload(result),
        onboarding: state.onboarding,
      });
    } catch (err) {
      updateOnboarding("wifi", err.message);
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/wifi/skip") {
    updateOnboarding("reconnect", "Wi-Fi handoff skipped. Verify the camera on its current network.");
    sendJson(res, 200, { ok: true, onboarding: state.onboarding });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/verify") {
    try {
      const activeNetworks = await activeWifiNetworks();
      updateOnboarding("verifying", "Verifying the camera on the current network...", { activeNetworks });
      const result = await runPythonQuery(["--sd-status", ...cameraArgs()]);
      const payload = parsePythonPayload(result);
      updateOnboarding("camera_settings", "Camera verified. Choose the initial camera settings.", {
        activeNetworks,
        sdStatus: payload,
      });
      sendJson(res, 200, { ok: true, payload, onboarding: state.onboarding });
    } catch (err) {
      const activeNetworks = await activeWifiNetworks();
      updateOnboarding(
        "reconnect",
        `${err.message} Setup is still active; connect either Wi-Fi adapter to the camera network and retry.`,
        { activeNetworks },
      );
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/onboarding/complete") {
    try {
      const body = await parseJsonBody(req);
      state.config = normalizeConfig({ ...state.config, ...body });
      const result = await runSetupApply({
        ...body,
        syncTimeNow: true,
      });
      if (!result.ok) throw new Error(result.error || "Could not apply initial camera settings.");
      sendJson(res, 200, {
        ...result,
        ok: true,
        onboarding: state.onboarding,
      });
    } catch (err) {
      updateOnboarding("camera_settings", err.message);
      sendJson(res, 400, { ok: false, error: err.message, onboarding: state.onboarding });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    try {
      const body = await parseJsonBody(req);
      startPipeline(body);
      sendJson(res, 200, { ok: true, running: state.running, config: state.config });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/apply") {
    try {
      const body = await parseJsonBody(req);
      const nextConfig = normalizeConfig({ ...state.config, ...body });
      const result = await runControlApply(nextConfig);
      if (result.ok) {
        state.config = nextConfig;
        state.appliedConfig = normalizeConfig({ ...nextConfig });
        persistCurrentConfig();
        broadcastState();
        try {
          await queryAppliedConfig();
        } catch (liveErr) {
          appendLog(`[server] applied config refresh failed: ${liveErr.message}`);
          state.appliedConfig = normalizeConfig({ ...nextConfig });
        }
        broadcastState();
      }
      appendLog(`[server] apply ${result.ok ? "ok" : "failed"}`);
      sendJson(res, result.ok ? 200 : 400, { ...result, config: state.config, appliedConfig: state.appliedConfig });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config/live") {
    try {
      const config = await queryAppliedConfig();
      sendJson(res, 200, { ok: true, config });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/setup/apply") {
    try {
      const body = await parseJsonBody(req);
      const result = await runSetupApply(body);
      appendLog(`[server] setup apply ${result.ok ? "ok" : "failed"}`);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/setup/refresh") {
    try {
      const payload = await refreshSetupStatus("manual refresh");
      sendJson(res, 200, { ok: true, setup: payload });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    stopPipeline("manual stop");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/restart") {
    try {
      const body = await parseJsonBody(req);
      startPipeline(body);
      sendJson(res, 200, { ok: true, running: state.running, config: state.config });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sd/status") {
    try {
      const result = await runSdQuery(
        ["--sd-status", "--did", state.config.did, "--user", state.config.user, "--pwd", state.config.pwd],
        "sd status",
      );
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sd/days") {
    try {
      const body = await parseJsonBody(req);
      const year = Number(body.year || new Date().getFullYear());
      const result = await runSdQuery(
        ["--sd-record-day", String(year), "--did", state.config.did, "--user", state.config.user, "--pwd", state.config.pwd],
        "sd record days",
      );
      sendJson(res, result.ok ? 200 : 400, { ...result, year });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sd/files") {
    try {
      const body = await parseJsonBody(req);
      const ymd = String(body.ymd || "").trim();
      if (!/^\d{8}$/.test(ymd)) {
        sendJson(res, 400, { ok: false, error: "ymd must be YYYYMMDD" });
        return;
      }
      const result = await runSdQuery(
        ["--sd-record-list", cameraRecordListDate(ymd), "--did", state.config.did, "--user", state.config.user, "--pwd", state.config.pwd],
        "sd record list",
      );
      sendJson(res, result.ok ? 200 : 400, { ...result, ymd });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recordings/play") {
    await serveSeekableRecording(req, res, url.searchParams.get("file"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recordings/play-status") {
    try {
      const filename = sanitizeRecordingFile(url.searchParams.get("file"));
      const paths = playablePaths(filename);
      const job = playableJobs.get(filename);
      const ready = fs.existsSync(paths.final);
      let bytes = 0;
      try {
        bytes = fs.statSync(ready ? paths.final : paths.part).size;
      } catch {}
      sendJson(res, 200, {
        ok: true,
        ready,
        status: ready ? "ready" : job?.status || "not_started",
        bytes,
        error: job?.error || "",
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recordings/play-legacy") {
    proxyRecording(req, res, url.searchParams.get("file"), false, false);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recordings/download") {
    downloadOriginalRecording(req, res, url.searchParams.get("file"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/recordings/download-bulk") {
    let tempDir = "";
    try {
      const body = await parseJsonBody(req);
      const format = ["original", "raw", "mp4"].includes(body.format) ? body.format : "original";
      const files = await resolveRecordingSelection(body);
      await withExclusiveCamera("bulk recording download", async () => {
        if (!files.length) throw new Error("no recordings found");
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "homeeye-recordings-"));
        const completed = [];
        for (let index = 0; index < files.length; index += 1) {
          const filename = files[index];
          appendLog(`[recordings] bulk download ${index + 1}/${files.length} ${filename}`);
          const startedAt = Date.now();
          const expectedMs = recordingDurationMs(filename);
          let lastProgressAt = 0;
          const reportProgress = (bytes, done = false, totalBytes = 0) => {
            const now = Date.now();
            if (!done && now - lastProgressAt < 500) return;
            lastProgressAt = now;
            appendLog(`[recordings] progress ${index + 1}/${files.length} ${filename} bytes=${bytes} elapsed_ms=${now - startedAt} expected_ms=${expectedMs} total_bytes=${totalBytes} done=${done ? 1 : 0}`);
          };
          const outputName = format === "original"
            ? filename
            : format === "raw"
              ? `${path.parse(filename).name}.hevc`
              : `${path.parse(filename).name}-browser.mp4`;
          if (format === "original") {
            await saveRecordingOriginal(filename, path.join(tempDir, outputName), (bytes, totalBytes) => reportProgress(bytes, false, totalBytes));
          } else if (format === "raw") {
            await saveRecordingHevc(filename, path.join(tempDir, outputName), reportProgress);
          } else {
            await saveRecordingMp4(filename, path.join(tempDir, outputName), reportProgress);
          }
          const finalBytes = fs.statSync(path.join(tempDir, outputName)).size;
          reportProgress(finalBytes, true, format === "original" ? finalBytes : 0);
          completed.push(outputName);
        }
        const formatSuffix = format === "raw" ? "-raw" : format === "original" ? "-original" : "";
        const archiveName = body.scope === "date"
          ? `homeeye-${body.ymd}${formatSuffix}.zip`
          : `homeeye-recordings-${body.year}${formatSuffix}.zip`;
        const archivePath = path.join(tempDir, archiveName);
        appendLog(`[recordings] packaging ${completed.length} files`);
        await runProcess("zip", ["-0", "-q", archivePath, ...completed], { cwd: tempDir, stdio: ["ignore", "ignore", "pipe"] });
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archiveName}"`,
          "Content-Length": fs.statSync(archivePath).size,
          "Cache-Control": "no-store",
        });
        await new Promise((resolve, reject) => {
          const stream = fs.createReadStream(archivePath);
          stream.on("error", reject);
          stream.on("end", resolve);
          stream.pipe(res);
        });
      });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: err.message });
      else if (!res.writableEnded) res.end();
    } finally {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/recordings/delete") {
    try {
      const body = await parseJsonBody(req);
      const files = await resolveRecordingSelection(body);
      const result = await withExclusiveCamera("recording deletion", async () => {
        if (!files.length) throw new Error("no recordings found");
        return deleteRecordings(files);
      });
      sendJson(res, 200, {
        ok: result.failed.length === 0,
        deleted: result.deleted,
        failed: result.failed,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/recordings/thumb") {
    proxyRecordingThumbnail(req, res, url.searchParams.get("file"));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/recordings/preload-thumbs") {
    try {
      const body = await parseJsonBody(req);
      const files = Array.isArray(body.files) ? body.files.map(sanitizeRecordingFile).slice(0, 12) : [];
      sendJson(res, 200, {
        ok: true,
        cached: files.filter((file) => fs.existsSync(thumbPathFor(file))).length,
        missing: files.filter((file) => !fs.existsSync(thumbPathFor(file))).length,
      });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/helpers/client/")) {
    serveClientHelper(req, res, url.pathname);
    return;
  }

  if (req.method === "GET" && (url.pathname === "/index.html" || url.pathname === "/")) {
    servePublic(req, res);
    return;
  }

  if (req.method === "GET") {
    servePublic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
});

server.on("connection", (socket) => {
  state.sockets.add(socket);
  socket.on("close", () => {
    state.sockets.delete(socket);
  });
});

const PORT = Number(process.env.PORT || 8787);

setInterval(() => {
  if (!state.running || !state.process || !state.ffmpeg) return;
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : 0;
  const lastFrameMs = state.lastFrameAt ? Date.parse(state.lastFrameAt) : 0;
  const nowMs = Date.now();
  const runtimeMs = startedAtMs ? (nowMs - startedAtMs) : 0;
  const stallMs = lastFrameMs ? (nowMs - lastFrameMs) : runtimeMs;
  if (runtimeMs < 8000) return;
  if (stallMs < 8000) return;
  appendLog("[server] watchdog detected stale preview stream, restarting");
  startPipeline(state.config);
}, 3000).unref();

setInterval(() => {
  if (!state.config.previewTimeWatch || !state.running || state.timeWatchBusy || state.queryBusy) return;
  const startedAtMs = state.startedAt ? Date.parse(state.startedAt) : 0;
  const nowMs = Date.now();
  if (!startedAtMs || nowMs - startedAtMs < 15000) return;
  if (state.lastTimeWatchAt && nowMs - Date.parse(state.lastTimeWatchAt) < 15000) return;
  state.timeWatchBusy = true;
  state.lastTimeWatchAt = new Date().toISOString();
  (async () => {
    const setup = await refreshSetupStatus("preview time watchdog");
    if (!setup.needsSetup) return;
    appendLog(`[setup] preview time watchdog detected reset: ${setup.summary}`);
    const result = await runTimeSync(state.config);
    if (!result.ok) {
      appendLog(`[setup] preview time watchdog sync failed: ${result.error || "unknown error"}`);
      return;
    }
    await refreshSetupStatus("preview time watchdog after sync");
    appendLog("[setup] preview time watchdog restored camera time");
  })().catch((err) => {
    appendLog(`[setup] preview time watchdog failed: ${err.message}`);
  }).finally(() => {
    state.timeWatchBusy = false;
  });
}, 5000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard listening on http://0.0.0.0:${PORT}`);
  (async () => {
    const activeNetworks = await activeWifiNetworks();
    const activeCameraHotspot = activeNetworks.find((network) => /^AYSA-/i.test(network.ssid));
    const resetCameraDetected = activeCameraHotspot && state.onboarding.connectionMode !== "hotspot";
    if (state.onboarding.required || resetCameraDetected) {
      if (resetCameraDetected) {
        state.onboarding.required = true;
        state.onboarding.step = "discovering";
      }
      console.log("Looking for a camera in first-time setup mode...");
      const result = await discoverSetupCamera();
      if (result.ok) console.log(`Camera hotspot discovered: ${result.hotspot.ssid}`);
      else console.log("Open Setup after connecting this computer to the camera hotspot.");
      return;
    }
    console.log("Checking whether the camera can be discovered...");
    const setup = await ensureValidCameraSetup("server start");
    if (setup.status === "error") {
      console.error(`Camera discovery failed: ${setup.summary.replace(/^Could not read camera time:\s*/, "")}`);
      return;
    }
    console.log("Camera discovered.");
  })().catch((err) => {
    appendLog(`[setup] startup check failed: ${err.message}`);
    console.error(`Camera discovery failed: ${err.message}`);
  });
});

process.on("SIGINT", () => {
  stopPipeline("sigint");
  for (const socket of state.sockets) {
    try {
      socket.destroy();
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});

process.on("SIGTERM", () => {
  stopPipeline("sigterm");
  for (const socket of state.sockets) {
    try {
      socket.destroy();
    } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
