export function currentSetupConfig(setupForm) {
  const form = new FormData(setupForm);
  return {
    syncTimeNow: form.get("syncTimeNow") === "on",
    disableNightVision: form.get("disableNightVision") === "on",
    disableRecording: form.get("disableRecording") === "on",
    turnOffSleep: form.get("turnOffSleep") === "on",
    quality: form.get("quality"),
    videoResolution: Number(form.get("videoResolution")),
    lowPowerMode: Number(form.get("lowPowerMode")),
    timeHour: Number(form.get("timeHour")),
    stream: Number(form.get("stream")),
  };
}

export function renderSetupPanel({ setup, els, setupFormOpen }) {
  const shouldShowPanel = Boolean(
    setupFormOpen
    || setup?.needsSetup
    || setup?.status === "refreshing"
    || setup?.status === "error",
  );
  if (!shouldShowPanel) {
    els.setupPanel.classList.remove("setup-hidden");
    els.setupTimezone.textContent = setup?.targetTimezone || "America/Toronto";
    els.setupHeadline.textContent = "Camera is already set up";
    els.setupSummary.textContent = setup?.summary || "Camera time and local settings are ready.";
    els.setupOpenBtn.textContent = "Edit setup options";
  } else {
    els.setupPanel.classList.remove("setup-hidden");
  }
  els.setupTimezone.textContent = setup?.targetTimezone || "America/Toronto";

  if (setup?.status === "refreshing") {
    els.setupHeadline.textContent = "Checking camera time…";
    els.setupSummary.textContent = setup.summary || "Reading the camera date and timezone.";
  } else if (setup.status === "error") {
    els.setupHeadline.textContent = "Camera time check failed";
    els.setupSummary.textContent = setup.summary || "The dashboard could not read the current camera time.";
  } else if (setup?.needsSetup || setup?.status === "error") {
    els.setupHeadline.textContent = "Camera setup required";
    const reportedYear = Number.isFinite(setup.cameraYear) ? setup.cameraYear : "unknown";
    const targetYear = Number.isFinite(setup.targetYear) ? setup.targetYear : new Date().getFullYear();
    const drift = Number.isFinite(setup.timeDeltaSeconds) ? `${Math.round(setup.timeDeltaSeconds)}s` : "unknown";
    const reportedTz = Number.isFinite(setup.cameraTimezoneSec) ? `${setup.cameraTimezoneSec}s` : "unknown";
    const targetTz = Number.isFinite(setup.targetTimezoneSec) ? `${setup.targetTimezoneSec}s` : "unknown";
    const reportedDst = Number.isFinite(setup.cameraDstSwitch) ? setup.cameraDstSwitch : "unknown";
    const targetDst = Number.isFinite(setup.targetDstSwitch) ? setup.targetDstSwitch : "unknown";
    const summary = setup.summary || "The camera time/date does not match the expected Toronto settings.";
    els.setupSummary.textContent = `${summary} Reported year: ${reportedYear}. Target year: ${targetYear}. Clock drift: ${drift}. Timezone: ${reportedTz} / ${targetTz}. DST: ${reportedDst} / ${targetDst}.`;
  } else {
    els.setupHeadline.textContent = "Camera is already set up";
    els.setupSummary.textContent = setup.summary || "Camera time and local settings are ready.";
    els.setupOpenBtn.textContent = "Edit setup options";
  }

  const showForm = setupFormOpen || setup.status === "refreshing";
  els.setupForm.classList.toggle("setup-form-hidden", !showForm);
  els.setupBottomActions.classList.toggle("setup-form-hidden", !showForm);
  els.setupApplyStatus.classList.toggle("setup-form-hidden", !showForm);
}

export function needsSetupAttention(setup) {
  return Boolean(setup && (setup.needsSetup || setup.status === "error"));
}

export function shouldAutoStartSetupPreview({ setup, running, setupAutoStarted }) {
  return Boolean(setup && setup.needsSetup && !running && !setupAutoStarted);
}

export function shouldAutoStartReadyPreview({ setup, running, readyAutoStarted }) {
  return Boolean(
    setup
    && !setup.needsSetup
    && (setup.status === "ready" || setup.status === "configured")
    && !running
    && !readyAutoStarted,
  );
}
