const state = {
  library: [],
  sequence: [],
  selectedLibraryId: null,
  selectedSequenceId: null,
  outputPath: "",
  exporting: false,
  previewMode: "library",
  previewContext: null,
  timelineCursor: 0,
  renderCapabilities: null,
  exportEstimate: null,
  estimateToken: 0,
  playbackFrame: 0,
  previewQueue: Promise.resolve(),
};

const els = {
  importButton: document.getElementById("importButton"),
  appendButton: document.getElementById("appendButton"),
  libraryList: document.getElementById("libraryList"),
  libraryCount: document.getElementById("libraryCount"),
  previewPlayer: document.getElementById("previewPlayer"),
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  previewHint: document.getElementById("previewHint"),
  previewModeChip: document.getElementById("previewModeChip"),
  sequenceDurationChip: document.getElementById("sequenceDurationChip"),
  activeSegmentLabel: document.getElementById("activeSegmentLabel"),
  proxyStatusLabel: document.getElementById("proxyStatusLabel"),
  playTimelineButton: document.getElementById("playTimelineButton"),
  jumpStartButton: document.getElementById("jumpStartButton"),
  jumpEndButton: document.getElementById("jumpEndButton"),
  splitClipButton: document.getElementById("splitClipButton"),
  timelineScrubber: document.getElementById("timelineScrubber"),
  timelineCurrentLabel: document.getElementById("timelineCurrentLabel"),
  timelineTotalLabel: document.getElementById("timelineTotalLabel"),
  sequenceList: document.getElementById("sequenceList"),
  sequenceCount: document.getElementById("sequenceCount"),
  sequenceRuntime: document.getElementById("sequenceRuntime"),
  inspectorEmpty: document.getElementById("inspectorEmpty"),
  clipInspector: document.getElementById("clipInspector"),
  clipName: document.getElementById("clipName"),
  trimStart: document.getElementById("trimStart"),
  trimEnd: document.getElementById("trimEnd"),
  sourceDuration: document.getElementById("sourceDuration"),
  clipOutputDuration: document.getElementById("clipOutputDuration"),
  clipTimelineRange: document.getElementById("clipTimelineRange"),
  clipPlayheadPosition: document.getElementById("clipPlayheadPosition"),
  moveClipUp: document.getElementById("moveClipUp"),
  moveClipDown: document.getElementById("moveClipDown"),
  splitClipInspector: document.getElementById("splitClipInspector"),
  removeClip: document.getElementById("removeClip"),
  renderMode: document.getElementById("renderMode"),
  aspectPreset: document.getElementById("aspectPreset"),
  customSizeFields: document.getElementById("customSizeFields"),
  customWidth: document.getElementById("customWidth"),
  customHeight: document.getElementById("customHeight"),
  aspectSummary: document.getElementById("aspectSummary"),
  resolutionPreset: document.getElementById("resolutionPreset"),
  fps: document.getElementById("fps"),
  videoBitrate: document.getElementById("videoBitrate"),
  crf: document.getElementById("crf"),
  videoPreset: document.getElementById("videoPreset"),
  renderCapability: document.getElementById("renderCapability"),
  estimatedSize: document.getElementById("estimatedSize"),
  estimatedRenderTime: document.getElementById("estimatedRenderTime"),
  estimatedDuration: document.getElementById("estimatedDuration"),
  exportFootnote: document.getElementById("exportFootnote"),
  browseOutput: document.getElementById("browseOutput"),
  outputPath: document.getElementById("outputPath"),
  exportButton: document.getElementById("exportButton"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  statusText: document.getElementById("statusText"),
};

const OUTPUT_ASPECT_PRESETS = Object.freeze({
  source: {
    label: "适应(原始 / First clip)",
    sourceDriven: true,
  },
  custom: {
    label: "自定义 / Custom",
    custom: true,
  },
  "16:9": {
    label: "16:9 (西瓜视频)",
    ratio: 16 / 9,
  },
  "4:3": {
    label: "4:3",
    ratio: 4 / 3,
  },
  "2.35:1": {
    label: "2.35:1",
    ratio: 2.35,
  },
  "2:1": {
    label: "2:1",
    ratio: 2,
  },
  "1.85:1": {
    label: "1.85:1",
    ratio: 1.85,
  },
  "9:16": {
    label: "9:16 (抖音)",
    ratio: 9 / 16,
  },
  "3:4": {
    label: "3:4",
    ratio: 3 / 4,
  },
  "5.8:9": {
    label: "5.8寸",
    ratio: 9 / 19.5,
  },
  "1:1": {
    label: "1:1",
    ratio: 1,
  },
});

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function roundMs(value) {
  return Number((Number(value) || 0).toFixed(3));
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

function formatDuration(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) {
    return [hours, minutes, secs].map((value, index) => String(value).padStart(index === 0 ? 1 : 2, "0")).join(":");
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatPrecise(seconds) {
  return `${roundMs(seconds).toFixed(3)}s`;
}

function formatTimecode(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const millis = Math.round((safe - whole) * 1000);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const head = hours > 0
    ? [hours, minutes, secs].map((value, index) => String(value).padStart(index === 0 ? 1 : 2, "0")).join(":")
    : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${head}.${String(millis).padStart(3, "0")}`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Calculating";
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function humanFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / 1024 ** exponent;
  return `${size.toFixed(size >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getSequenceDuration() {
  return roundMs(state.sequence.reduce((sum, clip) => sum + Math.max(0, clip.trimEnd - clip.trimStart), 0));
}

function getSequenceSegments() {
  let cursor = 0;
  return state.sequence.map((clip, index) => {
    const duration = roundMs(Math.max(0, clip.trimEnd - clip.trimStart));
    const start = roundMs(cursor);
    const end = roundMs(start + duration);
    cursor = end;
    return { clip, index, duration, start, end };
  });
}

function selectedLibraryClip() {
  return state.library.find((item) => item.id === state.selectedLibraryId) || null;
}

function selectedSequenceClip() {
  return state.sequence.find((item) => item.id === state.selectedSequenceId) || null;
}

function getLibraryClipById(id) {
  return state.library.find((item) => item.id === id) || null;
}

function getSequenceSegmentByClipId(id) {
  return getSequenceSegments().find((segment) => segment.clip.id === id) || null;
}

function findTimelineSegment(time) {
  const total = getSequenceDuration();
  const target = clampNumber(time, 0, total);
  const segments = getSequenceSegments();
  if (segments.length === 0) return null;
  return segments.find((segment) => (target === total && segment.index === segments.length - 1) || (target >= segment.start && target < segment.end)) || segments[segments.length - 1];
}

function toEvenInteger(value, minimum, maximum) {
  const rounded = Math.round(Number(value) || 0);
  const clamped = Math.min(maximum, Math.max(minimum, rounded));
  return clamped % 2 === 0 ? clamped : Math.max(minimum, clamped - 1);
}

function getBaseResolution() {
  const [width, height] = els.resolutionPreset.value.split("x").map(Number);
  return {
    width: width || 1920,
    height: height || 1080,
  };
}

function getAspectPresetDefinition(key = els.aspectPreset.value) {
  return OUTPUT_ASPECT_PRESETS[key] || OUTPUT_ASPECT_PRESETS["16:9"];
}

function getReferenceAspectSource() {
  const firstSequenceClip = state.sequence[0];
  const mediaClip = firstSequenceClip ? getLibraryClipById(firstSequenceClip.mediaId) : selectedLibraryClip();

  if (!mediaClip?.width || !mediaClip?.height) {
    return null;
  }

  return {
    width: mediaClip.width,
    height: mediaClip.height,
  };
}

function fitRatioToBounds(ratio, boxWidth, boxHeight) {
  let width = boxWidth;
  let height = Math.round(width / ratio);

  if (height > boxHeight) {
    height = boxHeight;
    width = Math.round(height * ratio);
  }

  return {
    width: toEvenInteger(width, 320, 7680),
    height: toEvenInteger(height, 240, 4320),
  };
}

function getResolvedOutputSizeForAspect(aspectKey = els.aspectPreset.value) {
  const preset = getAspectPresetDefinition(aspectKey);
  const base = getBaseResolution();

  if (preset.custom) {
    return {
      width: toEvenInteger(els.customWidth.value, 320, 7680),
      height: toEvenInteger(els.customHeight.value, 240, 4320),
      label: preset.label,
    };
  }

  let ratio = preset.ratio;
  let label = preset.label;

  if (preset.sourceDriven) {
    const source = getReferenceAspectSource();
    if (source) {
      ratio = source.width / source.height;
      label = `${preset.label} ${source.width}:${source.height}`;
    } else {
      ratio = base.width / base.height;
      label = `${preset.label} (waiting for clip)`;
    }
  }

  const landscapeBounds = {
    width: Math.max(base.width, base.height),
    height: Math.min(base.width, base.height),
  };
  const portraitBounds = {
    width: landscapeBounds.height,
    height: landscapeBounds.width,
  };
  const bounds = ratio >= 1 ? landscapeBounds : portraitBounds;
  const fitted = fitRatioToBounds(ratio, bounds.width, bounds.height);

  return {
    ...fitted,
    label,
  };
}

function getResolvedOutputSize() {
  return getResolvedOutputSizeForAspect(els.aspectPreset.value);
}

function seedCustomSizeFromAspect(aspectKey = "16:9") {
  const seed = getResolvedOutputSizeForAspect(aspectKey === "custom" ? "16:9" : aspectKey);
  els.customWidth.value = String(seed.width);
  els.customHeight.value = String(seed.height);
}

function updateAspectSummary() {
  const output = getResolvedOutputSize();
  els.aspectSummary.textContent = `Output canvas ${output.width} x ${output.height} | ${output.label}`;
}

function syncAspectControls() {
  const isCustom = els.aspectPreset.value === "custom";
  els.customSizeFields.classList.toggle("hidden", !isCustom);
  els.customWidth.disabled = !isCustom;
  els.customHeight.disabled = !isCustom;
  updateAspectSummary();
}

function getExportSettings() {
  const { width, height } = getResolvedOutputSize();
  return {
    width,
    height,
    fps: Number(els.fps.value) || 30,
    crf: Number(els.crf.value) || 20,
    videoPreset: els.videoPreset.value,
    renderMode: els.renderMode.value,
    videoBitrate: els.videoBitrate.value,
    aspectPreset: els.aspectPreset.value,
  };
}

function describeRenderMode(renderMode, usingHardwareEncoder) {
  if (renderMode === "force-gpu") {
    return usingHardwareEncoder ? "GPU forced" : "GPU required";
  }

  if (renderMode === "auto-gpu") {
    return usingHardwareEncoder ? "Auto GPU active" : "Auto GPU fallback to CPU";
  }

  return "CPU software render";
}

function describeHardwareCapabilityIssue(capabilities) {
  const unusableHardwareEncoders = capabilities?.unusableHardwareEncoders || [];
  if (unusableHardwareEncoders.length === 0) {
    return "";
  }

  return unusableHardwareEncoders
    .map((encoder) => `${encoder.label}: ${encoder.probeError || "initialization failed"}`)
    .join("; ");
}

function sequenceClipToExportClip(clip) {
  return {
    path: clip.path,
    name: clip.name,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    sourceDuration: clip.sourceDuration,
    hasAudio: clip.hasAudio,
    hasVideo: clip.hasVideo,
  };
}

function setStatus(label, text, percent = null) {
  els.progressLabel.textContent = label;
  els.statusText.textContent = text;
  if (percent !== null) els.progressBar.style.width = `${percent}%`;
}

function describeProxyStatus(mediaClip) {
  if (!mediaClip) return "Preview proxy idle";
  if (mediaClip.previewPath) return "Preview proxy ready";
  if (mediaClip.previewStatus === "preparing") return "Preparing preview proxy";
  if (mediaClip.previewStatus === "failed") return "Preview proxy failed";
  return "Source preview";
}

function getSelectedClipPlayhead() {
  const clip = selectedSequenceClip();
  const segment = clip ? getSequenceSegmentByClipId(clip.id) : null;
  if (!clip || !segment) return null;
  if (state.timelineCursor < segment.start || state.timelineCursor > segment.end) return null;
  return roundMs(clip.trimStart + (state.timelineCursor - segment.start));
}

function canSplitSelectedClip() {
  const clip = selectedSequenceClip();
  const playhead = getSelectedClipPlayhead();
  return Boolean(clip && playhead !== null && playhead > clip.trimStart + 0.001 && playhead < clip.trimEnd - 0.001);
}

function renderLibrary() {
  els.libraryCount.textContent = `${state.library.length} clip${state.library.length === 1 ? "" : "s"}`;
  if (state.library.length === 0) {
    els.libraryList.className = "library-list empty-state";
    els.libraryList.textContent = "Import a few source videos to begin building the sequence.";
    return;
  }

  els.libraryList.className = "library-list";
  els.libraryList.innerHTML = "";

  state.library.forEach((clip) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `library-item${clip.id === state.selectedLibraryId ? " selected" : ""}`;
    card.addEventListener("click", () => {
      state.selectedLibraryId = clip.id;
      previewLibraryClip(clip);
      render();
    });
    card.addEventListener("dblclick", () => addSelectedLibraryClipToSequence(clip.id));

    const proxyBadge = clip.previewPath
      ? `<span class="badge cool">Proxy ready</span>`
      : clip.previewStatus === "preparing"
        ? `<span class="badge">Proxy building</span>`
        : "";

    card.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(clip.name)}</strong>
        <span class="badge warm">${formatDuration(clip.duration)}</span>
      </div>
      <div class="item-meta">
        <span class="badge">${clip.width && clip.height ? `${clip.width}x${clip.height}` : "Unknown size"}</span>
        <span class="badge">${clip.hasAudio ? "Audio" : "Silent"}</span>
        <span class="badge cool">${escapeHtml(clip.sizeLabel || "File")}</span>
        ${proxyBadge}
      </div>
    `;

    els.libraryList.appendChild(card);
  });
}

function renderSequence() {
  const runtime = getSequenceDuration();
  const segments = getSequenceSegments();
  els.sequenceCount.textContent = `${state.sequence.length} clip${state.sequence.length === 1 ? "" : "s"}`;
  els.sequenceRuntime.textContent = `${formatTimecode(runtime)} total`;
  els.sequenceDurationChip.textContent = `Timeline ${formatTimecode(runtime)}`;

  if (state.sequence.length === 0) {
    els.sequenceList.className = "sequence-list empty-state";
    els.sequenceList.textContent = "Add clips from the media bin and arrange them in order.";
    return;
  }

  els.sequenceList.className = "sequence-list";
  els.sequenceList.innerHTML = "";

  segments.forEach((segment) => {
    const clip = segment.clip;
    const element = document.createElement("button");
    element.type = "button";
    element.className = `sequence-item${clip.id === state.selectedSequenceId ? " selected" : ""}`;
    element.addEventListener("click", () => {
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId = clip.mediaId;
      previewTimelineAt(segment.start, { forceReload: true });
      render();
    });

    element.innerHTML = `
      <div class="sequence-item-content">
        <div class="item-title">
          <strong>${segment.index + 1}. ${escapeHtml(clip.name)}</strong>
          <span class="badge warm">${formatTimecode(segment.duration)}</span>
        </div>
        <div class="sequence-meta">
          <span class="badge">${formatTimecode(segment.start)} in timeline</span>
          <span class="badge">${formatPrecise(clip.trimStart)} source in</span>
          <span class="badge">${formatPrecise(clip.trimEnd)} source out</span>
          <span class="badge cool">${clip.hasAudio ? "Audio kept" : "Silent fill"}</span>
        </div>
      </div>
    `;

    els.sequenceList.appendChild(element);
  });
}

function renderInspector() {
  const clip = selectedSequenceClip();
  if (!clip) {
    els.inspectorEmpty.classList.remove("hidden");
    els.clipInspector.classList.add("hidden");
    return;
  }

  const segment = getSequenceSegmentByClipId(clip.id);
  const playhead = getSelectedClipPlayhead();
  els.inspectorEmpty.classList.add("hidden");
  els.clipInspector.classList.remove("hidden");
  els.clipName.value = clip.name;
  els.trimStart.value = clip.trimStart.toFixed(3);
  els.trimEnd.value = clip.trimEnd.toFixed(3);
  els.sourceDuration.textContent = formatPrecise(clip.sourceDuration);
  els.clipOutputDuration.textContent = formatPrecise(clip.trimEnd - clip.trimStart);
  els.clipTimelineRange.textContent = segment ? `${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)}` : "00:00.000";
  els.clipPlayheadPosition.textContent = playhead === null ? "Outside clip" : formatTimecode(playhead);
  els.splitClipInspector.disabled = !canSplitSelectedClip();
}

function renderTimelineTransport() {
  const total = getSequenceDuration();
  const segment = findTimelineSegment(state.timelineCursor);
  const currentMedia = state.previewMode === "timeline" ? getLibraryClipById(segment?.clip.mediaId) : selectedLibraryClip();
  const playingTimeline = state.previewMode === "timeline" && !els.previewPlayer.paused;

  els.timelineScrubber.max = total > 0 ? String(total) : "0";
  els.timelineScrubber.value = total > 0 ? String(clampNumber(state.timelineCursor, 0, total)) : "0";
  els.timelineScrubber.disabled = total <= 0;
  els.timelineCurrentLabel.textContent = formatTimecode(state.timelineCursor);
  els.timelineTotalLabel.textContent = formatTimecode(total);
  els.playTimelineButton.disabled = total <= 0;
  els.jumpStartButton.disabled = total <= 0;
  els.jumpEndButton.disabled = total <= 0;
  els.splitClipButton.disabled = !canSplitSelectedClip();
  els.previewModeChip.textContent = state.previewMode === "timeline" ? "Timeline Preview" : "Clip Preview";
  els.activeSegmentLabel.textContent = segment ? `Clip ${segment.index + 1}/${state.sequence.length} | ${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)}` : "Timeline not loaded";
  els.proxyStatusLabel.textContent = describeProxyStatus(currentMedia);
  els.playTimelineButton.textContent = playingTimeline ? "Pause Timeline" : "Play Timeline";
}

function renderOutputPath() {
  els.outputPath.value = state.outputPath;
  els.appendButton.disabled = !selectedLibraryClip() || state.exporting;
  els.exportButton.disabled = state.exporting || state.sequence.length === 0;
  els.exportButton.textContent = state.outputPath ? "Export Timeline To MP4" : "Choose Export File & Render";
}

function renderExportSummary() {
  const settings = getExportSettings();
  const output = getResolvedOutputSize();
  const fallback = settings.renderMode === "force-gpu"
    ? state.renderCapabilities?.detectedPipelineLabel || state.renderCapabilities?.detectedHardwareEncoder?.label || "GPU required"
    : state.renderCapabilities?.preferredPipelineLabel || state.renderCapabilities?.preferredEncoder?.label || "Detecting...";
  const activePipelineLabel =
    state.exportEstimate?.pipelineLabel || state.exportEstimate?.encoderLabel || fallback;
  els.renderCapability.textContent = activePipelineLabel;
  els.estimatedSize.textContent = state.exportEstimate?.estimatedFileSizeLabel || "-";
  els.estimatedRenderTime.textContent = state.exportEstimate?.estimatedRenderLabel || "-";
  els.estimatedDuration.textContent = formatTimecode(getSequenceDuration());
  updateAspectSummary();

  if (state.exportEstimate) {
    const bitrateMode = settings.videoBitrate === "auto" ? "auto bitrate" : "manual bitrate";
    const renderModeStatus = describeRenderMode(settings.renderMode, state.exportEstimate.usingHardwareEncoder);
    els.exportFootnote.textContent = `${activePipelineLabel} | ${output.width} x ${output.height} | ${state.exportEstimate.resolvedVideoBitrateKbps} kbps ${bitrateMode} | ${renderModeStatus}`;
    return;
  }

  if (settings.renderMode === "force-gpu") {
    if (state.renderCapabilities?.detectedHardwareEncoder) {
      els.exportFootnote.textContent = `Force GPU will use ${state.renderCapabilities.detectedPipelineLabel || state.renderCapabilities.detectedHardwareEncoder.label} and will stop instead of falling back to CPU.`;
      return;
    }

    const hardwareIssue = describeHardwareCapabilityIssue(state.renderCapabilities);
    if (hardwareIssue) {
      els.exportFootnote.textContent = `Force GPU is selected, but the detected hardware encoder could not be initialized. ${hardwareIssue}`;
      return;
    }

    els.exportFootnote.textContent = "Force GPU is selected, but no supported H.264 GPU encoder was detected. Export will fail until a GPU encoder is available.";
    return;
  }

  if (state.renderCapabilities?.detectedHardwareEncoder) {
    els.exportFootnote.textContent = `Auto GPU will prefer ${state.renderCapabilities.preferredPipelineLabel || state.renderCapabilities.detectedHardwareEncoder.label}.`;
    return;
  }

  const hardwareIssue = describeHardwareCapabilityIssue(state.renderCapabilities);
  if (hardwareIssue) {
    els.exportFootnote.textContent = `Auto GPU will render with CPU because the detected hardware encoder could not be initialized. ${hardwareIssue}`;
    return;
  }

  els.exportFootnote.textContent = "Export estimates update with your timeline length, render engine, and bitrate.";
}

function render() {
  renderLibrary();
  renderSequence();
  renderInspector();
  renderTimelineTransport();
  syncAspectControls();
  renderExportSummary();
  renderOutputPath();
}

function buildSequenceClip(clip) {
  return {
    id: createId("seq"),
    mediaId: clip.id,
    path: clip.path,
    name: clip.name,
    sourceDuration: clip.duration,
    trimStart: 0,
    trimEnd: roundMs(clip.duration),
    hasAudio: clip.hasAudio,
    hasVideo: clip.hasVideo,
  };
}

function appendClipsToSequence(clips) {
  const next = clips.map(buildSequenceClip);
  state.sequence.push(...next);
  return next;
}

async function ensurePreviewPath(mediaClip) {
  if (!mediaClip) return null;
  if (mediaClip.previewPath) return mediaClip.previewPath;
  if (mediaClip.previewPromise) return mediaClip.previewPromise;

  mediaClip.previewStatus = "preparing";
  renderLibrary();
  renderTimelineTransport();

  mediaClip.previewPromise = window.editorAPI.preparePreview(mediaClip.path)
    .then((previewPath) => {
      mediaClip.previewPath = previewPath;
      mediaClip.previewStatus = "ready";
      renderLibrary();
      renderTimelineTransport();
      return previewPath;
    })
    .catch((error) => {
      mediaClip.previewStatus = "failed";
      mediaClip.previewError = error.message;
      renderLibrary();
      renderTimelineTransport();
      throw error;
    })
    .finally(() => {
      mediaClip.previewPromise = null;
    });

  return mediaClip.previewPromise;
}

function queuePreviewPreparation(clips) {
  clips.forEach((clip) => {
    state.previewQueue = state.previewQueue
      .then(() => ensurePreviewPath(clip))
      .catch(() => null);
  });
}

function loadPlayerSource(sourcePath, context, seekTime, autoplay) {
  const token = createId("preview");
  state.previewContext = {
    ...context,
    token,
    sourcePath,
    seekTime,
    usingProxy: context.mediaClip?.previewPath === sourcePath,
  };

  els.previewPlayer.pause();
  els.previewPlayer.src = window.editorAPI.toFileUrl(sourcePath);
  els.previewPlayer.load();

  els.previewPlayer.addEventListener("loadedmetadata", () => {
    if (state.previewContext?.token !== token) return;
    const target = clampNumber(
      seekTime,
      0,
      Number.isFinite(els.previewPlayer.duration) ? els.previewPlayer.duration : seekTime,
    );
    els.previewPlayer.currentTime = target;
    if (autoplay) els.previewPlayer.play().catch(() => null);
  }, { once: true });
}

function scheduleProxyReload(mediaClip) {
  if (!mediaClip || mediaClip.previewPath) return;
  ensurePreviewPath(mediaClip)
    .then(() => {
      if (state.previewMode === "timeline" && state.previewContext?.mediaId === mediaClip.id && !state.previewContext.usingProxy) {
        previewTimelineAt(state.timelineCursor, { autoplay: !els.previewPlayer.paused, forceReload: true });
      }
    })
    .catch(() => null);
}

function previewLibraryClip(clip, options = {}) {
  if (!clip) return;
  state.previewMode = "library";
  state.selectedLibraryId = clip.id;
  els.previewTitle.textContent = clip.name;
  els.previewMeta.textContent = `${formatDuration(clip.duration)} source`;
  els.previewHint.textContent = clip.hasAudio
    ? "Source clip loaded. Double-click it to add it to the sequence."
    : "This source clip has no audio track. Export will fill silence automatically.";

  const sourcePath = options.preferProxy && clip.previewPath ? clip.previewPath : clip.previewPath || clip.path;
  loadPlayerSource(sourcePath, { kind: "library", mediaId: clip.id, mediaClip: clip }, 0, false);
  if (!clip.previewPath) ensurePreviewPath(clip).catch(() => null);
  renderTimelineTransport();
}

function previewTimelineAt(time, options = {}) {
  const total = getSequenceDuration();
  if (state.sequence.length === 0 || total <= 0) return;

  const cursor = clampNumber(time, 0, total);
  const segment = findTimelineSegment(cursor);
  if (!segment) return;

  const mediaClip = getLibraryClipById(segment.clip.mediaId);
  const sourcePath = mediaClip?.previewPath || mediaClip?.path || segment.clip.path;
  const localTime = roundMs(segment.clip.trimStart + (cursor - segment.start));
  const context = state.previewContext;
  const reusingCurrentSource = !options.forceReload &&
    context?.kind === "timeline" &&
    context.sequenceId === segment.clip.id &&
    context.sourcePath === sourcePath;

  const selectionChanged =
    state.selectedSequenceId !== segment.clip.id ||
    state.selectedLibraryId !== segment.clip.mediaId;
  state.previewMode = "timeline";
  state.timelineCursor = cursor;
  state.selectedSequenceId = segment.clip.id;
  state.selectedLibraryId = segment.clip.mediaId;
  els.previewTitle.textContent = segment.clip.name;
  els.previewMeta.textContent = `${formatTimecode(segment.start)} in timeline`;
  els.previewHint.textContent = "Timeline preview follows trims, supports millisecond scrubbing, and advances across clips.";

  if (reusingCurrentSource) {
    if (Math.abs(els.previewPlayer.currentTime - localTime) > 0.02) {
      els.previewPlayer.currentTime = localTime;
    }
    if (options.autoplay) els.previewPlayer.play().catch(() => null);
  } else {
    loadPlayerSource(sourcePath, {
      kind: "timeline",
      mediaId: segment.clip.mediaId,
      mediaClip,
      sequenceId: segment.clip.id,
      segmentIndex: segment.index,
      segmentStart: segment.start,
      segmentEnd: segment.end,
      localStart: segment.clip.trimStart,
      localEnd: segment.clip.trimEnd,
    }, localTime, Boolean(options.autoplay));
  }

  scheduleProxyReload(mediaClip);
  if (selectionChanged) {
    renderLibrary();
    renderSequence();
  }
  renderInspector();
  renderTimelineTransport();
  renderExportSummary();
  renderOutputPath();
}

async function importVideos() {
  if (state.exporting) return;
  const filePaths = await window.editorAPI.openVideos();
  if (!filePaths?.length) return;

  setStatus("Inspecting", "Reading media metadata for imported files.");
  const results = await window.editorAPI.probeFiles(filePaths);
  const existingPaths = new Set(state.library.map((clip) => clip.path));
  const imported = [];

  results.forEach((result) => {
    if (result.error || existingPaths.has(result.path) || !result.hasVideo) return;
    const clip = {
      id: createId("media"),
      path: result.path,
      name: result.name,
      duration: roundMs(result.duration),
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
      hasVideo: result.hasVideo,
      sizeLabel: result.sizeLabel,
      previewPath: null,
      previewStatus: "idle",
      previewPromise: null,
    };
    state.library.push(clip);
    imported.push(clip);
    existingPaths.add(result.path);
  });

  if (imported.length === 0) {
    render();
    setStatus("Ready", "No new playable clips were added from that selection.", 0);
    return;
  }

  const added = appendClipsToSequence(imported);
  const firstClip = imported[0];
  const firstSequence = added[0];
  const firstSegment = getSequenceSegmentByClipId(firstSequence.id);

  state.selectedLibraryId = firstClip.id;
  state.selectedSequenceId = firstSequence.id;
  queuePreviewPreparation(imported);
  if (firstSegment) previewTimelineAt(firstSegment.start, { forceReload: true });
  render();
  refreshExportEstimate();
  setStatus("Ready", `Imported ${imported.length} clip${imported.length === 1 ? "" : "s"} and added them to the timeline.`, 0);
}

function addSelectedLibraryClipToSequence(explicitId = null) {
  if (state.exporting) return;
  const clip = state.library.find((item) => item.id === (explicitId || state.selectedLibraryId));
  if (!clip) return;
  const [sequenceClip] = appendClipsToSequence([clip]);
  const segment = getSequenceSegmentByClipId(sequenceClip.id);
  state.selectedSequenceId = sequenceClip.id;
  state.selectedLibraryId = clip.id;
  if (segment) previewTimelineAt(segment.start, { forceReload: true });
  render();
  refreshExportEstimate();
}

function bindTrimInputs() {
  const commit = () => {
    const clip = selectedSequenceClip();
    if (!clip) return;
    const nextStart = clampNumber(els.trimStart.value, 0, clip.sourceDuration);
    const nextEnd = clampNumber(els.trimEnd.value, nextStart + 0.001, clip.sourceDuration);
    clip.trimStart = roundMs(nextStart);
    clip.trimEnd = roundMs(nextEnd);
    const segment = getSequenceSegmentByClipId(clip.id);
    if (segment) {
      const nextCursor = clampNumber(state.timelineCursor, segment.start, roundMs(segment.start + (clip.trimEnd - clip.trimStart)));
      previewTimelineAt(nextCursor, { forceReload: true });
    }
    render();
    refreshExportEstimate();
  };

  els.trimStart.addEventListener("change", commit);
  els.trimEnd.addEventListener("change", commit);
}

function moveSelectedClip(direction) {
  const index = state.sequence.findIndex((clip) => clip.id === state.selectedSequenceId);
  if (index === -1) return;
  const currentSegment = getSequenceSegmentByClipId(state.selectedSequenceId);
  const relativeOffset = currentSegment ? state.timelineCursor - currentSegment.start : 0;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.sequence.length) return;

  const [clip] = state.sequence.splice(index, 1);
  state.sequence.splice(nextIndex, 0, clip);
  const nextSegment = getSequenceSegmentByClipId(clip.id);
  if (nextSegment) {
    const nextCursor = clampNumber(nextSegment.start + relativeOffset, nextSegment.start, nextSegment.end);
    previewTimelineAt(nextCursor, { forceReload: true });
  }
  render();
  refreshExportEstimate();
}

function removeSelectedClip() {
  const index = state.sequence.findIndex((clip) => clip.id === state.selectedSequenceId);
  if (index === -1) return;
  state.sequence.splice(index, 1);

  const fallback = state.sequence[index] || state.sequence[index - 1] || null;
  state.selectedSequenceId = fallback?.id || null;
  state.timelineCursor = 0;

  if (fallback) {
    const segment = getSequenceSegmentByClipId(fallback.id);
    if (segment) previewTimelineAt(segment.start, { forceReload: true });
  } else if (selectedLibraryClip()) {
    previewLibraryClip(selectedLibraryClip());
  } else {
    state.previewContext = null;
    state.previewMode = "library";
    els.previewPlayer.pause();
    els.previewPlayer.removeAttribute("src");
    els.previewPlayer.load();
    els.previewTitle.textContent = "No clip selected";
    els.previewMeta.textContent = "Ready";
    els.previewHint.textContent = "Select a clip in the media bin or sequence to preview it here.";
  }

  render();
  refreshExportEstimate();
}

function splitSelectedClipAtPlayhead() {
  const clip = selectedSequenceClip();
  const playhead = getSelectedClipPlayhead();
  if (!clip || playhead === null) return;

  const splitPoint = roundMs(playhead);
  if (splitPoint <= clip.trimStart + 0.001 || splitPoint >= clip.trimEnd - 0.001) {
    setStatus("Split Skipped", "Move the playhead inside the clip before splitting.", 0);
    return;
  }

  const index = state.sequence.findIndex((item) => item.id === clip.id);
  const secondHalf = {
    ...clip,
    id: createId("seq"),
    trimStart: splitPoint,
  };

  clip.trimEnd = splitPoint;
  state.sequence.splice(index + 1, 0, secondHalf);
  state.selectedSequenceId = secondHalf.id;
  const segment = getSequenceSegmentByClipId(secondHalf.id);
  if (segment) previewTimelineAt(segment.start, { forceReload: true });
  render();
  refreshExportEstimate();
  setStatus("Split Complete", `Created two timeline clips at ${formatTimecode(splitPoint)}.`, 0);
}

async function chooseOutputPath() {
  const suggestedName = `cutline-export-${Date.now()}.mp4`;
  const outputPath = await window.editorAPI.saveExport(suggestedName);
  if (!outputPath) return null;
  state.outputPath = outputPath;
  renderOutputPath();
  setStatus("Ready", "Export target chosen. Render the timeline when you are ready.", 0);
  return outputPath;
}

async function refreshExportEstimate() {
  if (state.sequence.length === 0) {
    state.exportEstimate = null;
    renderExportSummary();
    return;
  }

  const token = ++state.estimateToken;
  try {
    const estimate = await window.editorAPI.estimateExport({
      clips: state.sequence.map(sequenceClipToExportClip),
      settings: getExportSettings(),
    });
    if (token !== state.estimateToken) return;
    state.exportEstimate = estimate;
    renderExportSummary();
  } catch (error) {
    if (token !== state.estimateToken) return;
    state.exportEstimate = null;
    els.exportFootnote.textContent = error.message || "Could not calculate export estimate.";
    renderExportSummary();
  }
}

async function exportTimeline() {
  if (state.exporting || state.sequence.length === 0) return;
  if (!state.outputPath) {
    const outputPath = await chooseOutputPath();
    if (!outputPath) return;
  }

  state.exporting = true;
  renderOutputPath();
  setStatus("Rendering", "FFmpeg is combining your timeline into one MP4.", 2);

  try {
    const result = await window.editorAPI.exportProject({
      clips: state.sequence.map(sequenceClipToExportClip),
      outputPath: state.outputPath,
      settings: getExportSettings(),
    });

    els.estimatedSize.textContent = result.outputSizeLabel || humanFileSize(result.outputSizeBytes || 0);
    els.estimatedRenderTime.textContent = "Completed";
    const completedPipelineLabel = result.pipelineLabel || result.encoderLabel;
    els.renderCapability.textContent = completedPipelineLabel || els.renderCapability.textContent;
    setStatus(
      "Finished",
      `Rendered ${result.clipCount} clip${result.clipCount === 1 ? "" : "s"} with ${completedPipelineLabel}${result.fallbackFromHardware ? " (hardware fallback used software for reliability)" : ""} to ${result.outputPath}. Final size ${result.outputSizeLabel}.`,
      100,
    );
  } catch (error) {
    setStatus("Export Failed", error.message || "The export did not complete.", 0);
  } finally {
    state.exporting = false;
    renderOutputPath();
    refreshExportEstimate();
  }
}

function stopPlaybackMonitor() {
  if (state.playbackFrame) {
    cancelAnimationFrame(state.playbackFrame);
    state.playbackFrame = 0;
  }
}

function updateTimelinePlayback() {
  state.playbackFrame = 0;
  const context = state.previewContext;
  if (!context || context.kind !== "timeline") {
    renderTimelineTransport();
    renderInspector();
    return;
  }

  if (els.previewPlayer.currentTime >= context.localEnd - 0.02) {
    const segments = getSequenceSegments();
    const nextSegment = segments[context.segmentIndex + 1];
    if (nextSegment) {
      previewTimelineAt(nextSegment.start, { autoplay: true, forceReload: true });
      return;
    }
    state.timelineCursor = getSequenceDuration();
    els.previewPlayer.pause();
    renderTimelineTransport();
    renderInspector();
    return;
  }

  state.timelineCursor = roundMs(clampNumber(
    context.segmentStart + (els.previewPlayer.currentTime - context.localStart),
    context.segmentStart,
    context.segmentEnd,
  ));
  renderTimelineTransport();
  renderInspector();
  if (!els.previewPlayer.paused) state.playbackFrame = requestAnimationFrame(updateTimelinePlayback);
}

function startPlaybackMonitor() {
  if (!state.playbackFrame) state.playbackFrame = requestAnimationFrame(updateTimelinePlayback);
}

function toggleTimelinePlayback() {
  if (state.sequence.length === 0) return;
  if (state.previewMode !== "timeline") {
    const segment = getSequenceSegmentByClipId(state.selectedSequenceId) || getSequenceSegments()[0];
    if (segment) previewTimelineAt(segment.start, { autoplay: true, forceReload: true });
    return;
  }
  if (els.previewPlayer.paused) {
    previewTimelineAt(state.timelineCursor, { autoplay: true });
    return;
  }
  els.previewPlayer.pause();
}

function wirePreviewEvents() {
  els.previewPlayer.addEventListener("play", () => {
    if (state.previewMode === "timeline") startPlaybackMonitor();
    renderTimelineTransport();
  });
  els.previewPlayer.addEventListener("pause", () => {
    stopPlaybackMonitor();
    renderTimelineTransport();
  });
  els.previewPlayer.addEventListener("ended", () => {
    stopPlaybackMonitor();
    renderTimelineTransport();
  });
  els.previewPlayer.addEventListener("error", async () => {
    const context = state.previewContext;
    if (!context || context.usingProxy) {
      setStatus("Preview Failed", "Could not load this preview clip.", 0);
      return;
    }
    const mediaClip = context.mediaClip || getLibraryClipById(context.mediaId);
    if (!mediaClip) return;
    els.previewHint.textContent = "Preparing a compatible preview copy for this source clip.";
    try {
      await ensurePreviewPath(mediaClip);
      if (context.kind === "timeline") {
        previewTimelineAt(state.timelineCursor, { forceReload: true });
      } else {
        previewLibraryClip(mediaClip, { preferProxy: true });
      }
    } catch (error) {
      els.previewHint.textContent = "Preview could not be prepared for this clip, but export still works.";
      setStatus("Preview Failed", error.message || "Could not prepare a preview copy.", 0);
    }
  });
}

function wireEvents() {
  let previousAspectPreset = els.aspectPreset.value;

  els.importButton.addEventListener("click", importVideos);
  els.appendButton.addEventListener("click", () => addSelectedLibraryClipToSequence());
  els.browseOutput.addEventListener("click", chooseOutputPath);
  els.exportButton.addEventListener("click", exportTimeline);
  els.moveClipUp.addEventListener("click", () => moveSelectedClip(-1));
  els.moveClipDown.addEventListener("click", () => moveSelectedClip(1));
  els.removeClip.addEventListener("click", removeSelectedClip);
  els.splitClipButton.addEventListener("click", splitSelectedClipAtPlayhead);
  els.splitClipInspector.addEventListener("click", splitSelectedClipAtPlayhead);
  els.playTimelineButton.addEventListener("click", toggleTimelinePlayback);
  els.jumpStartButton.addEventListener("click", () => previewTimelineAt(0, { forceReload: true }));
  els.jumpEndButton.addEventListener("click", () => previewTimelineAt(getSequenceDuration(), { forceReload: true }));
  els.timelineScrubber.addEventListener("input", () => {
    const wasPlaying = state.previewMode === "timeline" && !els.previewPlayer.paused;
    previewTimelineAt(Number(els.timelineScrubber.value), { autoplay: wasPlaying, forceReload: false });
  });

  els.aspectPreset.addEventListener("change", () => {
    if (els.aspectPreset.value === "custom") {
      seedCustomSizeFromAspect(previousAspectPreset);
    }
    previousAspectPreset = els.aspectPreset.value;
    syncAspectControls();
    refreshExportEstimate();
  });

  els.resolutionPreset.addEventListener("change", () => {
    syncAspectControls();
    refreshExportEstimate();
  });

  [els.customWidth, els.customHeight].forEach((element) => {
    element.addEventListener("input", syncAspectControls);
    element.addEventListener("change", () => {
      syncAspectControls();
      refreshExportEstimate();
    });
  });

  [els.renderMode, els.fps, els.videoBitrate, els.crf, els.videoPreset]
    .forEach((element) => element.addEventListener("change", refreshExportEstimate));

  bindTrimInputs();
  wirePreviewEvents();

  window.editorAPI.onExportProgress((progress) => {
    if (!state.exporting) return;
    const percent = Number(progress.percent || 0);
    const label = progress.status === "done" ? "Finished" : progress.status === "finalizing" ? "Finalizing" : "Rendering";
    const current = formatTimecode(progress.currentTimeSeconds || 0);
    const total = formatTimecode(progress.totalDuration || getSequenceDuration());
    const eta = formatEta(progress.etaSeconds || 0);
    const size = humanFileSize(progress.estimatedFinalSizeBytes || 0);
    const speed = progress.speedMultiplier ? `${progress.speedMultiplier.toFixed(2)}x` : "warming up";
    const pipelineLabel = progress.pipelineLabel || progress.encoderLabel || "Renderer";

    els.estimatedSize.textContent = size;
    els.estimatedRenderTime.textContent = progress.status === "done" ? "Completed" : eta;
    els.renderCapability.textContent = pipelineLabel || els.renderCapability.textContent;
    setStatus(label, `${current} / ${total} | ETA ${eta} | Est. ${size} | ${pipelineLabel} | ${speed}`, percent);
  });
}

async function initialize() {
  render();
  wireEvents();
  try {
    state.renderCapabilities = await window.editorAPI.getRenderCapabilities();
    renderExportSummary();
  } catch (error) {
    els.exportFootnote.textContent = error.message || "Could not detect export capabilities.";
  }
}

initialize();
