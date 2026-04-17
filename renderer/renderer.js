const state = {
  library: [],
  sequence: [],
  selectedLibraryId: null,
  selectedSequenceId: null,
  outputPath: "",
  exporting: false,
  previewBounds: null,
  previewContext: null,
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
  sequenceDurationChip: document.getElementById("sequenceDurationChip"),
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
  moveClipUp: document.getElementById("moveClipUp"),
  moveClipDown: document.getElementById("moveClipDown"),
  removeClip: document.getElementById("removeClip"),
  resolutionPreset: document.getElementById("resolutionPreset"),
  fps: document.getElementById("fps"),
  crf: document.getElementById("crf"),
  videoPreset: document.getElementById("videoPreset"),
  browseOutput: document.getElementById("browseOutput"),
  outputPath: document.getElementById("outputPath"),
  exportButton: document.getElementById("exportButton"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  statusText: document.getElementById("statusText"),
};

function createId(prefix) {
  if (globalThis.crypto?.randomUUID) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safeSeconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return [hours, minutes, secs].map((value, index) => String(value).padStart(index === 0 ? 1 : 2, "0")).join(":");
  }

  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatPrecise(seconds) {
  return `${(Number(seconds) || 0).toFixed(1)}s`;
}

function clampNumber(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }

  return Math.min(max, Math.max(min, numeric));
}

function getSequenceDuration() {
  return state.sequence.reduce(
    (sum, clip) => sum + Math.max(0, Number(clip.trimEnd) - Number(clip.trimStart)),
    0,
  );
}

function selectedLibraryClip() {
  return state.library.find((item) => item.id === state.selectedLibraryId) || null;
}

function selectedSequenceClip() {
  return state.sequence.find((item) => item.id === state.selectedSequenceId) || null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setStatus(label, text, percent = null) {
  els.progressLabel.textContent = label;
  els.statusText.textContent = text;

  if (percent !== null) {
    els.progressBar.style.width = `${percent}%`;
  }
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
      state.selectedSequenceId = null;
      render();
      previewLibraryClip(clip);
    });
    card.addEventListener("dblclick", () => addSelectedLibraryClipToSequence(clip.id));

    card.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(clip.name)}</strong>
        <span class="badge warm">${formatDuration(clip.duration)}</span>
      </div>
      <div class="item-meta">
        <span class="badge">${clip.width && clip.height ? `${clip.width}x${clip.height}` : "Unknown size"}</span>
        <span class="badge">${clip.hasAudio ? "Audio" : "Silent"}</span>
        <span class="badge cool">${escapeHtml(clip.sizeLabel || "File")}</span>
      </div>
    `;

    els.libraryList.appendChild(card);
  });
}

function renderSequence() {
  const runtime = getSequenceDuration();
  els.sequenceCount.textContent = `${state.sequence.length} clip${state.sequence.length === 1 ? "" : "s"}`;
  els.sequenceRuntime.textContent = `${formatDuration(runtime)} total`;
  els.sequenceDurationChip.textContent = `Timeline ${formatDuration(runtime)}`;

  if (state.sequence.length === 0) {
    els.sequenceList.className = "sequence-list empty-state";
    els.sequenceList.textContent = "Add clips from the media bin and arrange them in order.";
    return;
  }

  els.sequenceList.className = "sequence-list";
  els.sequenceList.innerHTML = "";

  state.sequence.forEach((clip, index) => {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `sequence-item${clip.id === state.selectedSequenceId ? " selected" : ""}`;
    element.addEventListener("click", () => {
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId = clip.mediaId;
      render();
      previewSequenceClip(clip);
    });

    const effectiveDuration = Math.max(0, clip.trimEnd - clip.trimStart);
    element.innerHTML = `
      <div class="sequence-item-content">
        <div class="item-title">
          <strong>${index + 1}. ${escapeHtml(clip.name)}</strong>
          <span class="badge warm">${formatDuration(effectiveDuration)}</span>
        </div>
        <div class="sequence-meta">
          <span class="badge">${formatPrecise(clip.trimStart)} in</span>
          <span class="badge">${formatPrecise(clip.trimEnd)} out</span>
          <span class="badge cool">${clip.hasAudio ? "Stereo export" : "Silent clip"}</span>
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

  els.inspectorEmpty.classList.add("hidden");
  els.clipInspector.classList.remove("hidden");
  els.clipName.value = clip.name;
  els.trimStart.value = clip.trimStart.toFixed(1);
  els.trimEnd.value = clip.trimEnd.toFixed(1);
  els.sourceDuration.textContent = formatPrecise(clip.sourceDuration);
  els.clipOutputDuration.textContent = formatPrecise(clip.trimEnd - clip.trimStart);
}

function renderOutputPath() {
  els.outputPath.value = state.outputPath;
  els.appendButton.disabled = !selectedLibraryClip();
  els.exportButton.disabled = state.exporting || state.sequence.length === 0;
  els.exportButton.textContent = state.outputPath
    ? "Export Timeline To MP4"
    : "Choose Export File & Render";
}

function render() {
  renderLibrary();
  renderSequence();
  renderInspector();
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
    trimEnd: clip.duration,
    hasAudio: clip.hasAudio,
    hasVideo: clip.hasVideo,
  };
}

function appendClipsToSequence(clips) {
  const newSequenceClips = clips.map(buildSequenceClip);
  state.sequence.push(...newSequenceClips);
  return newSequenceClips;
}

function loadPreview(clip, options = {}) {
  const token = createId("preview");
  const startAt = Number(options.startAt || 0);
  const endAt = options.endAt ?? null;
  const usingProxy = Boolean(options.proxyPath);

  state.previewContext = {
    token,
    clip,
    startAt,
    endAt,
    usingProxy,
    proxyPath: options.proxyPath || null,
    preparingProxy: false,
  };

  els.previewPlayer.pause();
  els.previewPlayer.src = window.editorAPI.toFileUrl(options.proxyPath || clip.path);
  els.previewPlayer.load();
  els.previewPlayer.addEventListener(
    "loadedmetadata",
    () => {
      if (state.previewContext?.token !== token) {
        return;
      }

      els.previewPlayer.currentTime = startAt;
    },
    { once: true },
  );
}

async function importVideos() {
  if (state.exporting) {
    return;
  }

  const filePaths = await window.editorAPI.openVideos();
  if (!filePaths?.length) {
    return;
  }

  setStatus("Inspecting", "Reading media metadata for imported files.");
  const results = await window.editorAPI.probeFiles(filePaths);
  const existingPaths = new Set(state.library.map((clip) => clip.path));
  const importedClips = [];

  results.forEach((result) => {
    if (result.error || existingPaths.has(result.path) || !result.hasVideo) {
      return;
    }

    const clip = {
      id: createId("media"),
      path: result.path,
      name: result.name,
      duration: result.duration,
      width: result.width,
      height: result.height,
      hasAudio: result.hasAudio,
      hasVideo: result.hasVideo,
      sizeLabel: result.sizeLabel,
    };

    state.library.push(clip);
    importedClips.push(clip);
    existingPaths.add(result.path);
  });

  if (importedClips.length > 0) {
    const newSequenceClips = appendClipsToSequence(importedClips);
    const primaryLibraryClip = importedClips[0];
    const primarySequenceClip = newSequenceClips[0];

    state.selectedLibraryId = primaryLibraryClip.id;
    state.selectedSequenceId = primarySequenceClip.id;
    render();
    previewSequenceClip(primarySequenceClip);
    setStatus(
      "Ready",
      `Imported ${importedClips.length} clip${importedClips.length === 1 ? "" : "s"} and added them to the timeline.`,
      0,
    );
    return;
  }

  if (state.library.length > 0 && !state.selectedLibraryId) {
    state.selectedLibraryId = state.library[0].id;
  }

  render();
  setStatus("Ready", "No new playable clips were added from that selection.", 0);
}

function addSelectedLibraryClipToSequence(explicitId = null) {
  if (state.exporting) {
    return;
  }

  const clip = state.library.find((item) => item.id === (explicitId || state.selectedLibraryId));
  if (!clip) {
    return;
  }

  const [sequenceClip] = appendClipsToSequence([clip]);
  state.selectedSequenceId = sequenceClip.id;
  state.selectedLibraryId = clip.id;
  render();
  previewSequenceClip(sequenceClip);
}

function previewLibraryClip(clip) {
  els.previewTitle.textContent = clip.name;
  els.previewMeta.textContent = `${formatDuration(clip.duration)} source`;
  els.previewHint.textContent = clip.hasAudio
    ? "Source clip loaded. Double-click it to add it to the sequence."
    : "This source clip has no audio track. The exporter will generate silence for it.";
  state.previewBounds = null;
  loadPreview(clip, { startAt: 0 });
}

function previewSequenceClip(clip) {
  els.previewTitle.textContent = clip.name;
  els.previewMeta.textContent = `${formatPrecise(clip.trimStart)} to ${formatPrecise(clip.trimEnd)}`;
  els.previewHint.textContent = "Preview respects the current trim range and pauses at the clip out point.";
  state.previewBounds = { start: clip.trimStart, end: clip.trimEnd };
  loadPreview(clip, { startAt: clip.trimStart, endAt: clip.trimEnd });
}

function bindTrimInputs() {
  const commit = () => {
    const clip = selectedSequenceClip();
    if (!clip) {
      return;
    }

    const nextStart = clampNumber(els.trimStart.value, 0, clip.sourceDuration);
    const nextEnd = clampNumber(els.trimEnd.value, nextStart + 0.1, clip.sourceDuration);
    clip.trimStart = Number(nextStart.toFixed(1));
    clip.trimEnd = Number(nextEnd.toFixed(1));
    renderInspector();
    renderSequence();
    previewSequenceClip(clip);
  };

  els.trimStart.addEventListener("change", commit);
  els.trimEnd.addEventListener("change", commit);
}

function moveSelectedClip(direction) {
  const index = state.sequence.findIndex((clip) => clip.id === state.selectedSequenceId);
  if (index === -1) {
    return;
  }

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.sequence.length) {
    return;
  }

  const [clip] = state.sequence.splice(index, 1);
  state.sequence.splice(nextIndex, 0, clip);
  renderSequence();
}

function removeSelectedClip() {
  const index = state.sequence.findIndex((clip) => clip.id === state.selectedSequenceId);
  if (index === -1) {
    return;
  }

  state.sequence.splice(index, 1);
  state.selectedSequenceId = state.sequence[index]?.id || state.sequence[index - 1]?.id || null;
  render();

  const clip = selectedSequenceClip();
  if (clip) {
    previewSequenceClip(clip);
  } else if (selectedLibraryClip()) {
    previewLibraryClip(selectedLibraryClip());
  } else {
    state.previewContext = null;
    state.previewBounds = null;
    els.previewPlayer.removeAttribute("src");
    els.previewPlayer.load();
    els.previewTitle.textContent = "No clip selected";
    els.previewMeta.textContent = "Ready";
    els.previewHint.textContent = "Select a clip in the media bin or sequence to preview it here.";
  }
}

async function chooseOutputPath() {
  const suggestedName = `cutline-export-${Date.now()}.mp4`;
  const outputPath = await window.editorAPI.saveExport(suggestedName);
  if (!outputPath) {
    return null;
  }

  state.outputPath = outputPath;
  renderOutputPath();
  setStatus("Ready", "Export target chosen. Render the timeline when you are ready.", 0);
  return outputPath;
}

function getExportSettings() {
  const [width, height] = els.resolutionPreset.value.split("x").map(Number);
  return {
    width,
    height,
    fps: Number(els.fps.value) || 30,
    crf: Number(els.crf.value) || 20,
    videoPreset: els.videoPreset.value,
  };
}

async function exportTimeline() {
  if (state.exporting || state.sequence.length === 0) {
    return;
  }

  if (!state.outputPath) {
    const outputPath = await chooseOutputPath();
    if (!outputPath) {
      return;
    }
  }

  state.exporting = true;
  renderOutputPath();
  setStatus("Rendering", "FFmpeg is combining your sequence into one MP4.", 2);

  try {
    const clips = state.sequence.map((clip) => ({
      path: clip.path,
      name: clip.name,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      sourceDuration: clip.sourceDuration,
      hasAudio: clip.hasAudio,
      hasVideo: clip.hasVideo,
    }));

    const result = await window.editorAPI.exportProject({
      clips,
      outputPath: state.outputPath,
      settings: getExportSettings(),
    });

    setStatus(
      "Finished",
      `Rendered ${result.clipCount} clip${result.clipCount === 1 ? "" : "s"} to ${result.outputPath}`,
      100,
    );
  } catch (error) {
    setStatus("Export Failed", error.message || "The export did not complete.", 0);
  } finally {
    state.exporting = false;
    renderOutputPath();
  }
}

function wireEvents() {
  els.importButton.addEventListener("click", importVideos);
  els.appendButton.addEventListener("click", () => addSelectedLibraryClipToSequence());
  els.browseOutput.addEventListener("click", chooseOutputPath);
  els.exportButton.addEventListener("click", exportTimeline);
  els.moveClipUp.addEventListener("click", () => moveSelectedClip(-1));
  els.moveClipDown.addEventListener("click", () => moveSelectedClip(1));
  els.removeClip.addEventListener("click", removeSelectedClip);
  bindTrimInputs();

  els.previewPlayer.addEventListener("timeupdate", () => {
    if (!state.previewBounds) {
      return;
    }

    if (els.previewPlayer.currentTime >= state.previewBounds.end) {
      els.previewPlayer.pause();
      els.previewPlayer.currentTime = state.previewBounds.start;
    }
  });

  els.previewPlayer.addEventListener("error", async () => {
    const context = state.previewContext;
    if (!context || context.usingProxy || context.preparingProxy) {
      return;
    }

    context.preparingProxy = true;
    els.previewHint.textContent =
      "This source format needs a compatible preview copy. Preparing preview media now.";

    try {
      const proxyPath = await window.editorAPI.preparePreview(context.clip.path);
      if (state.previewContext?.token !== context.token) {
        return;
      }

      els.previewHint.textContent = "Using a compatible preview copy for this clip.";
      loadPreview(context.clip, {
        startAt: context.startAt,
        endAt: context.endAt,
        proxyPath,
      });
    } catch (error) {
      if (state.previewContext?.token !== context.token) {
        return;
      }

      els.previewHint.textContent =
        "Preview could not be loaded for this file, but you can still export the combined video.";
      setStatus("Preview Failed", error.message || "Could not prepare a preview copy.", 0);
    } finally {
      if (state.previewContext?.token === context.token) {
        state.previewContext.preparingProxy = false;
      }
    }
  });

  window.editorAPI.onExportProgress((progress) => {
    if (!state.exporting) {
      return;
    }

    const percent = Number(progress.percent || 0);
    const label = progress.status === "done" ? "Finishing" : "Rendering";
    const current = formatDuration(progress.currentTimeSeconds || 0);
    const total = formatDuration(progress.totalDuration || getSequenceDuration());
    setStatus(label, `${percent}% complete • ${current} of ${total}`, percent);
  });
}

wireEvents();
render();
