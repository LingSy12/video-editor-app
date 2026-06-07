const state = {
  library: [],
  // Legacy fields — kept as arrays that ALIAS the first V / A track's `clips`
  // array via shared reference. Most existing code keeps reading/writing
  // `state.sequence` and `state.audioClips`; tracks[0].clips and the first
  // audio track's `clips` are the SAME array, so mutations stay in sync.
  sequence: [],
  audioClips: [],
  // Multi-track structure (剪映 model). Order in this array == top-to-bottom
  // visual order in the timeline panel (video tracks above audio tracks).
  // Each track: { id, kind: "video"|"audio", name, locked, hidden, muted,
  // solo, clips: [...] }. V-track clips are still currently concatenated
  // (legacy V1 behavior); audio-track clips have explicit timelineStart.
  tracks: [],
  selectedLibraryId: null,
  selectedSequenceId: null,
  // When set, refers to an A-track clip selection (mutually exclusive with
  // selectedSequenceId — only one track-clip selected at a time).
  selectedAudioClipId: null,
  selectedTrackId: null,
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
  // User-driven zoom for the visual timeline. 1 = fit-to-width (default);
  // higher zooms in (Ctrl+Wheel). Clamped to [1, 20]. Persisted only for the
  // current session; resets on relaunch.
  timelineZoom: 1,
  // Horizontal scroll position of the timeline (px). Preserved across every
  // render() so unrelated re-renders (playhead tick, inspector refresh) don't
  // snap the user back to t=0 mid-edit. Updated on user scroll + Ctrl+Wheel.
  timelineScrollLeft: 0,
  // Snap-to-edges flag (toggled by the S key). When false, _snapDragX returns
  // proposed positions unchanged and no guide line is shown.
  snapEnabled: true,
  // Program-monitor zoom + pan. Applied via CSS transform to the active
  // <video> element; reset on double-click. 1 = native fit.
  previewZoom: 1,
  previewPanX: 0,
  previewPanY: 0,
  // Secondary selection set for Shift+Click multi-select. Anchors at the
  // primary selectedSequenceId; cleared on plain clicks.
  multiSelectIds: [],
  // Project save path (set by Save As / Open). null = unsaved scratch project.
  projectPath: null,
  // Currently-selected subtitle cue id (mutually exclusive with V/A selections).
  selectedSubtitleId: null,
  // Font size (px) for the preview-overlay subtitle text. The CSS overlay
  // reads this via a CSS variable so the slider updates without a re-render.
  subtitleFontPx: 18,
  // Subtitle overlay position (vertical % from top, horizontal % from left).
  // 50/85 = horizontally centered, near-bottom (mimics burnt-in TV subtitles).
  // User can drag the overlay in the preview to update these.
  subtitleOverlayX: 50,
  subtitleOverlayY: 85,
  // UI language ("zh" or "en"). Persisted in localStorage. Static HTML labels
  // are toggled via CSS (.lang-zh / .lang-en spans + body[data-lang]) so we
  // don't need a re-render to switch languages.
  uiLanguage: "zh",
};

// Initialize V1 + A1 as the legacy tracks aliasing existing arrays.
state.tracks = [
  { id: "video-0", kind: "video", name: "V1", locked: false, hidden: false, clips: state.sequence },
  { id: "audio-0", kind: "audio", name: "A1", locked: false, muted: false, solo: false, clips: state.audioClips },
];

// ── Undo / Redo history ─────────────────────────────────────────────────
// We snapshot the parts of state that hold user edits (sequence + selection
// + timeline cursor) before each mutation. Pure UI/preview state isn't part
// of the snapshot — it's recomputed from the restored sequence.
const _history = {
  undoStack: [],
  redoStack: [],
  limit: 60,
};

function _snapshotEditState() {
  return JSON.stringify({
    // Snapshot the full tracks array so adding/removing tracks is undoable.
    // sequence + audioClips are derived (they alias tracks[*].clips) so we
    // don't serialize them separately.
    tracks: state.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      locked: !!t.locked,
      hidden: !!t.hidden,
      muted: !!t.muted,
      solo: !!t.solo,
      clips: t.clips,
    })),
    selectedSequenceId: state.selectedSequenceId,
    selectedAudioClipId: state.selectedAudioClipId,
    selectedSubtitleId: state.selectedSubtitleId,
    selectedLibraryId: state.selectedLibraryId,
    selectedTrackId: state.selectedTrackId,
    timelineCursor: state.timelineCursor,
  });
}

function _restoreEditState(snapshot) {
  const data = JSON.parse(snapshot);
  if (Array.isArray(data.tracks) && data.tracks.length > 0) {
    state.tracks = data.tracks.map((t) => ({ ...t, clips: t.clips || [] }));
  }
  // Re-point the legacy aliases at the first V / A track in the restored
  // structure so external references stay valid.
  state.sequence = (state.tracks.find((t) => t.kind === "video") || { clips: [] }).clips;
  state.audioClips = (state.tracks.find((t) => t.kind === "audio") || { clips: [] }).clips;
  state.selectedSequenceId = data.selectedSequenceId || null;
  state.selectedAudioClipId = data.selectedAudioClipId || null;
  state.selectedSubtitleId = data.selectedSubtitleId || null;
  state.selectedLibraryId = data.selectedLibraryId || null;
  state.selectedTrackId = data.selectedTrackId || null;
  state.timelineCursor = Number(data.timelineCursor) || 0;
}

// ── Track-list helpers ─────────────────────────────────────────────────
function getVideoTracks() {
  return state.tracks.filter((t) => t.kind === "video");
}
function getAudioTracks() {
  return state.tracks.filter((t) => t.kind === "audio");
}
function getSubtitleTracks() {
  return state.tracks.filter((t) => t.kind === "subtitle");
}
// Lazily create / fetch the first subtitle track. We don't include one by
// default to keep the default UI uncluttered for users who never use captions.
function getOrCreateFirstSubtitleTrack() {
  let t = getSubtitleTracks()[0];
  if (t) return t;
  t = { id: _generateTrackId("subtitle"), kind: "subtitle", name: "S1", locked: false, hidden: false, clips: [] };
  state.tracks.push(t);
  return t;
}
function getTrackById(id) {
  return state.tracks.find((t) => t.id === id) || null;
}
// Search every track for a clip and return { track, clip } or null.
function findClipOwner(clipId) {
  for (const t of state.tracks) {
    const c = t.clips.find((c) => c.id === clipId);
    if (c) return { track: t, clip: c };
  }
  return null;
}
function _generateTrackId(kind) {
  const existing = state.tracks
    .filter((t) => t.kind === kind)
    .map((t) => Number((t.id.match(/-(\d+)$/) || [])[1]))
    .filter((n) => Number.isFinite(n));
  const next = (existing.length === 0 ? -1 : Math.max(...existing)) + 1;
  return `${kind}-${next}`;
}
function _generateTrackName(kind) {
  const prefix = kind === "video" ? "V" : kind === "audio" ? "A" : "S";
  const sameKind = state.tracks.filter((t) => t.kind === kind);
  return `${prefix}${sameKind.length + 1}`;
}
function addTrack(kind) {
  if (state.exporting) return;
  if (kind !== "video" && kind !== "audio" && kind !== "subtitle") return;
  pushHistorySnapshot();
  const track = {
    id: _generateTrackId(kind),
    kind,
    name: _generateTrackName(kind),
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
    clips: [],
  };
  // Insert video above first audio; audio above first subtitle; subtitle at end.
  if (kind === "video") {
    const firstAudioIdx = state.tracks.findIndex((t) => t.kind === "audio");
    if (firstAudioIdx === -1) state.tracks.push(track);
    else state.tracks.splice(firstAudioIdx, 0, track);
  } else if (kind === "audio") {
    const firstSubIdx = state.tracks.findIndex((t) => t.kind === "subtitle");
    if (firstSubIdx === -1) state.tracks.push(track);
    else state.tracks.splice(firstSubIdx, 0, track);
  } else {
    state.tracks.push(track);
  }
  state.selectedTrackId = track.id;
  render();
  refreshExportEstimate();
}
function removeTrack(id) {
  if (state.exporting) return;
  const idx = state.tracks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const track = state.tracks[idx];
  // Don't allow removing the LAST video or LAST audio track — keep one of
  // each as a baseline so the rest of the app's assumptions hold.
  const remainingOfKind = state.tracks.filter((t) => t.kind === track.kind && t.id !== id);
  if (remainingOfKind.length === 0) return;
  pushHistorySnapshot();
  state.tracks.splice(idx, 1);
  // Re-point legacy aliases if they pointed at the removed track.
  state.sequence = (state.tracks.find((t) => t.kind === "video") || { clips: [] }).clips;
  state.audioClips = (state.tracks.find((t) => t.kind === "audio") || { clips: [] }).clips;
  if (state.selectedTrackId === id) state.selectedTrackId = null;
  render();
  refreshExportEstimate();
}
function toggleTrackFlag(id, flag) {
  if (state.exporting) return;
  const t = getTrackById(id);
  if (!t) return;
  pushHistorySnapshot();
  t[flag] = !t[flag];
  render();
  refreshExportEstimate();
}

function pushHistorySnapshot() {
  _history.undoStack.push(_snapshotEditState());
  if (_history.undoStack.length > _history.limit) _history.undoStack.shift();
  _history.redoStack.length = 0;
  // Defined further down (after the import / project helpers); guard for the
  // initial-load case where it may not be defined yet.
  if (typeof scheduleAutosave === "function") scheduleAutosave();
}

function _applyRestoredSnapshot() {
  // Clamp cursor + selection in case the restored snapshot is out of sync
  // with the current preview state (it should be, but defensive).
  state.timelineCursor = clampNumberMaybe(state.timelineCursor, 0, getSequenceDuration());
  // After undo/redo a clip on V2/V3 may have vanished; look across all V
  // tracks before declaring the selection dead.
  if (state.selectedSequenceId && !findClipOwner(state.selectedSequenceId)) {
    const remaining = getVideoTracks().flatMap((t) => t.clips)[0];
    state.selectedSequenceId = remaining?.id || null;
  }
  if (state.selectedAudioClipId && !findClipOwner(state.selectedAudioClipId)) {
    state.selectedAudioClipId = null;
  }
  // Re-anchor the program monitor to whatever the restored cursor/selection says.
  if (state.sequence.length > 0) {
    const seg = state.selectedSequenceId
      ? getSequenceSegmentByClipId(state.selectedSequenceId)
      : findTimelineSegment(state.timelineCursor);
    if (seg) {
      previewTimelineAt(state.timelineCursor || seg.start, { forceReload: true });
    }
  } else if (state.selectedLibraryId) {
    const clip = getLibraryClipById(state.selectedLibraryId);
    if (clip) previewLibraryClip(clip);
  } else {
    _clearActivePreview();
    els.previewTitle.textContent = "No clip selected";
    els.previewMeta.textContent = "Ready";
    els.previewHint.textContent = "Select a clip in the media bin or sequence to preview it here.";
  }
  render();
  refreshExportEstimate();
}

function undo() {
  if (_history.undoStack.length === 0 || state.exporting) return;
  _history.redoStack.push(_snapshotEditState());
  _restoreEditState(_history.undoStack.pop());
  _applyRestoredSnapshot();
}

function redo() {
  if (_history.redoStack.length === 0 || state.exporting) return;
  _history.undoStack.push(_snapshotEditState());
  _restoreEditState(_history.redoStack.pop());
  _applyRestoredSnapshot();
}

// ── i18n: key-based translations for JS-built dynamic text ─────────────
// Static HTML labels are toggled purely via CSS (.lang-zh / .lang-en spans
// + body[data-lang]) so they don't go through here. This map covers messages
// we build in JS — status notifications, modal titles, tooltips, etc.
const I18N = {
  zh: {
    "status.ready": "就绪",
    "status.idle": "空闲",
    "status.copied": "已复制",
    "status.pasted": "已粘贴",
    "status.deleted": "已删除",
    "status.saved": "已保存",
    "status.split": "已切分",
    "status.duplicated": "已克隆",
    "status.rippleDeleted": "涟漪删除完成",
    "status.snapOn": "吸附 开",
    "status.snapOff": "吸附 关",
    "status.empty": "为空",
    "status.locked": "已锁定",
    "status.timelineEmpty": "时间线为空 — 先添加视频片段。",
    "status.opened": "已加载工程",
    "status.openFailed": "打开失败",
    "status.saveFailed": "保存失败",
    "status.exportFailed": "导出失败",
    "status.importFailed": "导入失败",
    "status.exportFinished": "导出完成",
    "preview.noClip": "未选中片段",
    "preview.timelineHint": "时间线预览，支持毫秒级精度。",
    "preview.libraryHint": "选中后双击可加入时间线。",
    "preview.selectHint": "在媒体库或时间线里选一个片段开始预览。",
    "timelineNotLoaded": "时间线未加载",
    "timelinePreview": "时间线预览",
    "clipPreview": "片段预览",
  },
  en: {
    "status.ready": "Ready",
    "status.idle": "Idle",
    "status.copied": "Copied",
    "status.pasted": "Pasted",
    "status.deleted": "Deleted",
    "status.saved": "Saved",
    "status.split": "Split",
    "status.duplicated": "Duplicated",
    "status.rippleDeleted": "Ripple Deleted",
    "status.snapOn": "Snap ON",
    "status.snapOff": "Snap OFF",
    "status.empty": "Empty",
    "status.locked": "Locked",
    "status.timelineEmpty": "Timeline is empty — add clips first.",
    "status.opened": "Project opened",
    "status.openFailed": "Open failed",
    "status.saveFailed": "Save failed",
    "status.exportFailed": "Export failed",
    "status.importFailed": "Import failed",
    "status.exportFinished": "Export finished",
    "preview.noClip": "No clip selected",
    "preview.timelineHint": "Timeline preview with millisecond-accurate scrubbing.",
    "preview.libraryHint": "Double-click in the media bin to add it to the timeline.",
    "preview.selectHint": "Select a clip in the media bin or timeline to preview.",
    "timelineNotLoaded": "Timeline not loaded",
    "timelinePreview": "Timeline Preview",
    "clipPreview": "Clip Preview",
  },
};

// Translate a key into the current language. Falls back to the key itself if
// no translation exists, so missing entries are easy to spot.
function t(key) {
  const lang = state.uiLanguage === "en" ? "en" : "zh";
  return I18N[lang]?.[key] ?? I18N.zh[key] ?? key;
}

// Apply the chosen language by flipping body[data-lang] (drives the
// .lang-zh / .lang-en CSS toggle) and refreshing any JS-built dynamic UI
// that depends on the language map.
function applyLanguage(lang) {
  const normalized = lang === "en" ? "en" : "zh";
  state.uiLanguage = normalized;
  document.body.setAttribute("data-lang", normalized);
  document.documentElement.lang = normalized === "en" ? "en" : "zh-CN";
  // Keep the topbar <select> in sync when the language is set programmatically
  // (e.g. on app start from localStorage) — otherwise the dropdown can sit on
  // a stale value.
  if (els?.languageSelect && els.languageSelect.value !== normalized) {
    els.languageSelect.value = normalized;
  }
  try { localStorage.setItem("cutline.uiLanguage", normalized); } catch {}
  // Re-render the parts that pull strings from t() at build time.
  try { render(); } catch {}
}

// Defensive number clamp used during history restore — defined inline because
// `clampNumber` lives further down in the file and history is declared up top.
function clampNumberMaybe(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return min;
  return Math.min(max, Math.max(min, numeric));
}

const els = {
  importButton: document.getElementById("importButton"),
  appendButton: document.getElementById("appendButton"),
  libraryList: document.getElementById("libraryList"),
  libraryCount: document.getElementById("libraryCount"),
  // `previewPlayer` is defined as a getter below — it always points to the
  // currently active <video> element in the per-source video pool.
  previewTitle: document.getElementById("previewTitle"),
  previewMeta: document.getElementById("previewMeta"),
  previewHint: document.getElementById("previewHint"),
  previewModeChip: document.getElementById("previewModeChip"),
  sequenceDurationChip: document.getElementById("sequenceDurationChip"),
  previewZoomLabel: document.getElementById("previewZoomLabel"),
  previewSubtitleOverlay: document.getElementById("previewSubtitleOverlay"),
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
  timelineZoomPill: document.getElementById("timelineZoomPill"),
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
  clipSpeed: document.getElementById("clipSpeed"),
  clipFadeIn: document.getElementById("clipFadeIn"),
  clipFadeOut: document.getElementById("clipFadeOut"),
  clipGain: document.getElementById("clipGain"),
  clipGainLabel: document.getElementById("clipGainLabel"),
  // Subtitle inspector
  subtitleClipInspector: document.getElementById("subtitleClipInspector"),
  subtitleCueText: document.getElementById("subtitleCueText"),
  subtitleCueStart: document.getElementById("subtitleCueStart"),
  subtitleCueDuration: document.getElementById("subtitleCueDuration"),
  subtitleFontSize: document.getElementById("subtitleFontSize"),
  subtitleFontSizeLabel: document.getElementById("subtitleFontSizeLabel"),
  splitSubtitleAtPlayhead: document.getElementById("splitSubtitleAtPlayhead"),
  removeSubtitleButton: document.getElementById("removeSubtitleButton"),
  // Audio clip inspector
  audioClipInspector: document.getElementById("audioClipInspector"),
  audioClipName: document.getElementById("audioClipName"),
  audioTrimStart: document.getElementById("audioTrimStart"),
  audioTrimEnd: document.getElementById("audioTrimEnd"),
  audioTimelineStart: document.getElementById("audioTimelineStart"),
  audioGain: document.getElementById("audioGain"),
  audioGainLabel: document.getElementById("audioGainLabel"),
  audioFadeIn: document.getElementById("audioFadeIn"),
  audioFadeOut: document.getElementById("audioFadeOut"),
  removeAudioClipButton: document.getElementById("removeAudioClipButton"),
  renderMode: document.getElementById("renderMode"),
  aspectPreset: document.getElementById("aspectPreset"),
  customSizeFields: document.getElementById("customSizeFields"),
  customWidth: document.getElementById("customWidth"),
  customHeight: document.getElementById("customHeight"),
  aspectSummary: document.getElementById("aspectSummary"),
  resolutionPreset: document.getElementById("resolutionPreset"),
  fps: document.getElementById("fps"),
  videoBitrate: document.getElementById("videoBitrate"),
  videoCodec: document.getElementById("videoCodec"),
  crf: document.getElementById("crf"),
  videoPreset: document.getElementById("videoPreset"),
  audioFormat: document.getElementById("audioFormat"),
  audioBitrate: document.getElementById("audioBitrate"),
  renderCapability: document.getElementById("renderCapability"),
  estimatedSize: document.getElementById("estimatedSize"),
  estimatedRenderTime: document.getElementById("estimatedRenderTime"),
  estimatedDuration: document.getElementById("estimatedDuration"),
  exportFootnote: document.getElementById("exportFootnote"),
  progressBar: document.getElementById("progressBar"),
  progressLabel: document.getElementById("progressLabel"),
  statusText: document.getElementById("statusText"),
  rowDivider: document.getElementById("rowDivider"),
  undoButton: document.getElementById("undoButton"),
  redoButton: document.getElementById("redoButton"),
  languageSelect: document.getElementById("languageSelect"),
  openProjectButton: document.getElementById("openProjectButton"),
  saveProjectButton: document.getElementById("saveProjectButton"),
  recentProjectsButton: document.getElementById("recentProjectsButton"),
  importSubtitleButton: document.getElementById("importSubtitleButton"),
  generateSubtitleButton: document.getElementById("generateSubtitleButton"),
  exportSubtitleButton: document.getElementById("exportSubtitleButton"),
  generateSubtitleModal: document.getElementById("generateSubtitleModal"),
  closeGenerateSubtitleModal: document.getElementById("closeGenerateSubtitleModal"),
  cancelGenerateSubtitle: document.getElementById("cancelGenerateSubtitle"),
  confirmGenerateSubtitle: document.getElementById("confirmGenerateSubtitle"),
  ytsubRoot: document.getElementById("ytsubRoot"),
  ytsubRootBrowse: document.getElementById("ytsubRootBrowse"),
  ytsubResetRoot: document.getElementById("ytsubResetRoot"),
  ytsubEngineStatus: document.getElementById("ytsubEngineStatus"),
  setupEngineButton: document.getElementById("setupEngineButton"),
  ytsubModel: document.getElementById("ytsubModel"),
  ytsubDevice: document.getElementById("ytsubDevice"),
  ytsubLanguage: document.getElementById("ytsubLanguage"),
  ytsubSource: document.getElementById("ytsubSource"),
  ytsubLowVram: document.getElementById("ytsubLowVram"),
  ytsubAccurate: document.getElementById("ytsubAccurate"),
  ytsubPrompt: document.getElementById("ytsubPrompt"),
  ytsubProgressBar: document.getElementById("ytsubProgressBar"),
  ytsubStatus: document.getElementById("ytsubStatus"),
  ytsubEta: document.getElementById("ytsubEta"),
  // Export modal
  openExportButton: document.getElementById("openExportButton"),
  exportModal: document.getElementById("exportModal"),
  closeExportModal: document.getElementById("closeExportModal"),
  cancelExportModal: document.getElementById("cancelExportModal"),
  confirmExportButton: document.getElementById("confirmExportButton"),
  exportSequenceName: document.getElementById("exportSequenceName"),
  exportTitle: document.getElementById("exportTitle"),
  exportFolderPath: document.getElementById("exportFolderPath"),
  exportFolderBrowse: document.getElementById("exportFolderBrowse"),
  exportModalTitleLabel: document.getElementById("exportModalTitleLabel"),
  enableVideoExport: document.getElementById("enableVideoExport"),
  enableAudioExport: document.getElementById("enableAudioExport"),
  exportPreset: document.getElementById("exportPreset"),
  audioSampleRate: document.getElementById("audioSampleRate"),
  videoContainer: document.getElementById("videoContainer"),
  estimatedDurationModal: document.getElementById("estimatedDurationModal"),
};

// ── Video pool ───────────────────────────────────────────────────────────
// One <video> element per unique source path, all stacked inside the
// preview-stage. Switching between sources is a `display` swap instead of an
// HTML5 video reload, so hover-scrubbing across clip boundaries shows the new
// frame instantly (no black flash, no decoder warm-up wait).
const _previewStageEl = document.querySelector(".preview-stage");
const _initialVideo = document.getElementById("previewPlayer");
if (_initialVideo) {
  // Layout the initial element the same way as future pool members so swaps
  // are seamless.
  _initialVideo.style.position = "absolute";
  _initialVideo.style.inset = "0";
  // `metadata` is lighter than `auto` — with multiple 1-2 hr proxies in the
  // pool, `auto` would have the browser eagerly download hundreds of MB per
  // entry and starve decoders. The active video loads more bytes on demand
  // when it's seeked / played, which is what we actually need.
  _initialVideo.preload = "metadata";
}
const _videoPool = new Map(); // sourcePath -> { video, lastUsed }
const _POOL_LIMIT = 8;
const _POOL_EVENT_HANDLERS = {}; // populated by wirePreviewEvents
let _initialVideoAssigned = false;
let _activeVideoEl = _initialVideo;

Object.defineProperty(els, "previewPlayer", {
  configurable: true,
  get() { return _activeVideoEl; },
});

function _attachPoolHandlers(video) {
  if (!video || video.dataset.poolHandlersAttached) return;
  for (const [event, handler] of Object.entries(_POOL_EVENT_HANDLERS)) {
    video.addEventListener(event, handler);
  }
  video.dataset.poolHandlersAttached = "1";
}

function _createPoolVideo(sourcePath) {
  const v = document.createElement("video");
  v.preload = "metadata";
  v.controls = false;
  v.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#010408;display:none;";
  v.src = window.editorAPI.toFileUrl(sourcePath);
  // If this pool entry's source genuinely can't load (corrupt proxy, missing
  // file, format Chromium refuses), drop the entry so we don't keep serving
  // a dead element. The next request will rebuild — possibly after the proxy
  // re-generates with the new robustness flags.
  v.addEventListener("error", () => {
    if (v === _activeVideoEl) return; // active errors are handled by the main pool error handler
    for (const [k, entry] of _videoPool) {
      if (entry.video === v) {
        _videoPool.delete(k);
        break;
      }
    }
    if (v.parentNode) v.remove();
  });
  _attachPoolHandlers(v);
  const overlay = _previewStageEl?.querySelector(".preview-overlay");
  if (overlay) _previewStageEl.insertBefore(v, overlay);
  else _previewStageEl?.appendChild(v);
  return v;
}

function _evictLruPoolEntry() {
  let oldestKey = null;
  let oldestTime = Infinity;
  for (const [k, entry] of _videoPool) {
    if (entry.video === _activeVideoEl) continue;
    if (entry.video === _initialVideo) continue; // keep the static element alive
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = k;
    }
  }
  if (oldestKey == null) return;
  const old = _videoPool.get(oldestKey);
  old.video.pause();
  old.video.removeAttribute("src");
  old.video.load();
  old.video.remove();
  _videoPool.delete(oldestKey);
}

function _getOrCreatePoolVideo(sourcePath) {
  const existing = _videoPool.get(sourcePath);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.video;
  }
  if (_videoPool.size >= _POOL_LIMIT) _evictLruPoolEntry();

  let video;
  if (!_initialVideoAssigned && _initialVideo) {
    video = _initialVideo;
    video.src = window.editorAPI.toFileUrl(sourcePath);
    video.load();
    _initialVideoAssigned = true;
    _attachPoolHandlers(video);
  } else {
    video = _createPoolVideo(sourcePath);
  }
  _videoPool.set(sourcePath, { video, lastUsed: Date.now(), sourcePath });
  return video;
}

// Seek the program-monitor video. fastSeek snaps to the nearest keyframe
// instead of doing a frame-accurate seek — much cheaper, perfect for hover
// scrubbing. Falls back to plain currentTime= when fastSeek isn't available.
function _seekVideo(video, time, { fast = false } = {}) {
  if (!video) return;
  const target = Math.max(0, Number(time) || 0);
  if (Math.abs(video.currentTime - target) <= 0.02) return;
  if (fast && typeof video.fastSeek === "function") {
    video.fastSeek(target);
  } else {
    video.currentTime = target;
  }
}

// ── Program-monitor zoom + pan ──────────────────────────────────────
// Applies state.previewZoom + state.previewPanX/Y as a CSS transform on the
// currently active <video>. Called from wheel/drag handlers and after every
// active-video swap so the new element picks up the same zoom level.
function _applyPreviewZoom() {
  if (!_activeVideoEl) return;
  const z = Math.max(0.25, Math.min(8, Number(state.previewZoom) || 1));
  const tx = Math.round(Number(state.previewPanX) || 0);
  const ty = Math.round(Number(state.previewPanY) || 0);
  _activeVideoEl.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  _activeVideoEl.style.transformOrigin = "center center";
}

// Wire the preview stage once on init. Ctrl+Wheel zooms around the cursor;
// plain wheel falls through (lets the user scroll the panel). Middle-button
// or Alt+drag pans when zoomed in. Double-click resets.
function wirePreviewStageZoom() {
  const stage = document.querySelector(".preview-stage");
  if (!stage) return;
  stage.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;
    const prev = Math.max(0.25, Math.min(8, Number(state.previewZoom) || 1));
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(0.25, Math.min(8, prev * factor));
    if (next === prev) return;
    // Zoom around the cursor: adjust pan so the same source pixel stays under
    // the cursor before/after the zoom.
    const ratio = next / prev;
    const px = Number(state.previewPanX) || 0;
    const py = Number(state.previewPanY) || 0;
    state.previewPanX = (px - offsetX) * ratio + offsetX;
    state.previewPanY = (py - offsetY) * ratio + offsetY;
    state.previewZoom = next;
    _applyPreviewZoom();
    _updatePreviewZoomLabel();
  }, { passive: false });

  // Pan: middle-mouse drag, or Alt+left-drag (so plain click on the video
  // still triggers native play/pause when in library mode).
  let dragging = null;
  stage.addEventListener("mousedown", (e) => {
    const isPanGesture = e.button === 1 || (e.button === 0 && e.altKey);
    if (!isPanGesture) return;
    if ((Number(state.previewZoom) || 1) <= 1.001) return; // no point panning at fit
    e.preventDefault();
    dragging = { startX: e.clientX, startY: e.clientY, origX: state.previewPanX, origY: state.previewPanY };
    stage.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    state.previewPanX = dragging.origX + (e.clientX - dragging.startX);
    state.previewPanY = dragging.origY + (e.clientY - dragging.startY);
    _applyPreviewZoom();
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = null;
    stage.style.cursor = "";
  });

  // Double-click = reset zoom + pan to fit.
  stage.addEventListener("dblclick", (e) => {
    // Don't fight the trim-handle dblclick or anything else with its own
    // handler; only act when the click target is the video itself.
    if (e.target?.tagName !== "VIDEO") return;
    if (state.previewZoom === 1 && state.previewPanX === 0 && state.previewPanY === 0) return;
    state.previewZoom = 1;
    state.previewPanX = 0;
    state.previewPanY = 0;
    _applyPreviewZoom();
    _updatePreviewZoomLabel();
  });
}

// Find the subtitle cue (if any) that covers the given timeline time. When
// multiple subtitle tracks have overlapping cues, the first matching (top-
// most) wins so the user can stack alternates and toggle by hiding tracks.
function findActiveSubtitleCueAt(time) {
  const t = Math.max(0, Number(time) || 0);
  for (const track of getSubtitleTracks()) {
    if (track.hidden) continue;
    for (const cue of track.clips) {
      const start = Number(cue.timelineStart) || 0;
      const end = start + (Number(cue.duration) || 0);
      if (t >= start && t < end) return cue;
    }
  }
  return null;
}

// Drag the subtitle overlay around the preview surface to relocate the cue.
// Persists the final position to localStorage so it survives reloads. The
// preview overlay is positioned via --cue-x/--cue-y CSS vars set in
// _updateSubtitleOverlay, so a drag only needs to update state + CSS vars.
const _subDrag = { active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 };
function _attachSubtitleOverlayDrag() {
  const overlay = els.previewSubtitleOverlay;
  const stage = overlay?.parentElement;
  if (!overlay || !stage) return;
  overlay.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    _subDrag.active = true;
    _subDrag.startX = e.clientX;
    _subDrag.startY = e.clientY;
    _subDrag.baseX = Number(state.subtitleOverlayX) || 50;
    _subDrag.baseY = Number(state.subtitleOverlayY) || 85;
  });
  window.addEventListener("mousemove", (e) => {
    if (!_subDrag.active) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dx = ((e.clientX - _subDrag.startX) / rect.width) * 100;
    const dy = ((e.clientY - _subDrag.startY) / rect.height) * 100;
    state.subtitleOverlayX = Math.max(2, Math.min(98, _subDrag.baseX + dx));
    state.subtitleOverlayY = Math.max(2, Math.min(98, _subDrag.baseY + dy));
    overlay.style.setProperty("--cue-x", `${state.subtitleOverlayX}%`);
    overlay.style.setProperty("--cue-y", `${state.subtitleOverlayY}%`);
  });
  window.addEventListener("mouseup", () => {
    if (!_subDrag.active) return;
    _subDrag.active = false;
    try {
      localStorage.setItem("cutline.subtitleOverlayX", String(state.subtitleOverlayX));
      localStorage.setItem("cutline.subtitleOverlayY", String(state.subtitleOverlayY));
    } catch {}
  });
}

// Push the current cue (or nothing) into the preview overlay. Called on every
// renderTimelineTransport tick so the overlay tracks playback / scrubbing.
function _updateSubtitleOverlay() {
  if (!els.previewSubtitleOverlay) return;
  // Apply the user-controlled font size as a CSS variable so the slider can
  // update the look without rebuilding the cue element each frame.
  const px = Math.max(8, Math.min(96, Number(state.subtitleFontPx) || 18));
  els.previewSubtitleOverlay.style.setProperty("--cue-font-size", `${px}px`);
  // Apply the user-controlled position as CSS variables.
  const ox = Math.max(0, Math.min(100, Number(state.subtitleOverlayX) || 50));
  const oy = Math.max(0, Math.min(100, Number(state.subtitleOverlayY) || 85));
  els.previewSubtitleOverlay.style.setProperty("--cue-x", `${ox}%`);
  els.previewSubtitleOverlay.style.setProperty("--cue-y", `${oy}%`);
  const cue = findActiveSubtitleCueAt(state.timelineCursor);
  if (!cue) {
    els.previewSubtitleOverlay.innerHTML = "";
    return;
  }
  // Render <br>-separated lines so multi-line cues display correctly without
  // letting raw HTML through (cue.text is user-provided / Whisper output).
  const html = String(cue.text || "")
    .split("\n")
    .map((line) => escapeHtml(line))
    .join("<br>");
  els.previewSubtitleOverlay.innerHTML = `<span class="cue">${html}</span>`;
}

function _updatePreviewZoomLabel() {
  if (els.previewZoomLabel) {
    const z = Math.max(0.25, Math.min(8, Number(state.previewZoom) || 1));
    els.previewZoomLabel.textContent = `${Math.round(z * 100)}%`;
    els.previewZoomLabel.classList.toggle("accent", Math.abs(z - 1) > 0.005);
  }
}

function _refreshActiveVideoControls() {
  if (!_activeVideoEl) return;
  // Native controls show the underlying source's local timeline (e.g. "3:28"
  // for a single clip) which is misleading in timeline-preview mode where the
  // sequence is supposed to feel like one combined video. Show them only in
  // library-mode preview (ad-hoc single-clip playback).
  const wants = state.previewMode === "library";
  if (_activeVideoEl.controls !== wants) _activeVideoEl.controls = wants;
  // Honor the per-clip detach/mute toggle so playback matches what the export
  // will produce.
  if (state.previewMode === "timeline" && state.previewContext?.sequenceId) {
    const clip = state.sequence.find((c) => c.id === state.previewContext.sequenceId);
    _activeVideoEl.muted = Boolean(clip?.audioMuted);
  } else {
    _activeVideoEl.muted = false;
  }
}

function _setActiveVideo(video) {
  if (_activeVideoEl === video) {
    // Re-running through this path is normal (loadPlayerSource is called from
    // many places); make sure controls track the latest mode even if we
    // didn't actually swap elements.
    _refreshActiveVideoControls();
    _applyPreviewZoom();
    return;
  }
  // Swap the active reference BEFORE pausing the previous element, so the
  // pause-event handler attached to it sees `this !== _activeVideoEl` and
  // doesn't cancel the playback monitor for the new active video.
  const previous = _activeVideoEl;
  _activeVideoEl = video;
  // Move the new active to the top of the stacking order (right before the
  // overlay) and show it BEFORE hiding the previous one. That way the preview
  // surface never goes blank between display swaps — the new frame is already
  // visible when the old element disappears.
  const overlay = _previewStageEl?.querySelector(".preview-overlay");
  if (overlay && video.parentNode === _previewStageEl) {
    _previewStageEl.insertBefore(video, overlay);
  }
  video.style.display = "block";
  _refreshActiveVideoControls();
  // Apply the current zoom/pan to the newly-active element so swaps don't
  // visually snap back to 100%.
  _applyPreviewZoom();
  if (previous) {
    previous.pause();
    previous.controls = false;
    previous.style.display = "none";
    previous.style.transform = "none";
  }
}

// Pre-create a pool entry for a media clip so the browser starts loading its
// data even before the user hovers/clicks on it. Makes the first hover into a
// clip instant instead of "load + flash" slow.
function warmUpPoolForClip(mediaClip) {
  if (!mediaClip) return;
  const sourcePath = mediaClip.previewPath || mediaClip.path;
  if (!sourcePath) return;
  _getOrCreatePoolVideo(sourcePath);
}

// Reset the preview surface when there's nothing to show. Drops the currently
// active video's pool entry so it doesn't linger as a stale (src-less) record.
function _clearActivePreview() {
  if (!_activeVideoEl) return;
  _activeVideoEl.pause();
  _activeVideoEl.controls = false;
  _activeVideoEl.style.display = "none";

  for (const [k, entry] of _videoPool) {
    if (entry.video === _activeVideoEl) {
      _videoPool.delete(k);
      break;
    }
  }

  if (_activeVideoEl === _initialVideo) {
    _initialVideo.removeAttribute("src");
    _initialVideo.load();
    _initialVideoAssigned = false;
  } else {
    const dead = _activeVideoEl;
    dead.removeAttribute("src");
    dead.load();
    dead.remove();
  }
  _activeVideoEl = _initialVideo;
}

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
  const segs = getSequenceSegments();
  if (segs.length === 0) return 0;
  return roundMs(Math.max(...segs.map((s) => s.end)));
}

function getSequenceSegments() {
  // Legacy entry point — returns V1's segments. Kept so existing call sites
  // (move/split/preview/etc.) keep working. Multi-V-track callers use
  // getVideoTrackSegments(track) directly.
  const v1 = getVideoTracks()[0];
  return v1 ? getVideoTrackSegments(v1) : [];
}

function getVideoTrackSegments(track) {
  if (!track) return [];
  // Backfill `timelineStart` for legacy / un-migrated clips on this track.
  let cursor = 0;
  for (const c of track.clips) {
    if (!Number.isFinite(Number(c.timelineStart))) {
      c.timelineStart = roundMs(cursor);
    }
    cursor = Number(c.timelineStart) + Math.max(0, (Number(c.trimEnd) || 0) - (Number(c.trimStart) || 0));
  }
  return track.clips.slice().sort((a, b) => {
    const ta = Number(a.timelineStart) || 0;
    const tb = Number(b.timelineStart) || 0;
    return ta - tb;
  }).map((clip, index) => {
    const duration = roundMs(Math.max(0, clip.trimEnd - clip.trimStart));
    const start = roundMs(Number(clip.timelineStart) || 0);
    const end = roundMs(start + duration);
    return { clip, index, duration, start, end };
  });
}

// ── Audio track (A) helpers ────────────────────────────────────────────
// A-track clips have an explicit timelineStart (decoupled from sequencing)
// and don't push their neighbors around. They're rendered into a dedicated
// audio lane below the video lane.
function clipPlayableDuration(clip) {
  return roundMs(Math.max(0, (Number(clip.trimEnd) || 0) - (Number(clip.trimStart) || 0)));
}

function getAudioTrackSegments() {
  // Flatten clips from every audio track — callers use this for total length
  // calculations and visual rendering.
  const out = [];
  for (const t of getAudioTracks()) {
    t.clips.forEach((clip, idx) => {
      const duration = clipPlayableDuration(clip);
      const start = roundMs(Number(clip.timelineStart) || 0);
      const end = roundMs(start + duration);
      out.push({ clip, track: t, index: idx, duration, start, end });
    });
  }
  return out;
}

function getAudioTrackEnd() {
  const segs = getAudioTrackSegments();
  if (segs.length === 0) return 0;
  return roundMs(Math.max(...segs.map((s) => s.end)));
}

// Overall timeline length is max(V-track concat duration, A-track last end).
function getTimelineDuration() {
  return roundMs(Math.max(getSequenceDuration(), getAudioTrackEnd()));
}

function getAudioClipById(id) {
  return state.audioClips.find((c) => c.id === id) || null;
}

function selectedAudioClip() {
  return state.selectedAudioClipId ? getAudioClipById(state.selectedAudioClipId) : null;
}

function selectedLibraryClip() {
  return state.library.find((item) => item.id === state.selectedLibraryId) || null;
}

function selectedSequenceClip() {
  if (!state.selectedSequenceId) return null;
  // Search every V track so clicking / selecting a clip on V2/V3 actually
  // returns it — the legacy `state.sequence` alias only covers V1.
  const owner = findClipOwner(state.selectedSequenceId);
  return owner && owner.track.kind === "video" ? owner.clip : null;
}

function getLibraryClipById(id) {
  return state.library.find((item) => item.id === id) || null;
}

function getSequenceSegmentByClipId(id) {
  // Segments must come from the clip's own V track so gap/edge math stays
  // correct for V2/V3 clips, not just V1.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return null;
  return getVideoTrackSegments(owner.track).find((segment) => segment.clip.id === id) || null;
}

function findTimelineSegment(time) {
  const total = getSequenceDuration();
  const target = clampNumber(time, 0, total);
  const segments = getSequenceSegments();
  if (segments.length === 0) return null;
  // Cursor inside a clip → return that clip.
  const inside = segments.find((s) => target >= s.start && target < s.end);
  if (inside) return inside;
  // Cursor exactly at the timeline end → last clip.
  if (target >= total) return segments[segments.length - 1];
  // Cursor in a gap → return the most recent clip that ended before this time
  // so the preview holds the last frame the user saw instead of jumping.
  let best = null;
  for (const s of segments) {
    if (s.end <= target && (best === null || s.end > best.end)) best = s;
  }
  return best || segments[0];
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
    videoCodec: els.videoCodec ? els.videoCodec.value : "h264",
    audioBitrate: els.audioBitrate ? els.audioBitrate.value : "192k",
    aspectPreset: els.aspectPreset.value,
  };
}

function getAudioExportSettings() {
  return {
    audioFormat: els.audioFormat ? els.audioFormat.value : "m4a",
    audioBitrate: els.audioBitrate ? els.audioBitrate.value : "192k",
    sampleRate: els.audioSampleRate ? Number(els.audioSampleRate.value) : 48000,
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
    // Detached/muted audio is exported as silence for that segment.
    hasAudio: clip.hasAudio && !clip.audioMuted,
    hasVideo: clip.hasVideo,
  };
}

// Build the export-ready V clip list. V clips with free positioning (drag)
// can leave gaps on the timeline — we insert synthetic black-filler entries so
// the rendered video matches the visible timeline length. Real V clips keep
// their order by `timelineStart`.
function serializeVideoTrackForExport() {
  // Skip clips from hidden V tracks. Today only V1 contributes to the export
  // pipeline (V2+ free-positioned clips aren't yet composited as overlays).
  const v1 = getVideoTracks()[0];
  if (v1?.hidden) return [];
  const segments = getSequenceSegments();
  const out = [];
  let cursor = 0;
  for (const s of segments) {
    const gap = s.start - cursor;
    if (gap > 0.005) {
      out.push({
        path: null,
        name: "(gap)",
        isBlackFiller: true,
        trimStart: 0,
        trimEnd: roundMs(gap),
        sourceDuration: roundMs(gap),
        hasAudio: false,
        hasVideo: true,
      });
    }
    out.push(sequenceClipToExportClip(s.clip));
    cursor = s.end;
  }
  return out;
}

function audioClipToExportClip(aClip) {
  return {
    path: aClip.path,
    name: aClip.name,
    trimStart: aClip.trimStart,
    trimEnd: aClip.trimEnd,
    sourceDuration: aClip.sourceDuration,
    timelineStart: aClip.timelineStart,
    hasAudio: true,
  };
}

function serializeAudioTrack() {
  // Flatten clips from every audio track. Each clip already carries its own
  // timelineStart so the exporter can mix them regardless of which track they
  // came from. Tracks flagged `muted` are skipped so the UI mute matches the
  // exported audio mix.
  return getAudioTracks()
    .filter((t) => !t.muted)
    .flatMap((t) => t.clips.map(audioClipToExportClip));
}

function setStatus(label, text, percent = null) {
  els.progressLabel.textContent = label;
  els.statusText.textContent = text;
  if (percent !== null) els.progressBar.style.width = `${percent}%`;
}

function describeProxyStatus(mediaClip) {
  const en = state.uiLanguage === "en";
  if (!mediaClip)                             return en ? "Preview proxy idle"    : "预览代理 空闲";
  if (mediaClip.previewPath)                  return en ? "Preview proxy ready"   : "预览代理 就绪";
  if (mediaClip.previewStatus === "preparing") return en ? "Preparing preview proxy" : "预览代理生成中";
  if (mediaClip.previewStatus === "failed")    return en ? "Preview proxy failed"  : "预览代理失败";
  return en ? "Source preview" : "源文件预览";
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
  const en = state.uiLanguage === "en";
  els.libraryCount.textContent = en
    ? `${state.library.length} clip${state.library.length === 1 ? "" : "s"}`
    : `${state.library.length} 个素材`;
  if (state.library.length === 0) {
    els.libraryList.className = "library-list empty-state";
    els.libraryList.textContent = en
      ? "Import a few source videos to begin building the sequence."
      : "导入一些视频开始搭建序列。";
    return;
  }

  els.libraryList.className = "library-list";
  els.libraryList.innerHTML = "";

  state.library.forEach((clip) => {
    const proxyBadge = clip.previewPath
      ? `<span class="badge cool">${en ? "Proxy ready" : "代理就绪"}</span>`
      : clip.previewStatus === "preparing"
        ? `<span class="badge">${en ? "Proxy building" : "代理生成中"}</span>`
        : "";

    const card = document.createElement("div");
    card.className = `library-item${clip.id === state.selectedLibraryId ? " selected" : ""}`;
    card.dataset.clipId = clip.id;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    const sizeLabel = clip.width && clip.height ? `${clip.width}x${clip.height}` : (en ? "Unknown size" : "未知尺寸");
    const audioLabel = clip.hasAudio ? (en ? "Audio" : "有声") : (en ? "Silent" : "无声");
    const addLabel = en ? "+ Add to Timeline" : "+ 加入时间线";
    const delLabel = en ? "✕ Delete" : "✕ 删除";
    card.innerHTML = `
      <div class="item-title">
        <strong>${escapeHtml(clip.name)}</strong>
        <span class="badge warm">${formatDuration(clip.duration)}</span>
      </div>
      <div class="item-meta">
        <span class="badge">${sizeLabel}</span>
        <span class="badge">${audioLabel}</span>
        <span class="badge cool">${escapeHtml(clip.sizeLabel || (en ? "File" : "文件"))}</span>
        ${proxyBadge}
      </div>
      <div class="library-item-actions">
        <button type="button" class="button lib-add-btn" data-id="${escapeHtml(clip.id)}">${addLabel}</button>
        <button type="button" class="button button-danger lib-del-btn" data-id="${escapeHtml(clip.id)}">${delLabel}</button>
      </div>
    `;
    els.libraryList.appendChild(card);
  });
}

function handleLibraryClick(e) {
  const addBtn = e.target.closest(".lib-add-btn");
  if (addBtn) {
    addSelectedLibraryClipToSequence(addBtn.dataset.id);
    return;
  }
  const delBtn = e.target.closest(".lib-del-btn");
  if (delBtn) {
    removeLibraryClip(delBtn.dataset.id);
    return;
  }
  const card = e.target.closest(".library-item");
  if (!card) return;
  const clip = getLibraryClipById(card.dataset.clipId);
  if (!clip) return;
  state.selectedLibraryId = clip.id;
  previewLibraryClip(clip);
  render();
}

function handleLibraryDblClick(e) {
  if (e.target.closest(".lib-add-btn, .lib-del-btn")) return;
  const card = e.target.closest(".library-item");
  if (!card) return;
  addSelectedLibraryClipToSequence(card.dataset.clipId);
}

function handleLibraryKeydown(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".library-item");
  if (!card || e.target !== card) return;
  e.preventDefault();
  const clip = getLibraryClipById(card.dataset.clipId);
  if (!clip) return;
  state.selectedLibraryId = clip.id;
  previewLibraryClip(clip);
  render();
}

// ─── Visual timeline (剪映-style) ───────────────────────────────────────────

// Palette for clip blocks – cycles through these colours.
const CLIP_COLORS = [
  { bg: "#2563eb", fg: "#fff", audio: "#1d4ed8" },
  { bg: "#7c3aed", fg: "#fff", audio: "#5b21b6" },
  { bg: "#0891b2", fg: "#fff", audio: "#0e7490" },
  { bg: "#059669", fg: "#fff", audio: "#047857" },
  { bg: "#d97706", fg: "#fff", audio: "#b45309" },
  { bg: "#dc2626", fg: "#fff", audio: "#b91c1c" },
];

// User-pickable color labels (right-click → 设置颜色). When a clip has
// `colorLabel` set to one of these keys, the clip block uses this color
// instead of the rotating palette so users can color-code scenes / takes.
const COLOR_LABELS = {
  red:    { bg: "#dc2626", fg: "#fff", audio: "#b91c1c", zh: "红 / Red" },
  orange: { bg: "#ea580c", fg: "#fff", audio: "#9a3412", zh: "橙 / Orange" },
  yellow: { bg: "#ca8a04", fg: "#fff", audio: "#854d0e", zh: "黄 / Yellow" },
  green:  { bg: "#059669", fg: "#fff", audio: "#047857", zh: "绿 / Green" },
  blue:   { bg: "#2563eb", fg: "#fff", audio: "#1d4ed8", zh: "蓝 / Blue" },
  purple: { bg: "#7c3aed", fg: "#fff", audio: "#5b21b6", zh: "紫 / Purple" },
  gray:   { bg: "#4b5563", fg: "#fff", audio: "#374151", zh: "灰 / Gray" },
};

// Minimum visual width per clip block so labels are always readable.
const MIN_CLIP_PX = 64;
// Height constants (px).
const RULER_H   = 24;
const VIDEO_H   = 60;
const AUDIO_H   = 28;
const TRACK_PAD = 6;
const TRACK_HEADER_W = 96; // width of the per-track control gutter on the left

// Per-track layout helper — walks the track list and returns the absolute Y
// position + height for each lane, so multi-track rendering doesn't need
// hardcoded video/audio offsets.
function buildTrackLayout() {
  const lanes = [];
  let y = RULER_H + TRACK_PAD;
  for (const track of state.tracks) {
    // Per-track override (set by the drag handle); fall back to the kind-based
    // default. Clamped so the user can't make a lane unusably small or huge.
    const defaultH = track.kind === "video" ? VIDEO_H : AUDIO_H;
    const minH = track.kind === "video" ? 36 : 18;
    const maxH = track.kind === "video" ? 240 : 120;
    const userH = Number(track.heightOverride);
    const h = Number.isFinite(userH) && userH > 0
      ? Math.max(minH, Math.min(maxH, userH))
      : defaultH;
    lanes.push({ track, y, h, minH, maxH, defaultH });
    y += h + 2; // 2px gap between lanes
  }
  return { lanes, totalHeight: y + TRACK_PAD };
}

// Drag state for scrubbing on the visual timeline.
const _tlDrag = { active: false };

// Drag state for resizing a track lane via its bottom-edge handle.
const _laneResize = {
  active: false,
  trackId: null,
  startY: 0,
  startH: 0,
  minH: 18,
  maxH: 240,
  rafId: 0,
  changed: false,
  historyPushed: false,
};

window.addEventListener("mousemove", (e) => {
  if (!_laneResize.active) return;
  if (_laneResize.rafId) return;
  _laneResize.rafId = requestAnimationFrame(() => {
    _laneResize.rafId = 0;
    if (!_laneResize.active) return;
    const t = getTrackById(_laneResize.trackId);
    if (!t) return;
    const dy = e.clientY - _laneResize.startY;
    const next = Math.max(_laneResize.minH, Math.min(_laneResize.maxH, _laneResize.startH + dy));
    if (Number(t.heightOverride) === next) return;
    if (!_laneResize.historyPushed) {
      pushHistorySnapshot();
      _laneResize.historyPushed = true;
    }
    t.heightOverride = next;
    _laneResize.changed = true;
    render();
  });
});

window.addEventListener("mouseup", () => {
  if (!_laneResize.active) return;
  _laneResize.active = false;
  if (_laneResize.rafId) { cancelAnimationFrame(_laneResize.rafId); _laneResize.rafId = 0; }
  document.body.style.cursor = "";
  _laneResize.changed = false;
  _laneResize.historyPushed = false;
});

// Cached per-render timeline geometry — used by _movePlayheadOnly to update
// the playhead position without rebuilding the SVG every scrub event.
const _lastTlGeometry = { scale: 1, runtime: 0, svg: null, rulerH: 24 };

function _movePlayheadOnly() {
  const { scale, runtime, svg, rulerH } = _lastTlGeometry;
  if (!svg || !svg.isConnected) return false;
  const x = Math.round(clampNumber(state.timelineCursor, 0, runtime) * scale);
  const line = svg.querySelector("#tl-playhead-line");
  const shadow = svg.querySelector("#tl-playhead-shadow");
  const head = svg.querySelector("#tl-playhead-head");
  if (!line || !shadow || !head) return false;
  line.setAttribute("x1", x); line.setAttribute("x2", x);
  shadow.setAttribute("x1", x + 1); shadow.setAttribute("x2", x + 1);
  const hy = rulerH - 1;
  head.setAttribute("points", `${x},${hy - 1} ${x + 6},${hy + 7} ${x},${hy + 14} ${x - 6},${hy + 7}`);
  return true;
}

// Drag-time fast path: shift a clip block via SVG transform instead of a full
// renderSequence rebuild. Returns false if the SVG isn't mounted yet or the
// clip's group can't be found (caller should fall back to render()).
function _moveDraggedClipOnly(clipId, deltaSec) {
  const { scale, svg } = _lastTlGeometry;
  if (!svg || !svg.isConnected) return false;
  const g = svg.querySelector(`g[data-clip-id="${CSS.escape(String(clipId))}"]`);
  if (!g) return false;
  const deltaPx = Math.round(deltaSec * scale);
  g.setAttribute("transform", `translate(${deltaPx}, 0)`);
  _updateSnapGuide();
  return true;
}

function _updateSnapGuide() {
  const { scale, runtime, svg } = _lastTlGeometry;
  if (!svg || !svg.isConnected) return;
  const guide = svg.querySelector("#tl-snap-guide");
  if (!guide) return;
  if (_snapGuide.timeSec === null) {
    guide.setAttribute("display", "none");
    return;
  }
  const gx = Math.round(clampNumber(_snapGuide.timeSec, 0, runtime) * scale);
  guide.setAttribute("x1", gx); guide.setAttribute("x2", gx);
  guide.removeAttribute("display");
}

// Trim-handle drag state — left/right edges of a clip block. Resizes by
// adjusting trimStart/trimEnd as the user drags, exactly like CapCut/剪映.
const _trimDrag = {
  active: false,
  clip: null,
  edge: null, // "left" | "right"
  startX: 0,
  scale: 1,
  initialTrimStart: 0,
  initialTrimEnd: 0,
  rafId: 0,
  changed: false,
  historyPushed: false,
};

// A-track drag state — pressing and holding (with Alt) on an audio clip in
// any audio lane lets the user slide it horizontally (adjusts `timelineStart`)
// AND vertically (moves clip between audio tracks A1/A2/A3...).
const _aDrag = {
  active: false,
  clip: null,
  fromTrackId: null,
  startX: 0,
  scale: 1,
  initialStart: 0,
  // See _vDrag.referenceStart for the same idea — what the rendered SVG
  // already reflects, so the transform delta math stays correct across
  // mid-drag full renders (cross-track moves).
  referenceStart: 0,
  rafId: 0,
  changed: false,
  historyPushed: false,
  movedPx: 0,
};

// Snap configuration — when the dragged clip's leading edge is within
// `pixelTolerance` of another clip edge or the playhead, the drag pos snaps
// to that target. A render-time hint sets `_snapGuide.timeSec` so we can
// draw a vertical guide line; null hides it.
const _snapGuide = { timeSec: null };
const SNAP_PIXEL_TOLERANCE = 8;

// Returns a snapped start time (in seconds). `selfId` is excluded from the
// candidate list so a clip doesn't snap to its own edges.
function _snapDragX(proposedStart, selfId, scale) {
  // Honor the S-key toggle — when snapping is off, pass the proposed time
  // through unchanged and make sure no stale snap guide lingers.
  if (!state.snapEnabled) {
    _snapGuide.timeSec = null;
    return proposedStart;
  }
  if (!Number.isFinite(scale) || scale <= 0) return proposedStart;
  const tolPx = SNAP_PIXEL_TOLERANCE;
  const tolSec = tolPx / scale;
  // Build the candidate target times: every clip's start + end across all
  // V and A tracks (skipping self), plus the playhead.
  const targets = [];
  for (const t of state.tracks) {
    for (const c of t.clips) {
      if (c.id === selfId) continue;
      const start = Number(c.timelineStart) || 0;
      const dur = Math.max(0, (Number(c.trimEnd) || 0) - (Number(c.trimStart) || 0));
      targets.push(start);
      targets.push(start + dur);
    }
  }
  targets.push(state.timelineCursor);
  // Snap whichever end of the dragged clip is closer to a target. We only
  // know the proposed `start` here; for "trailing-edge" snaps the caller
  // would pre-shift by duration. Cheap MVP: snap the start only.
  let best = null;
  let bestDelta = Infinity;
  for (const t of targets) {
    const d = Math.abs(t - proposedStart);
    if (d < bestDelta) { bestDelta = d; best = t; }
  }
  if (best !== null && bestDelta <= tolSec) {
    _snapGuide.timeSec = best;
    return best;
  }
  _snapGuide.timeSec = null;
  return proposedStart;
}

// Subtitle-cue drag state — mirrors _aDrag. Plain mousedown on a subtitle
// clip block lets the user slide it horizontally to change its start time.
// We don't currently support vertical hopping between subtitle tracks (the
// project only has one S1 track in practice).
const _sDrag = {
  active: false,
  cue: null,
  trackId: null,
  startX: 0,
  scale: 1,
  initialStart: 0,
  referenceStart: 0,
  rafId: 0,
  changed: false,
  historyPushed: false,
  movedPx: 0,
};

window.addEventListener("mousemove", (e) => {
  if (!_sDrag.active) return;
  if (_sDrag.rafId) return;
  _sDrag.rafId = requestAnimationFrame(() => {
    _sDrag.rafId = 0;
    if (!_sDrag.active) return;
    const cue = _sDrag.cue;
    if (!cue) return;
    const deltaPx = e.clientX - _sDrag.startX;
    _sDrag.movedPx = Math.max(_sDrag.movedPx, Math.abs(deltaPx));
    const deltaSec = deltaPx / Math.max(1, _sDrag.scale);
    let next = _sDrag.initialStart + deltaSec;
    if (next < 0) next = 0;
    const snapped = _snapDragX(next, cue.id, _sDrag.scale);
    const rounded = roundMs(snapped);
    if (rounded !== cue.timelineStart) {
      if (!_sDrag.historyPushed) {
        pushHistorySnapshot();
        _sDrag.historyPushed = true;
      }
      cue.timelineStart = rounded;
      _sDrag.changed = true;
      if (!_moveDraggedClipOnly(cue.id, cue.timelineStart - _sDrag.referenceStart)) {
        render();
        _sDrag.referenceStart = Number(cue.timelineStart) || 0;
      }
    }
  });
});

window.addEventListener("mouseup", () => {
  if (!_sDrag.active) return;
  _sDrag.active = false;
  _sDrag.cue = null;
  if (_sDrag.rafId) { cancelAnimationFrame(_sDrag.rafId); _sDrag.rafId = 0; }
  document.body.style.cursor = "";
  _sDrag.changed = false;
  _sDrag.historyPushed = false;
  _sDrag.movedPx = 0;
  _snapGuide.timeSec = null;
  render();
});

function _startSubtitleDrag(cue, trackId, clientX, scale) {
  const track = getTrackById(trackId);
  if (track?.locked) return;
  _sDrag.active = true;
  _sDrag.cue = cue;
  _sDrag.trackId = trackId;
  _sDrag.startX = clientX;
  _sDrag.scale = scale;
  _sDrag.initialStart = Number(cue.timelineStart) || 0;
  _sDrag.referenceStart = _sDrag.initialStart;
  _sDrag.changed = false;
  _sDrag.historyPushed = false;
  _sDrag.movedPx = 0;
  document.body.style.cursor = "grabbing";
}

// V-track drag state — mirrors _aDrag. Alt+drag on a V clip adjusts its
// `timelineStart` and can also drop it onto another V track.
const _vDrag = {
  active: false,
  clip: null,
  fromTrackId: null,
  startX: 0,
  scale: 1,
  initialStart: 0,
  // `referenceStart` is the timelineStart that the currently-rendered SVG
  // already reflects. The drag fast path uses (current - reference) as the
  // transform delta; after a full render() it's reset to the latest start.
  referenceStart: 0,
  rafId: 0,
  changed: false,
  historyPushed: false,
  movedPx: 0,
};

// Clipboard for clip copy/cut/paste.
let _clipClipboard = null;

window.addEventListener("mousemove", (e) => {
  if (!_trimDrag.active) return;
  if (_trimDrag.rafId) return;
  _trimDrag.rafId = requestAnimationFrame(() => {
    _trimDrag.rafId = 0;
    if (!_trimDrag.active) return;
    const clip = _trimDrag.clip;
    if (!clip) return;
    const deltaSec = (e.clientX - _trimDrag.startX) / Math.max(1, _trimDrag.scale);
    if (_trimDrag.edge === "left") {
      let next = _trimDrag.initialTrimStart + deltaSec;
      next = clampNumberMaybe(next, 0, clip.trimEnd - 0.1);
      const rounded = roundMs(next);
      if (rounded !== clip.trimStart) {
        if (!_trimDrag.historyPushed) {
          pushHistorySnapshot();
          _trimDrag.historyPushed = true;
        }
        clip.trimStart = rounded;
        _trimDrag.changed = true;
        render();
      }
    } else if (_trimDrag.edge === "right") {
      let next = _trimDrag.initialTrimEnd + deltaSec;
      next = clampNumberMaybe(next, clip.trimStart + 0.1, clip.sourceDuration);
      const rounded = roundMs(next);
      if (rounded !== clip.trimEnd) {
        if (!_trimDrag.historyPushed) {
          pushHistorySnapshot();
          _trimDrag.historyPushed = true;
        }
        clip.trimEnd = rounded;
        _trimDrag.changed = true;
        render();
      }
    }
  });
});

window.addEventListener("mouseup", () => {
  if (!_trimDrag.active) return;
  _trimDrag.active = false;
  _trimDrag.clip = null;
  if (_trimDrag.rafId) {
    cancelAnimationFrame(_trimDrag.rafId);
    _trimDrag.rafId = 0;
  }
  document.body.style.cursor = "";
  if (_trimDrag.changed) {
    refreshExportEstimate();
  }
  _trimDrag.changed = false;
  _trimDrag.historyPushed = false;
  // The trim-handle mousedown sets selectedSequenceId synchronously, but
  // render() only ran while the mouse was actually moving. A click with no
  // drag would leave the inspector showing the previous selection — force a
  // render here so simply clicking a handle still updates the panel.
  render();
});

// A-track drag handlers — horizontal moves timelineStart, vertical hops the
// clip between audio tracks. We re-find the lane the cursor is over on every
// rAF and migrate the clip to that track when it changes.
window.addEventListener("mousemove", (e) => {
  if (!_aDrag.active) return;
  if (_aDrag.rafId) return;
  _aDrag.rafId = requestAnimationFrame(() => {
    _aDrag.rafId = 0;
    if (!_aDrag.active) return;
    const clip = _aDrag.clip;
    if (!clip) return;
    const deltaPx = e.clientX - _aDrag.startX;
    _aDrag.movedPx = Math.max(_aDrag.movedPx, Math.abs(deltaPx));
    const deltaSec = deltaPx / Math.max(1, _aDrag.scale);
    let next = _aDrag.initialStart + deltaSec;
    if (next < 0) next = 0;
    const snapped = _snapDragX(next, clip.id, _aDrag.scale);
    const rounded = roundMs(snapped);

    // Horizontal: update timelineStart.
    let mutated = false;
    let trackChanged = false;
    if (rounded !== clip.timelineStart) {
      if (!_aDrag.historyPushed) {
        pushHistorySnapshot();
        _aDrag.historyPushed = true;
      }
      clip.timelineStart = rounded;
      mutated = true;
    }

    // Vertical: hop between audio tracks based on where the cursor is in
    // the SVG. Only operates while the SVG is mounted (`_lastTlGeometry.svg`).
    const svg = _lastTlGeometry.svg;
    if (svg && svg.isConnected) {
      const rect = svg.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      // Find which audio lane (if any) the Y falls into.
      const audioLanes = buildTrackLayout().lanes.filter((L) => L.track.kind === "audio");
      const hover = audioLanes.find((L) => localY >= L.y && localY < L.y + L.h);
      if (hover && hover.track.id !== _aDrag.fromTrackId) {
        // Move the clip object from its current track to the hovered track.
        const fromTrack = getTrackById(_aDrag.fromTrackId);
        if (fromTrack) {
          const idx = fromTrack.clips.findIndex((c) => c.id === clip.id);
          if (idx !== -1) {
            if (!_aDrag.historyPushed) {
              pushHistorySnapshot();
              _aDrag.historyPushed = true;
            }
            fromTrack.clips.splice(idx, 1);
            hover.track.clips.push(clip);
            _aDrag.fromTrackId = hover.track.id;
            mutated = true;
            trackChanged = true;
          }
        }
      }
    }

    if (mutated) {
      _aDrag.changed = true;
      // Same fast path as V drag — only fall back to a full render when the
      // clip actually changed tracks (lane Y shifts).
      if (trackChanged
        || !_moveDraggedClipOnly(clip.id, clip.timelineStart - _aDrag.referenceStart)) {
        render();
        _aDrag.referenceStart = Number(clip.timelineStart) || 0;
      }
    }
  });
});

window.addEventListener("mouseup", () => {
  if (!_aDrag.active) return;
  _aDrag.active = false;
  _aDrag.clip = null;
  if (_aDrag.rafId) {
    cancelAnimationFrame(_aDrag.rafId);
    _aDrag.rafId = 0;
  }
  document.body.style.cursor = "";
  if (_aDrag.changed) {
    refreshExportEstimate();
  }
  _aDrag.changed = false;
  _aDrag.historyPushed = false;
  _aDrag.movedPx = 0;
  _snapGuide.timeSec = null;
  render();
});

function _startTrimDrag(clip, edge, clientX, scale) {
  const owner = findClipOwner(clip.id);
  if (owner?.track.locked) return; // locked tracks reject trim too
  _trimDrag.active = true;
  _trimDrag.clip = clip;
  _trimDrag.edge = edge;
  _trimDrag.startX = clientX;
  _trimDrag.scale = scale;
  _trimDrag.initialTrimStart = clip.trimStart;
  _trimDrag.initialTrimEnd = clip.trimEnd;
  _trimDrag.changed = false;
  _trimDrag.historyPushed = false;
  document.body.style.cursor = "ew-resize";
}

function _startAudioClipDrag(clip, clientX, scale) {
  const owner = findClipOwner(clip.id);
  if (owner?.track.locked) return; // locked A track rejects drag
  _aDrag.active = true;
  _aDrag.clip = clip;
  // Remember which track the clip started on so we can detect cross-track
  // moves on every mousemove.
  _aDrag.fromTrackId = owner?.track.id || null;
  _aDrag.startX = clientX;
  _aDrag.scale = scale;
  _aDrag.initialStart = Number(clip.timelineStart) || 0;
  _aDrag.referenceStart = _aDrag.initialStart;
  _aDrag.changed = false;
  _aDrag.historyPushed = false;
  _aDrag.movedPx = 0;
  document.body.style.cursor = "grabbing";
}

// V clip drag — horizontal moves timelineStart, vertical hops the clip
// between V tracks (V1↔V2↔V3...) by checking which video lane the cursor is
// over and migrating the clip object on crossing.
window.addEventListener("mousemove", (e) => {
  if (!_vDrag.active) return;
  if (_vDrag.rafId) return;
  _vDrag.rafId = requestAnimationFrame(() => {
    _vDrag.rafId = 0;
    if (!_vDrag.active) return;
    const clip = _vDrag.clip;
    if (!clip) return;
    const deltaPx = e.clientX - _vDrag.startX;
    _vDrag.movedPx = Math.max(_vDrag.movedPx, Math.abs(deltaPx));
    const deltaSec = deltaPx / Math.max(1, _vDrag.scale);
    let nextStart = _vDrag.initialStart + deltaSec;
    if (nextStart < 0) nextStart = 0;
    const snapped = _snapDragX(nextStart, clip.id, _vDrag.scale);
    const rounded = roundMs(snapped);
    let mutated = false;
    let trackChanged = false;
    if (rounded !== clip.timelineStart) {
      if (!_vDrag.historyPushed) {
        pushHistorySnapshot();
        _vDrag.historyPushed = true;
      }
      clip.timelineStart = rounded;
      mutated = true;
    }

    // Vertical: detect which V lane the cursor is over, transfer the clip if it
    // crosses into a different track. Locked target tracks block the move.
    const svg = _lastTlGeometry.svg;
    if (svg && svg.isConnected) {
      const rect = svg.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      const videoLanes = buildTrackLayout().lanes.filter((L) => L.track.kind === "video");
      const hover = videoLanes.find((L) => localY >= L.y && localY < L.y + L.h);
      if (hover && hover.track.id !== _vDrag.fromTrackId && !hover.track.locked) {
        const fromTrack = getTrackById(_vDrag.fromTrackId);
        if (fromTrack && !fromTrack.locked) {
          const idx = fromTrack.clips.findIndex((c) => c.id === clip.id);
          if (idx !== -1) {
            if (!_vDrag.historyPushed) {
              pushHistorySnapshot();
              _vDrag.historyPushed = true;
            }
            fromTrack.clips.splice(idx, 1);
            hover.track.clips.push(clip);
            // Keep `state.sequence` alias pointed at the FIRST video track
            // (the legacy V1) since lots of code still reads it directly.
            state.sequence = (state.tracks.find((t) => t.kind === "video") || { clips: [] }).clips;
            _vDrag.fromTrackId = hover.track.id;
            mutated = true;
            trackChanged = true;
          }
        }
      }
    }

    if (mutated) {
      _vDrag.changed = true;
      // Track change → vertical lanes shift, full re-layout is the only
      // correct path. Pure horizontal drag uses the SVG-transform fast path
      // so dragging hundreds of clips stays smooth.
      if (trackChanged
        || !_moveDraggedClipOnly(clip.id, clip.timelineStart - _vDrag.referenceStart)) {
        render();
        _vDrag.referenceStart = Number(clip.timelineStart) || 0;
      }
    }
  });
});

window.addEventListener("mouseup", () => {
  if (!_vDrag.active) return;
  _vDrag.active = false;
  _vDrag.clip = null;
  if (_vDrag.rafId) { cancelAnimationFrame(_vDrag.rafId); _vDrag.rafId = 0; }
  document.body.style.cursor = "";
  if (_vDrag.changed) refreshExportEstimate();
  _vDrag.changed = false;
  _vDrag.historyPushed = false;
  _vDrag.movedPx = 0;
  _snapGuide.timeSec = null;
  render();
});

function _startVideoClipDrag(clip, clientX, scale) {
  _vDrag.active = true;
  _vDrag.clip = clip;
  const owner = findClipOwner(clip.id);
  _vDrag.fromTrackId = owner?.track.id || null;
  _vDrag.startX = clientX;
  _vDrag.scale = scale;
  _vDrag.initialStart = Number(clip.timelineStart) || 0;
  _vDrag.referenceStart = _vDrag.initialStart;
  _vDrag.changed = false;
  _vDrag.historyPushed = false;
  _vDrag.movedPx = 0;
  document.body.style.cursor = "grabbing";
}

// Hover scrub throttle state (for live preview while moving the mouse over the timeline).
// `timeSec` is the current hover position in seconds along the sequence; null
// when the mouse is not over the timeline. The main (committed) playhead lives
// on `state.timelineCursor` — these are intentionally separate, 剪映-style.
const _tlHover = { rafId: 0, pendingX: 0, timeSec: null };

// Right-click context menu on a sequence clip.
let _tlContextMenu = null;
function _hideTlContextMenu() {
  if (_tlContextMenu) {
    _tlContextMenu.remove();
    _tlContextMenu = null;
    document.removeEventListener("mousedown", _onTlContextMenuOutsideMouseDown, true);
    document.removeEventListener("keydown", _onTlContextMenuKey, true);
    window.removeEventListener("blur", _hideTlContextMenu);
    window.removeEventListener("resize", _hideTlContextMenu);
  }
}
function _onTlContextMenuKey(e) {
  if (e.key === "Escape") _hideTlContextMenu();
}
// Close on outside click. Must check that the click is OUTSIDE the menu —
// otherwise a capture-phase handler removes the menu before its click handler
// fires, so every action except keyboard Del appears broken.
function _onTlContextMenuOutsideMouseDown(e) {
  if (_tlContextMenu && !_tlContextMenu.contains(e.target)) {
    _hideTlContextMenu();
  }
}

function _showLaneContextMenu(x, y, track) {
  _hideTlContextMenu();
  const menu = document.createElement("div");
  menu.className = "tl-context-menu";
  const clipboardKind = _clipClipboard?.kind || null;
  const canPasteHere = Boolean(_clipClipboard) && clipboardKind === track.kind && !track.locked;
  const reason = !_clipClipboard
    ? "剪贴板为空 / Clipboard empty"
    : clipboardKind !== track.kind
      ? `剪贴板里是${clipboardKind === "video" ? "视频" : "音频"}片段，跟轨道类型不匹配`
      : track.locked
        ? "轨道已锁定 / Track locked"
        : "";
  menu.innerHTML = `
    <div class="menu-label">${escapeHtml(track.name)} · ${track.kind === "video" ? "视频轨" : "音频轨"}</div>
    <button type="button" data-action="paste-here"${canPasteHere ? "" : " disabled"}>
      <span>粘贴到此轨道 / Paste here</span><span class="menu-shortcut">Ctrl+V</span>
    </button>
    ${reason ? `<div class="menu-hint">${escapeHtml(reason)}</div>` : ""}
  `;
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 6;
  const maxY = window.innerHeight - rect.height - 6;
  menu.style.left = Math.max(6, Math.min(x, maxX)) + "px";
  menu.style.top = Math.max(6, Math.min(y, maxY)) + "px";
  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn || btn.disabled) return;
    ev.stopPropagation();
    _hideTlContextMenu();
    if (btn.dataset.action === "paste-here") {
      // Force the paste target to this track for the duration of the operation.
      const prev = state.selectedTrackId;
      state.selectedTrackId = track.id;
      pasteSequenceClipFromClipboard();
      state.selectedTrackId = prev;
    }
  });
  _tlContextMenu = menu;
  document.addEventListener("mousedown", _onTlContextMenuOutsideMouseDown, true);
  document.addEventListener("keydown", _onTlContextMenuKey, true);
  window.addEventListener("blur", _hideTlContextMenu);
  window.addEventListener("resize", _hideTlContextMenu);
}

function _showAudioClipContextMenu(x, y, clip) {
  _hideTlContextMenu();
  const menu = document.createElement("div");
  menu.className = "tl-context-menu";
  const canPaste = Boolean(_clipClipboard);
  menu.innerHTML = `
    <div class="menu-label">${escapeHtml(clip.name)} · A 轨</div>
    <button type="button" data-action="copy"><span>复制 / Copy</span><span class="menu-shortcut">Ctrl+C</span></button>
    <button type="button" data-action="cut"><span>剪切 / Cut</span><span class="menu-shortcut">Ctrl+X</span></button>
    <button type="button" data-action="paste"${canPaste ? "" : " disabled"}><span>粘贴 / Paste</span><span class="menu-shortcut">Ctrl+V</span></button>
    <div class="menu-divider"></div>
    <button type="button" data-action="reveal">打开文件所在位置 / Open file location</button>
    <div class="menu-divider"></div>
    <button type="button" data-action="delete" class="danger"><span>删除音轨片段 / Delete audio clip</span><span class="menu-shortcut">Del</span></button>
  `;
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth - rect.width - 6;
  const maxY = window.innerHeight - rect.height - 6;
  menu.style.left = Math.max(6, Math.min(x, maxX)) + "px";
  menu.style.top = Math.max(6, Math.min(y, maxY)) + "px";
  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.disabled) return;
    ev.stopPropagation();
    const action = btn.dataset.action;
    _hideTlContextMenu();
    switch (action) {
      case "copy":
        copyAudioClipToClipboard(clip.id);
        break;
      case "cut":
        cutAudioClip(clip.id);
        break;
      case "paste":
        pasteSequenceClipFromClipboard();
        break;
      case "reveal":
        window.editorAPI.revealInFolder(clip.path).catch(() => null);
        break;
      case "delete":
        removeAudioClipById(clip.id);
        break;
    }
  });
  _tlContextMenu = menu;
  document.addEventListener("mousedown", _onTlContextMenuOutsideMouseDown, true);
  document.addEventListener("keydown", _onTlContextMenuKey, true);
  window.addEventListener("blur", _hideTlContextMenu);
  window.addEventListener("resize", _hideTlContextMenu);
}
function _showSubtitleContextMenu(x, y, cue, track) {
  _hideTlContextMenu();
  const menu = document.createElement("div");
  menu.className = "tl-context-menu";
  menu.innerHTML = `
    <div class="menu-label">字幕 / Subtitle cue</div>
    <button type="button" data-action="edit">编辑文本 / Edit text</button>
    <button type="button" data-action="split">在播放头切分 / Split at playhead</button>
    <button type="button" data-action="delete" class="danger">删除 / Delete</button>
  `;
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 6))}px`;
  menu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 6))}px`;
  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    ev.stopPropagation();
    const action = btn.dataset.action;
    _hideTlContextMenu();
    switch (action) {
      case "edit": {
        const next = window.prompt("Edit cue text:", cue.text || "");
        if (next == null) break;
        pushHistorySnapshot();
        cue.text = next;
        render();
        break;
      }
      case "split":
        splitSubtitleAtPlayhead(cue.id);
        break;
      case "delete":
        removeSubtitleById(cue.id);
        break;
    }
  });
  _tlContextMenu = menu;
  document.addEventListener("mousedown", _onTlContextMenuOutsideMouseDown, true);
  document.addEventListener("keydown", _onTlContextMenuKey, true);
  window.addEventListener("blur", _hideTlContextMenu);
  window.addEventListener("resize", _hideTlContextMenu);
}

function removeSubtitleById(id) {
  if (state.exporting) return;
  for (const t of getSubtitleTracks()) {
    const idx = t.clips.findIndex((c) => c.id === id);
    if (idx !== -1) {
      pushHistorySnapshot();
      t.clips.splice(idx, 1);
      if (state.selectedSubtitleId === id) state.selectedSubtitleId = null;
      render();
      return;
    }
  }
}

function splitSubtitleAtPlayhead(id) {
  if (state.exporting) return;
  for (const t of getSubtitleTracks()) {
    const cue = t.clips.find((c) => c.id === id);
    if (!cue) continue;
    const cursor = state.timelineCursor;
    const startPos = Number(cue.timelineStart) || 0;
    const endPos = startPos + (Number(cue.duration) || 0);
    if (cursor <= startPos + 0.05 || cursor >= endPos - 0.05) {
      setStatus("Split Skipped", "把播放头放进字幕段中间再切分。", null);
      return;
    }
    pushHistorySnapshot();
    const half2 = {
      id: createId("sub"),
      text: cue.text,
      timelineStart: roundMs(cursor),
      duration: roundMs(endPos - cursor),
    };
    cue.duration = roundMs(cursor - startPos);
    t.clips.push(half2);
    render();
    return;
  }
}

function _showTlContextMenu(x, y, clip) {
  _hideTlContextMenu();
  const menu = document.createElement("div");
  menu.className = "tl-context-menu";
  const audioRow = clip.hasAudio
    ? `<button type="button" data-action="toggle-audio">${clip.audioMuted ? "恢复音轨 / Restore audio" : "分离音轨 / Detach audio"}</button>`
    : "";
  const audioExportRow = clip.hasAudio
    ? `<button type="button" data-action="export-clip-audio">导出此片段音频 / Export this clip's audio</button>`
    : "";
  const canPaste = Boolean(_clipClipboard);
  const colorSwatches = Object.entries(COLOR_LABELS).map(([key, def]) => {
    const active = clip.colorLabel === key ? " active" : "";
    return `<button type="button" class="color-swatch${active}" data-action="set-color" data-color="${key}" title="${escapeHtml(def.zh)}" style="background:${def.bg}"></button>`;
  }).join("");
  menu.innerHTML = `
    <div class="menu-label">${escapeHtml(clip.name)}</div>
    <button type="button" data-action="copy"><span>复制 / Copy</span><span class="menu-shortcut">Ctrl+C</span></button>
    <button type="button" data-action="cut"><span>剪切 / Cut</span><span class="menu-shortcut">Ctrl+X</span></button>
    <button type="button" data-action="paste"${canPaste ? "" : " disabled"}><span>粘贴 / Paste</span><span class="menu-shortcut">Ctrl+V</span></button>
    <button type="button" data-action="duplicate"><span>克隆 / Duplicate</span><span class="menu-shortcut">Ctrl+D</span></button>
    <div class="menu-divider"></div>
    <div class="menu-label">颜色标记 / Color label</div>
    <div class="color-swatch-row">
      ${colorSwatches}
      <button type="button" class="color-swatch clear" data-action="set-color" data-color="" title="清除 / Clear">✕</button>
    </div>
    <div class="menu-divider"></div>
    ${audioRow}
    <button type="button" data-action="export-clip">导出此片段视频 / Export this clip</button>
    ${audioExportRow}
    <button type="button" data-action="reveal">打开文件所在位置 / Open file location</button>
    <div class="menu-divider"></div>
    <button type="button" data-action="delete" class="danger"><span>删除 / Delete clip</span><span class="menu-shortcut">Del</span></button>
    <button type="button" data-action="ripple-delete" class="danger"><span>涟漪删除 / Ripple Delete</span><span class="menu-shortcut">Shift+Del</span></button>
  `;
  // Position off-screen first to measure, then clamp into viewport.
  menu.style.left = "0px";
  menu.style.top  = "0px";
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  const maxX = window.innerWidth  - rect.width  - 6;
  const maxY = window.innerHeight - rect.height - 6;
  menu.style.left = Math.max(6, Math.min(x, maxX)) + "px";
  menu.style.top  = Math.max(6, Math.min(y, maxY)) + "px";

  menu.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.disabled) return;
    ev.stopPropagation();
    const action = btn.dataset.action;
    _hideTlContextMenu();
    switch (action) {
      case "copy":
        copySequenceClipToClipboard(clip.id);
        break;
      case "cut":
        cutSequenceClip(clip.id);
        break;
      case "paste":
        pasteSequenceClipFromClipboard();
        break;
      case "duplicate":
        state.selectedSequenceId = clip.id;
        duplicateSelectedClip();
        break;
      case "set-color": {
        const colorKey = btn.dataset.color || null;
        const owner = findClipOwner(clip.id);
        if (owner) {
          pushHistorySnapshot();
          owner.clip.colorLabel = colorKey || null;
          render();
        }
        break;
      }
      case "toggle-audio":
        toggleSequenceClipAudioMute(clip.id);
        break;
      case "export-clip":
        exportSingleSequenceClip(clip.id);
        break;
      case "export-clip-audio":
        exportSingleSequenceClipAudio(clip.id);
        break;
      case "reveal":
        revealClipFileInFolder(clip.id);
        break;
      case "delete":
        removeSequenceClipById(clip.id);
        break;
      case "ripple-delete":
        state.selectedSequenceId = clip.id;
        rippleDeleteSelectedSequenceClip();
        break;
    }
  });

  _tlContextMenu = menu;
  // Close on outside click / Esc / window changes.
  document.addEventListener("mousedown", _onTlContextMenuOutsideMouseDown, true);
  document.addEventListener("keydown", _onTlContextMenuKey, true);
  window.addEventListener("blur", _hideTlContextMenu);
  window.addEventListener("resize", _hideTlContextMenu);
}

function _getTimelineContainer() {
  // We reuse the existing sequenceList element as the visual timeline wrapper.
  return els.sequenceList;
}

/**
 * Compute a px-per-second scale so all clips fit in the container,
 * but never go below MIN_CLIP_PX per clip.
 */
// Per-frame width at maximum zoom-in. With this set to 8, a 30-fps timeline
// renders each frame as an 8-px-wide block (= 240 px/sec), tight enough to
// snap to individual frames but still visible at typical screen DPI.
const PER_FRAME_MAX_PX = 8;
// At minimum zoom, the visible window spans this many seconds of timeline.
// 3600 s = exactly one hour fits in `containerWidth` pixels, matching the
// user-facing "minimum zoom = per-hour granularity" requirement.
const MIN_VIEW_SECONDS = 3600;

// Compute the absolute scale (px/sec) bounds the user can dial to via Ctrl+Wheel.
// Both ends are content-aware (剪映-style):
//   max  = PER_FRAME_MAX_PX × fps                       ⇒ each frame ≥ 8 px
//   min  = (containerW − 2) / max(1h, totalDuration)    ⇒ whichever is LONGER
//          between "one hour" and the actual timeline fits inside the view —
//          so users with 30-min content can pad out to a full hour view, and
//          users with 3-hour content can still see the whole thing at min zoom
//          without a horizontal scrollbar.
function _computeTimelineScaleBounds(containerWidth, totalDuration) {
  const fps = Math.max(1, Number(els.fps?.value) || 30);
  const maxScale = PER_FRAME_MAX_PX * fps;
  const minSpan = Math.max(MIN_VIEW_SECONDS, Number(totalDuration) || 0);
  const minScale = Math.max(0.05, (containerWidth - 2) / minSpan);
  return [minScale, maxScale];
}

// Compute the [minZoom, maxZoom] MULTIPLIER bounds (relative to ergonomic) so
// the wheel handler can clamp without recomputing ergonomic itself.
function _computeTimelineZoomBounds(containerWidth, ergonomicFit, totalDuration) {
  const [minScale, maxScale] = _computeTimelineScaleBounds(containerWidth, totalDuration);
  if (!Number.isFinite(ergonomicFit) || ergonomicFit <= 0) return [0.02, 60];
  // Cap min at 1 (the "default" ergonomic view) so we never lock the user
  // ABOVE the natural fit — if the floor scale is wider than ergonomic, just
  // let them zoom all the way down to fit-to-width.
  const minZoom = Math.min(1, minScale / ergonomicFit);
  return [minZoom, maxScale / ergonomicFit];
}

// Programmatic zoom by a factor (used by +/- keyboard shortcuts). Pins the
// zoom around the visible center so the user's gaze doesn't lose its place.
function _bumpTimelineZoom(factor) {
  const scrollDiv = els.sequenceList?.querySelector(".tl-scroll");
  if (!scrollDiv) return;
  const containerW = scrollDiv.clientWidth;
  const dur = _lastTlGeometry.runtime || 1;
  const ergonomicFit = _ergonomicFitScale(dur, containerW);
  const [minZ, maxZ] = _computeTimelineZoomBounds(containerW, ergonomicFit, dur);
  const prev = Math.max(minZ, Math.min(maxZ, Number(state.timelineZoom) || 1));
  const next = Math.max(minZ, Math.min(maxZ, prev * factor));
  if (next === prev) return;
  // Pin around the visible center so the same area stays on screen after zoom.
  const oldScale = _lastTlGeometry.scale || 1;
  const centerOffset = containerW / 2;
  const timeUnderCenter = (scrollDiv.scrollLeft + centerOffset) / oldScale;
  state.timelineZoom = next;
  state.timelineScrollLeft = Math.max(0, timeUnderCenter * (oldScale * (next / prev)) - centerOffset);
  render();
}

function _ergonomicFitScale(totalDuration, containerWidth) {
  if (totalDuration <= 0) return (containerWidth - 2) || 40;
  const natural = (containerWidth - 2) / totalDuration;
  const segments = getSequenceSegments();
  let minDur = Infinity;
  segments.forEach((s) => { if (s.duration > 0) minDur = Math.min(minDur, s.duration); });
  return (!isFinite(minDur) || minDur <= 0) ? natural : Math.max(natural, MIN_CLIP_PX / minDur);
}

function _computeScale(totalDuration, containerWidth) {
  if (totalDuration <= 0 || containerWidth <= 0) return 40;
  const ergonomicFit = _ergonomicFitScale(totalDuration, containerWidth);
  const [minZoom, maxZoom] = _computeTimelineZoomBounds(containerWidth, ergonomicFit, totalDuration);
  // User zoom = multiplier relative to ergonomic. Always clamp to the
  // dynamically-computed bounds so the user can squeeze a full hour into one
  // screen (minZoom) or zoom in until each frame is visible (maxZoom),
  // regardless of how long the actual content is.
  const zoom = Math.max(minZoom, Math.min(maxZoom, Number(state.timelineZoom) || 1));
  return ergonomicFit * zoom;
}

function renderSequence() {
  // V-track concat duration (used for clip layout) vs full timeline (max of
  // V end + A end) which the ruler must cover so A-track clips that overhang
  // the last video aren't clipped off-screen.
  const runtime = getTimelineDuration();
  const en = state.uiLanguage === "en";
  els.sequenceCount.textContent = en
    ? `${state.sequence.length} clip${state.sequence.length === 1 ? "" : "s"}`
    : `${state.sequence.length} 个片段`;
  els.sequenceRuntime.textContent = en
    ? `${formatTimecode(runtime)} total`
    : `共 ${formatTimecode(runtime)}`;
  els.sequenceDurationChip.textContent = en
    ? `Timeline ${formatTimecode(runtime)}`
    : `时间线 ${formatTimecode(runtime)}`;
  if (els.timelineZoomPill) {
    // Use the live container width to clamp display so the user always sees
    // the actual effective zoom (in case the stored value is beyond bounds).
    const containerW = (els.sequenceList?.querySelector(".tl-scroll")?.clientWidth)
      || els.sequenceList?.clientWidth || 1200;
    const ergonomicFit = _ergonomicFitScale(runtime || 1, containerW);
    const [minZ, maxZ] = _computeTimelineZoomBounds(containerW, ergonomicFit, runtime || 1);
    const zoom = Math.max(minZ, Math.min(maxZ, Number(state.timelineZoom) || 1));
    els.timelineZoomPill.textContent = zoom >= 1
      ? `${Math.round(zoom * 100)}%`
      : `${(zoom * 100).toFixed(zoom < 0.1 ? 2 : 1)}%`;
    els.timelineZoomPill.classList.toggle("accent", Math.abs(zoom - 1) > 0.005);
    els.timelineZoomPill.title =
      `Ctrl+Wheel / +/- 缩放 · 点击重置 (Ctrl+0)\n范围: ${Math.round(minZ * 100)}% – ${Math.round(maxZ * 100)}%`;
  }

  const container = _getTimelineContainer();

  // ── Empty state ──
  const hasAnyClip = state.tracks.some((t) => t.clips.length > 0);
  const onlyDefaultTracks = state.tracks.length <= 2;
  if (!hasAnyClip && onlyDefaultTracks) {
    container.className = "tl-container tl-empty";
    container.innerHTML = `
      <div class="tl-empty-msg">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="7" width="20" height="10" rx="2"/>
          <path d="M7 7V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2"/>
          <line x1="12" y1="11" x2="12" y2="13"/><line x1="12" y1="15" x2="12.01" y2="15"/>
        </svg>
        <span>从媒体库添加片段到时间线</span>
      </div>`;
    return;
  }

  container.className = "tl-container";

  // Measure available width (subtract scrollbar allowance).
  const availW = Math.max(300, container.clientWidth - 4);
  const scale  = _computeScale(runtime, availW);
  const totalW = Math.max(availW, Math.ceil(runtime * scale) + 2);

  // Compute per-track Y positions so the V/A clip loops below don't have to
  // hardcode layout — adding a track just adds a new entry.
  const layout = buildTrackLayout();
  const totalH = layout.totalHeight;

  // ── Build SVG ──
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width",  totalW);
  svg.setAttribute("height", totalH);
  svg.style.display = "block";
  svg.style.cursor  = "pointer";
  svg.style.userSelect = "none";

  // Background
  const bg = document.createElementNS(svgNS, "rect");
  bg.setAttribute("width",  totalW);
  bg.setAttribute("height", totalH);
  bg.setAttribute("fill",   "#111318");
  svg.appendChild(bg);

  // ── Ruler ──
  const rulerBg = document.createElementNS(svgNS, "rect");
  rulerBg.setAttribute("width",  totalW);
  rulerBg.setAttribute("height", RULER_H);
  rulerBg.setAttribute("fill",   "#1a1d24");
  svg.appendChild(rulerBg);

  // Ruler ticks – aim for ~80px between labels
  const tickInterval = _niceInterval(80 / scale);
  for (let t = 0; t <= runtime + tickInterval; t += tickInterval) {
    const x = Math.round(t * scale);
    if (x > totalW) break;
    const major = document.createElementNS(svgNS, "line");
    major.setAttribute("x1", x); major.setAttribute("x2", x);
    major.setAttribute("y1", RULER_H - 8); major.setAttribute("y2", RULER_H);
    major.setAttribute("stroke", "#4b5563"); major.setAttribute("stroke-width", "1");
    svg.appendChild(major);

    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", x + 3);
    label.setAttribute("y", RULER_H - 10);
    label.setAttribute("fill", "#6b7280");
    label.setAttribute("font-size", "9");
    label.setAttribute("font-family", "monospace");
    label.textContent = formatTimecode(t);
    svg.appendChild(label);
  }

  // Ruler bottom border
  const rulerLine = document.createElementNS(svgNS, "line");
  rulerLine.setAttribute("x1", 0); rulerLine.setAttribute("x2", totalW);
  rulerLine.setAttribute("y1", RULER_H); rulerLine.setAttribute("y2", RULER_H);
  rulerLine.setAttribute("stroke", "#374151"); rulerLine.setAttribute("stroke-width", "1");
  svg.appendChild(rulerLine);

  // ── Lane backgrounds (one rect per track) ──
  layout.lanes.forEach((L) => {
    const lb = document.createElementNS(svgNS, "rect");
    lb.setAttribute("x", 0);
    lb.setAttribute("y", L.y);
    lb.setAttribute("width", totalW);
    lb.setAttribute("height", L.h);
    lb.setAttribute("fill", L.track.kind === "video" ? "#161920" : "#0f1115");
    if (L.track.hidden || L.track.muted) lb.setAttribute("opacity", "0.5");
    svg.appendChild(lb);
    // Top border for each track lane to separate them visually.
    const sep = document.createElementNS(svgNS, "line");
    sep.setAttribute("x1", 0); sep.setAttribute("x2", totalW);
    sep.setAttribute("y1", L.y); sep.setAttribute("y2", L.y);
    sep.setAttribute("stroke", "#1f2937"); sep.setAttribute("stroke-width", "1");
    svg.appendChild(sep);
    // Bottom-edge drag handle — invisible 4px strip used to resize this lane.
    // Drag down/up changes track.heightOverride; double-click resets to default.
    const handle = document.createElementNS(svgNS, "rect");
    handle.setAttribute("x", 0);
    handle.setAttribute("y", L.y + L.h - 2);
    handle.setAttribute("width", totalW);
    handle.setAttribute("height", 4);
    handle.setAttribute("fill", "transparent");
    handle.style.cursor = "ns-resize";
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      _laneResize.active = true;
      _laneResize.trackId = L.track.id;
      _laneResize.startY = e.clientY;
      _laneResize.startH = L.h;
      _laneResize.minH = L.minH;
      _laneResize.maxH = L.maxH;
      document.body.style.cursor = "ns-resize";
    });
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = getTrackById(L.track.id);
      if (!t) return;
      pushHistorySnapshot();
      delete t.heightOverride;
      render();
    });
    svg.appendChild(handle);
  });

  // ── Clip blocks — one pass per V track so V2/V3 clips (dragged off V1)
  // also render. Each track contributes its own sorted segments.
  const videoLanes = layout.lanes.filter((L) => L.track.kind === "video");
  videoLanes.forEach((vLane) => {
    const laneY = vLane.y;
    const trackSegments = getVideoTrackSegments(vLane.track);
    trackSegments.forEach((segment, idx) => {
    const clip     = segment.clip;
    const isSelected = clip.id === state.selectedSequenceId;
    const isMultiSelected = !isSelected && (state.multiSelectIds || []).includes(clip.id);
    // User-set color label (right-click → set color) wins over the rotating
    // palette. `clip.colorLabel` is one of the keys in COLOR_LABELS or null.
    const labelColor = clip.colorLabel ? COLOR_LABELS[clip.colorLabel] : null;
    const color    = labelColor || CLIP_COLORS[idx % CLIP_COLORS.length];
    const x        = Math.round(segment.start * scale);
    const w        = Math.max(4, Math.round(segment.duration * scale));
    // Lane height — honors the per-track resize handle. Replaces the
    // hardcoded VIDEO_H so a taller V lane actually shows taller clip blocks.
    const laneH    = vLane.h;

    // Gap dot-line between clips on this track (every gap ≥ 1px)
    if (idx > 0) {
      const prevEnd = Math.round(trackSegments[idx - 1].end * scale);
      if (x > prevEnd) {
        const gap = document.createElementNS(svgNS, "rect");
        gap.setAttribute("x", prevEnd); gap.setAttribute("y", laneY);
        gap.setAttribute("width", x - prevEnd); gap.setAttribute("height", laneH);
        gap.setAttribute("fill", "#1f2937");
        svg.appendChild(gap);
      }
    }

    // ── Video block ──
    const clipG = document.createElementNS(svgNS, "g");
    clipG.style.cursor = "pointer";
    // data-clip-id lets the drag handlers find this group via querySelector
    // and update its transform directly — orders of magnitude cheaper than
    // rebuilding the SVG on every mousemove frame.
    clipG.dataset.clipId = clip.id;

    const clipRect = document.createElementNS(svgNS, "rect");
    clipRect.setAttribute("x",      x + 1);
    clipRect.setAttribute("y",      laneY + 1);
    clipRect.setAttribute("width",  Math.max(2, w - 2));
    clipRect.setAttribute("height", laneH - 2);
    clipRect.setAttribute("rx",     "4");
    clipRect.setAttribute("fill",   isSelected ? _lighten(color.bg) : color.bg);
    clipRect.setAttribute("stroke",
      isSelected ? "#fff" : (isMultiSelected ? "#5eb6ff" : "transparent"));
    clipRect.setAttribute("stroke-width", isSelected || isMultiSelected ? "2" : "0");
    clipRect.setAttribute("stroke-dasharray", isMultiSelected ? "5,3" : "");
    clipG.appendChild(clipRect);

    // Thumbnail strip — overlay the cached 12-frame PNG (built async on import)
    // clipped to the clip rect. The visual point isn't 1:1 frame accuracy but
    // giving the user a visual anchor for where they are in the source.
    const mediaForClip = getLibraryClipById(clip.mediaId);
    if (mediaForClip?.thumbnailStripPath && w > 24 && laneH > 28) {
      const thumbH = Math.max(20, laneH - 32);
      const thumbY = laneY + 18;
      const clipPathId = `tlclip-${clip.id}`;
      const defs = document.createElementNS(svgNS, "defs");
      const cp = document.createElementNS(svgNS, "clipPath");
      cp.setAttribute("id", clipPathId);
      const cpRect = document.createElementNS(svgNS, "rect");
      cpRect.setAttribute("x", x + 2);
      cpRect.setAttribute("y", thumbY);
      cpRect.setAttribute("width", Math.max(2, w - 4));
      cpRect.setAttribute("height", thumbH);
      cp.appendChild(cpRect);
      defs.appendChild(cp);
      clipG.appendChild(defs);
      const img = document.createElementNS(svgNS, "image");
      img.setAttributeNS("http://www.w3.org/1999/xlink", "href",
        window.editorAPI.toFileUrl(mediaForClip.thumbnailStripPath));
      img.setAttribute("href", window.editorAPI.toFileUrl(mediaForClip.thumbnailStripPath));
      img.setAttribute("x", x + 2);
      img.setAttribute("y", thumbY);
      img.setAttribute("width", Math.max(2, w - 4));
      img.setAttribute("height", thumbH);
      img.setAttribute("preserveAspectRatio", "xMidYMid slice");
      img.setAttribute("clip-path", `url(#${clipPathId})`);
      img.setAttribute("opacity", "0.55");
      img.setAttribute("pointer-events", "none");
      clipG.appendChild(img);
    }

    // Left trim handle — interactive: drag to change trimStart.
    const lHandle = document.createElementNS(svgNS, "rect");
    lHandle.setAttribute("x",      x + 1);
    lHandle.setAttribute("y",      laneY + 1);
    lHandle.setAttribute("width",  "6");
    lHandle.setAttribute("height", laneH - 2);
    lHandle.setAttribute("rx",     "3");
    lHandle.setAttribute("fill",   "rgba(255,255,255,0.35)");
    lHandle.style.cursor = "ew-resize";
    lHandle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId = clip.mediaId;
      _startTrimDrag(clip, "left", e.clientX, scale);
    });
    clipG.appendChild(lHandle);

    // Right trim handle — interactive: drag to change trimEnd.
    const rHandle = document.createElementNS(svgNS, "rect");
    rHandle.setAttribute("x",      x + w - 7);
    rHandle.setAttribute("y",      laneY + 1);
    rHandle.setAttribute("width",  "6");
    rHandle.setAttribute("height", laneH - 2);
    rHandle.setAttribute("rx",     "3");
    rHandle.setAttribute("fill",   "rgba(255,255,255,0.35)");
    rHandle.style.cursor = "ew-resize";
    rHandle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId = clip.mediaId;
      _startTrimDrag(clip, "right", e.clientX, scale);
    });
    clipG.appendChild(rHandle);

    // Clip label
    if (w > 32) {
      const clipLabel = document.createElementNS(svgNS, "text");
      clipLabel.setAttribute("x",           x + 8);
      clipLabel.setAttribute("y",           laneY + 16);
      clipLabel.setAttribute("fill",        color.fg);
      clipLabel.setAttribute("font-size",   "11");
      clipLabel.setAttribute("font-weight", "600");
      clipLabel.setAttribute("font-family", "system-ui,sans-serif");
      // Clip to block width via foreignObject is complex in SVG; use textLength trick
      const maxChars = Math.floor((w - 16) / 6.5);
      const labelText = clip.name.length > maxChars && maxChars > 3
        ? clip.name.slice(0, maxChars - 1) + "…"
        : clip.name;
      clipLabel.textContent = labelText;
      clipG.appendChild(clipLabel);

      // Duration sub-label
      const durLabel = document.createElementNS(svgNS, "text");
      durLabel.setAttribute("x",           x + 8);
      durLabel.setAttribute("y",           laneY + 30);
      durLabel.setAttribute("fill",        "rgba(255,255,255,0.65)");
      durLabel.setAttribute("font-size",   "9");
      durLabel.setAttribute("font-family", "monospace");
      durLabel.textContent = formatTimecode(segment.duration);
      clipG.appendChild(durLabel);

      // Trim indicators
      if (clip.trimStart > 0.01) {
        const trimIn = document.createElementNS(svgNS, "text");
        trimIn.setAttribute("x",           x + 8);
        trimIn.setAttribute("y",           laneY + laneH - 8);
        trimIn.setAttribute("fill",        "rgba(255,255,255,0.45)");
        trimIn.setAttribute("font-size",   "8");
        trimIn.setAttribute("font-family", "monospace");
        trimIn.textContent = `in ${formatPrecise(clip.trimStart)}`;
        clipG.appendChild(trimIn);
      }
    }

    // Number badge
    const badgeR = document.createElementNS(svgNS, "rect");
    badgeR.setAttribute("x",      x + w - 22);
    badgeR.setAttribute("y",      laneY + laneH - 18);
    badgeR.setAttribute("width",  "18");
    badgeR.setAttribute("height", "14");
    badgeR.setAttribute("rx",     "3");
    badgeR.setAttribute("fill",   "rgba(0,0,0,0.35)");
    clipG.appendChild(badgeR);

    const badgeT = document.createElementNS(svgNS, "text");
    badgeT.setAttribute("x",           x + w - 13);
    badgeT.setAttribute("y",           laneY + laneH - 7);
    badgeT.setAttribute("fill",        "#fff");
    badgeT.setAttribute("font-size",   "9");
    badgeT.setAttribute("font-weight", "700");
    badgeT.setAttribute("text-anchor", "middle");
    badgeT.setAttribute("font-family", "system-ui,sans-serif");
    badgeT.textContent = String(segment.index + 1);
    clipG.appendChild(badgeT);

    // Right-click → context menu (delete this clip).
    clipG.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId  = clip.mediaId;
      render();
      _showTlContextMenu(e.clientX, e.clientY, clip);
    });

    // Highlight on hover
    clipRect.addEventListener("mouseenter", () => {
      if (clip.id !== state.selectedSequenceId) clipRect.setAttribute("fill", _lighten(color.bg, 0.15));
    });
    clipRect.addEventListener("mouseleave", () => {
      if (clip.id !== state.selectedSequenceId) clipRect.setAttribute("fill", color.bg);
    });

    // Plain mousedown on a V clip selects + starts a drag (剪映-style). To
    // scrub the playhead through the clip area, use the ruler row instead.
    // Locked tracks fall through to scrub (drag suppressed but selection ok).
    clipRect.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const owner = findClipOwner(clip.id);
      // Shift+Click = toggle multi-select. Holds the primary selection in
      // place; adds/removes the clicked clip in multiSelectIds.
      if (e.shiftKey && state.selectedSequenceId && state.selectedSequenceId !== clip.id) {
        e.stopPropagation();
        const set = new Set(state.multiSelectIds || []);
        if (set.has(clip.id)) set.delete(clip.id);
        else set.add(clip.id);
        state.multiSelectIds = [...set];
        render();
        return;
      }
      // Plain click clears multi-select and picks this clip as the new primary.
      state.multiSelectIds = [];
      state.selectedSequenceId = clip.id;
      state.selectedLibraryId  = clip.mediaId;
      if (owner?.track.locked) return; // let scrub happen
      e.stopPropagation();
      _startVideoClipDrag(clip, e.clientX, scale);
    });
    clipRect.style.cursor = "grab";

    svg.appendChild(clipG);

    // Audio indicator on the V clip itself (tiny corner icon). The full audio
    // bar moved off the V lane — multi-track layouts can't reserve space below
    // each V clip without overlapping V2/V3. Detached audio lives on an A track.
    if (clip.hasAudio && w > 40) {
      const icon = document.createElementNS(svgNS, "text");
      icon.setAttribute("x", x + w - 28);
      icon.setAttribute("y", laneY + 14);
      icon.setAttribute("font-size", "11");
      icon.setAttribute("fill", clip.audioMuted ? "rgba(255, 196, 120, 0.9)" : "rgba(255,255,255,0.7)");
      icon.setAttribute("font-family", "system-ui,sans-serif");
      icon.setAttribute("pointer-events", "none");
      icon.textContent = clip.audioMuted ? "🔇" : "🔊";
      clipG.appendChild(icon);
    }
    }); // end trackSegments.forEach
  }); // end videoLanes.forEach

  // ── A-track clips (independent audio) — one loop per audio track ──
  // Each A track has its own clips. Within a track, each clip uses its own
  // timelineStart for positioning, independent of any V-track sequencing.
  // Bars are styled in amber to read as "independent audio".
  layout.lanes
    .filter((L) => L.track.kind === "audio")
    .forEach((aLane) => {
      const trackAudioY = aLane.y;
      aLane.track.clips.forEach((clip, idx) => {
        const duration = clipPlayableDuration(clip);
        const start = Number(clip.timelineStart) || 0;
        const isSelected = clip.id === state.selectedAudioClipId;
        const ax = Math.round(start * scale);
        const aw = Math.max(4, Math.round(duration * scale));
        // Wrap rect + stripes + label in a single <g> so the drag handler can
        // move everything with a single transform attribute change instead of
        // rebuilding the SVG every frame.
        const aClipG = document.createElementNS(svgNS, "g");
        aClipG.dataset.clipId = clip.id;
        const aRect = document.createElementNS(svgNS, "rect");
        aRect.setAttribute("x", ax + 1);
        aRect.setAttribute("y", trackAudioY + 2);
        aRect.setAttribute("width", Math.max(2, aw - 2));
        aRect.setAttribute("height", aLane.h - 4);
        aRect.setAttribute("rx", "3");
        aRect.setAttribute("fill", "#a86b32");
        aRect.setAttribute("opacity", isSelected ? "1" : "0.85");
        aRect.setAttribute("stroke", isSelected ? "#ffd9a8" : "rgba(255,255,255,0.08)");
        aRect.setAttribute("stroke-width", isSelected ? "1.5" : "1");
        aRect.style.cursor = "grab";
        aRect.title = "Drag to move · cross-lane drag to hop tracks";
        aRect.dataset.audioClipId = clip.id;
        aRect.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          state.selectedAudioClipId = clip.id;
          state.selectedSequenceId = null;
          if (aLane.track.locked) return; // locked: select only, let scrub fall through
          e.stopPropagation();
          _startAudioClipDrag(clip, e.clientX, scale);
        });
        aRect.addEventListener("click", (e) => {
          if (_aDrag.movedPx > 3) {
            e.stopPropagation();
          }
        });
        aRect.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          state.selectedAudioClipId = clip.id;
          state.selectedSequenceId = null;
          render();
          _showAudioClipContextMenu(e.clientX, e.clientY, clip);
        });
        aClipG.appendChild(aRect);

        // Waveform image — replaces the diagonal stripes when a cached PNG
        // is available. The PNG covers the full source duration; we clip to
        // the trim window so trimmed-down clips show only the relevant slice.
        const aMedia = getLibraryClipById(clip.mediaId);
        if (aw > 24 && aMedia?.waveformPath && clip.sourceDuration > 0) {
          // Source-domain mapping: trimStart..trimEnd in source seconds maps
          // to ax..ax+aw in screen pixels. The PNG itself spans 0..sourceDur.
          const srcDur = clip.sourceDuration;
          const trimStart = Number(clip.trimStart) || 0;
          const trimEnd = Number(clip.trimEnd) || srcDur;
          const imgFullWidth = aw * (srcDur / Math.max(0.001, (trimEnd - trimStart)));
          const imgX = ax - (trimStart / srcDur) * imgFullWidth;
          const clipPathId = `aclip-${clip.id}`;
          const defs = document.createElementNS(svgNS, "defs");
          const cp = document.createElementNS(svgNS, "clipPath");
          cp.setAttribute("id", clipPathId);
          const cpRect = document.createElementNS(svgNS, "rect");
          cpRect.setAttribute("x", ax + 1);
          cpRect.setAttribute("y", trackAudioY + 3);
          cpRect.setAttribute("width", Math.max(2, aw - 2));
          cpRect.setAttribute("height", aLane.h - 6);
          cp.appendChild(cpRect);
          defs.appendChild(cp);
          aClipG.appendChild(defs);
          const img = document.createElementNS(svgNS, "image");
          img.setAttributeNS("http://www.w3.org/1999/xlink", "href",
            window.editorAPI.toFileUrl(aMedia.waveformPath));
          img.setAttribute("href", window.editorAPI.toFileUrl(aMedia.waveformPath));
          img.setAttribute("x", imgX);
          img.setAttribute("y", trackAudioY + 3);
          img.setAttribute("width", imgFullWidth);
          img.setAttribute("height", aLane.h - 6);
          img.setAttribute("preserveAspectRatio", "none");
          img.setAttribute("clip-path", `url(#${clipPathId})`);
          img.setAttribute("opacity", "0.85");
          img.setAttribute("pointer-events", "none");
          aClipG.appendChild(img);
        } else if (aw > 24) {
          // Fallback diagonal stripes if no waveform is cached yet.
          const top = trackAudioY + 3;
          const bot = trackAudioY + aLane.h - 3;
          const height = bot - top;
          const stripeStep = 8;
          for (let sx = ax - height; sx < ax + aw; sx += stripeStep) {
            const x1 = Math.max(ax + 1, sx);
            const y1 = sx >= ax + 1 ? top : top + (ax + 1 - sx);
            const x2 = Math.min(ax + aw - 1, sx + height);
            const y2 = sx + height <= ax + aw - 1 ? bot : bot - (sx + height - (ax + aw - 1));
            if (x2 <= x1 || y2 <= y1) continue;
            const line = document.createElementNS(svgNS, "line");
            line.setAttribute("x1", x1); line.setAttribute("y1", y1);
            line.setAttribute("x2", x2); line.setAttribute("y2", y2);
            line.setAttribute("stroke", "rgba(255, 220, 170, 0.4)");
            line.setAttribute("stroke-width", "1.2");
            line.setAttribute("pointer-events", "none");
            aClipG.appendChild(line);
          }
        }
        if (aw > 70) {
          const label = document.createElementNS(svgNS, "text");
          label.setAttribute("x", ax + 8);
          label.setAttribute("y", trackAudioY + aLane.h / 2 + 4);
          label.setAttribute("fill", "#fff4dc");
          label.setAttribute("font-size", "10");
          label.setAttribute("font-weight", "600");
          label.setAttribute("font-family", "system-ui,sans-serif");
          label.setAttribute("pointer-events", "none");
          label.textContent = `🎵 ${clip.name}`;
          aClipG.appendChild(label);
        }
        svg.appendChild(aClipG);
      });
    });

  // ── Subtitle lane (cue blocks) ──
  // Subtitle cues are simpler than V/A clips — they have just (start, dur,
  // text). They use a teal palette so they're visually distinct from amber
  // audio bars and the rotating V palette. Click selects → inspector for
  // editing; right-click → delete.
  layout.lanes
    .filter((L) => L.track.kind === "subtitle")
    .forEach((sLane) => {
      const trackY = sLane.y;
      sLane.track.clips.forEach((cue) => {
        const dur = Math.max(0, Number(cue.duration) || 0);
        const start = Number(cue.timelineStart) || 0;
        const sx = Math.round(start * scale);
        const sw = Math.max(4, Math.round(dur * scale));
        const isSelected = cue.id === state.selectedSubtitleId;
        const sClipG = document.createElementNS(svgNS, "g");
        sClipG.dataset.clipId = cue.id;
        // Only the rect is interactive. Restricting hit-testing here makes
        // mouseover lookup cheaper when many cues are stacked in the lane,
        // so the dashed hover indicator stays smooth even over dense
        // subtitle regions.
        sClipG.setAttribute("pointer-events", "visiblePainted");
        const sRect = document.createElementNS(svgNS, "rect");
        sRect.setAttribute("x", sx + 1);
        sRect.setAttribute("y", trackY + 2);
        sRect.setAttribute("width", Math.max(2, sw - 2));
        sRect.setAttribute("height", sLane.h - 4);
        sRect.setAttribute("rx", "3");
        sRect.setAttribute("fill", "#0e7490");
        sRect.setAttribute("opacity", isSelected ? "1" : "0.85");
        sRect.setAttribute("stroke", isSelected ? "#a5f3fc" : "rgba(255,255,255,0.08)");
        sRect.setAttribute("stroke-width", isSelected ? "1.5" : "1");
        sRect.style.cursor = "grab";
        sRect.title = (cue.text || "").slice(0, 200);
        sRect.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          state.selectedSubtitleId = cue.id;
          state.selectedAudioClipId = null;
          state.selectedSequenceId = null;
          e.stopPropagation();
          if (!sLane.track.locked) {
            _startSubtitleDrag(cue, sLane.track.id, e.clientX, scale);
          }
          render();
        });
        sRect.addEventListener("click", (e) => {
          // Suppress click if the user actually dragged the cue.
          if (_sDrag.movedPx > 3) e.stopPropagation();
        });
        sRect.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          state.selectedSubtitleId = cue.id;
          render();
          _showSubtitleContextMenu(e.clientX, e.clientY, cue, sLane.track);
        });
        sClipG.appendChild(sRect);
        if (sw > 18) {
          const label = document.createElementNS(svgNS, "text");
          label.setAttribute("x", sx + 6);
          label.setAttribute("y", trackY + sLane.h / 2 + 4);
          label.setAttribute("fill", "#e0fbff");
          label.setAttribute("font-size", "10");
          label.setAttribute("font-family", "system-ui,sans-serif");
          label.setAttribute("pointer-events", "none");
          const maxChars = Math.floor((sw - 14) / 6.5);
          const txt = (cue.text || "").replace(/\s+/g, " ").trim();
          label.textContent = txt.length > maxChars && maxChars > 3 ? txt.slice(0, maxChars - 1) + "…" : txt;
          sClipG.appendChild(label);
        }
        svg.appendChild(sClipG);
      });
    });

  // ── Playhead ──
  // IDs let us reposition during scrub via direct DOM mutation, avoiding a
  // full SVG rebuild every cursor update (otherwise long timelines + many
  // clips make scrubbing crawl).
  const playheadX = Math.round(clampNumber(state.timelineCursor, 0, runtime) * scale);

  // Playhead shadow
  const phShadow = document.createElementNS(svgNS, "line");
  phShadow.setAttribute("id", "tl-playhead-shadow");
  phShadow.setAttribute("x1", playheadX + 1); phShadow.setAttribute("x2", playheadX + 1);
  phShadow.setAttribute("y1", RULER_H); phShadow.setAttribute("y2", totalH);
  phShadow.setAttribute("stroke", "rgba(0,0,0,0.4)"); phShadow.setAttribute("stroke-width", "3");
  svg.appendChild(phShadow);

  const phLine = document.createElementNS(svgNS, "line");
  phLine.setAttribute("id", "tl-playhead-line");
  phLine.setAttribute("x1", playheadX); phLine.setAttribute("x2", playheadX);
  phLine.setAttribute("y1", RULER_H); phLine.setAttribute("y2", totalH);
  phLine.setAttribute("stroke", "#f97316"); phLine.setAttribute("stroke-width", "2");
  svg.appendChild(phLine);

  // Playhead diamond head
  const hx = playheadX;
  const hy = RULER_H - 1;
  const diamond = document.createElementNS(svgNS, "polygon");
  diamond.setAttribute("id", "tl-playhead-head");
  diamond.setAttribute("points", `${hx},${hy - 1} ${hx + 6},${hy + 7} ${hx},${hy + 14} ${hx - 6},${hy + 7}`);
  diamond.setAttribute("fill", "#f97316");
  svg.appendChild(diamond);

  // Cache so scrub-only updates can move the playhead without re-rendering.
  _lastTlGeometry.scale = scale;
  _lastTlGeometry.runtime = runtime;
  _lastTlGeometry.svg = svg;
  _lastTlGeometry.rulerH = RULER_H;

  // Snap guide — always rendered so drag-time updates can show/hide and
  // reposition it via direct DOM mutation. Without this, the drag fast path
  // can't surface the snap line because it doesn't rebuild the SVG.
  const gLine = document.createElementNS(svgNS, "line");
  gLine.setAttribute("id", "tl-snap-guide");
  gLine.setAttribute("y1", RULER_H); gLine.setAttribute("y2", totalH);
  gLine.setAttribute("stroke", "#5eb6ff");
  gLine.setAttribute("stroke-width", "1.5");
  gLine.setAttribute("stroke-dasharray", "4,3");
  gLine.setAttribute("pointer-events", "none");
  if (_snapGuide.timeSec === null) {
    gLine.setAttribute("display", "none");
  } else {
    const gx = Math.round(clampNumber(_snapGuide.timeSec, 0, runtime) * scale);
    gLine.setAttribute("x1", gx); gLine.setAttribute("x2", gx);
  }
  svg.appendChild(gLine);

  // ── Hover playhead (剪映-style, separate from the committed playhead) ──
  // Always render the elements so we can update them via direct DOM writes
  // during hover-scrub (no full re-render needed per frame). Visibility is
  // controlled with the `display` attribute.
  const showHover = _tlHover.timeSec !== null && !_tlDrag.active && els.previewPlayer.paused;
  const hovX = showHover ? Math.round(clampNumber(_tlHover.timeSec, 0, runtime) * scale) : 0;
  const hovLine = document.createElementNS(svgNS, "line");
  hovLine.setAttribute("id", "tl-hover-line");
  hovLine.setAttribute("x1", hovX); hovLine.setAttribute("x2", hovX);
  hovLine.setAttribute("y1", 0);    hovLine.setAttribute("y2", totalH);
  hovLine.setAttribute("stroke", "rgba(255,255,255,0.78)");
  hovLine.setAttribute("stroke-width", "1");
  hovLine.setAttribute("stroke-dasharray", "3,3");
  hovLine.setAttribute("pointer-events", "none");
  if (!showHover) hovLine.setAttribute("display", "none");
  svg.appendChild(hovLine);

  const hovHead = document.createElementNS(svgNS, "polygon");
  hovHead.setAttribute("id", "tl-hover-head");
  hovHead.setAttribute("points", `${hovX - 5},0 ${hovX + 5},0 ${hovX},7`);
  hovHead.setAttribute("fill", "rgba(255,255,255,0.85)");
  hovHead.setAttribute("pointer-events", "none");
  if (!showHover) hovHead.setAttribute("display", "none");
  svg.appendChild(hovHead);

  // ── Click / drag / hover to scrub ──
  function _scrubAt(clientX, { hover = false } = {}) {
    const rect = svg.getBoundingClientRect();
    const px   = clientX - rect.left;
    const t    = clampNumber(px / scale, 0, runtime);
    // Hover preview should never start playback; drag/click preserves the current play state.
    const wasPlaying = !hover && state.previewMode === "timeline" && !els.previewPlayer.paused;
    previewTimelineAt(t, { autoplay: wasPlaying, forceReload: false });
  }

  // Suppress the default browser context menu over the timeline so our own menu
  // (attached to each clip) is what the user sees on right-click.
  // Right-click on the empty lane area (not on a clip) → "Paste here" menu so
  // the user can drop a copied clip onto a specific track without first
  // clicking the track header. Clicks on clips have their own contextmenu
  // handlers that stopPropagation, so this only fires for empty areas.
  svg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const lane = layout.lanes.find((L) => localY >= L.y && localY < L.y + L.h);
    if (!lane) return;
    _showLaneContextMenu(e.clientX, e.clientY, lane.track);
  });

  svg.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return; // left-click only initiates scrub/drag
    _hideTlContextMenu();
    _tlDrag.active = true;
    // Drag/click moves the committed playhead, so clear the hover indicator.
    _tlHover.timeSec = null;
    // Plain click on empty timeline area clears any clip selection (剪映 behavior).
    // Clip mousedown handlers stopPropagation for unlocked tracks, so this fires
    // only for blank lane area or locked-track clicks (where deselect-then-scrub
    // is what the user wants anyway).
    if (!e.shiftKey) {
      let needsRender = false;
      if ((state.multiSelectIds || []).length > 0) {
        state.multiSelectIds = [];
        needsRender = true;
      }
      if (state.selectedSequenceId || state.selectedAudioClipId || state.selectedSubtitleId) {
        state.selectedSequenceId = null;
        state.selectedAudioClipId = null;
        state.selectedSubtitleId = null;
        needsRender = true;
      }
      if (needsRender) render();
    }
    _scrubAt(e.clientX);
  });

  function _hoverTimeFromX(clientX) {
    const rect = svg.getBoundingClientRect();
    return clampNumber((clientX - rect.left) / scale, 0, runtime);
  }

  function _setHoverIndicator(visible, timeSec) {
    const line = svg.querySelector("#tl-hover-line");
    const head = svg.querySelector("#tl-hover-head");
    if (!line || !head) return;
    if (!visible) {
      line.setAttribute("display", "none");
      head.setAttribute("display", "none");
      return;
    }
    const x = Math.round(clampNumber(timeSec, 0, runtime) * scale);
    line.setAttribute("x1", x); line.setAttribute("x2", x);
    line.removeAttribute("display");
    head.setAttribute("points", `${x - 5},0 ${x + 5},0 ${x},7`);
    head.removeAttribute("display");
  }

  svg.addEventListener("mousemove", (e) => {
    if (_tlDrag.active) {
      _scrubAt(e.clientX);
      return;
    }
    // Skip hover preview during playback so it doesn't fight the playhead.
    if (!els.previewPlayer.paused) return;
    const t = _hoverTimeFromX(e.clientX);
    _tlHover.timeSec = t;
    _tlHover.pendingX = e.clientX;
    if (_tlHover.rafId) return;
    _tlHover.rafId = requestAnimationFrame(() => {
      _tlHover.rafId = 0;
      if (_tlDrag.active || !els.previewPlayer.paused || _tlHover.timeSec === null) return;
      // Cap hover scrub at ~30fps. Above that, decode for high-res proxies
      // starts to backlog and the monitor visibly stutters. The hover line
      // itself is cheap and can move every frame — only the seek is gated.
      const now = performance.now();
      const lastHoverSeek = _tlHover.lastSeek || 0;
      // 剪映-style: program monitor previews the hover frame, but the
      // committed playhead (state.timelineCursor) stays put. Hover indicator
      // is moved by direct DOM write to avoid rebuilding the whole SVG.
      _setHoverIndicator(true, _tlHover.timeSec);
      if (now - lastHoverSeek >= 33) {
        _tlHover.lastSeek = now;
        previewHoverFrame(_tlHover.timeSec);
      }
    });
  });

  svg.addEventListener("mouseleave", () => {
    _tlHover.timeSec = null;
    if (_tlHover.rafId) {
      cancelAnimationFrame(_tlHover.rafId);
      _tlHover.rafId = 0;
    }
    _setHoverIndicator(false);
    if (_tlDrag.active) return;
    _revertMonitorToCommitted();
  });

  // ── Mount: a left "track headers" column + a right "svg scroll" column.
  // Headers stay sticky so horizontal scroll doesn't hide track labels.
  container.innerHTML = "";
  container.className = "tl-container";

  const headersDiv = document.createElement("div");
  headersDiv.className = "tl-headers";
  // Spacer matches the SVG's "ruler + top pad" so the first row aligns with
  // lane Y0 (= RULER_H + TRACK_PAD).
  const rulerSpacer = document.createElement("div");
  rulerSpacer.className = "tl-header-ruler";
  rulerSpacer.style.height = `${RULER_H + TRACK_PAD}px`;
  headersDiv.appendChild(rulerSpacer);

  layout.lanes.forEach((L, laneIdx) => {
    const row = document.createElement("div");
    row.className = "tl-track-header";
    if (state.selectedTrackId === L.track.id) row.classList.add("selected");
    // Each row uses lane height; the 2px gap between SVG lanes is added via
    // margin-top on rows after the first to keep alignment exact.
    row.style.height = `${L.h}px`;
    if (laneIdx > 0) row.style.marginTop = "2px";
    row.dataset.trackId = L.track.id;
    const isVideo = L.track.kind === "video";
    const isSubtitle = L.track.kind === "subtitle";
    // Video/Subtitle tracks toggle visibility; Audio tracks toggle mute.
    const visibilityIcon = isVideo || isSubtitle
      ? (L.track.hidden ? "🚫" : "👁")
      : (L.track.muted ? "🔇" : "🔊");
    const visibilityFlag = isVideo || isSubtitle ? "hidden" : "muted";
    const visibilityTitle = isVideo || isSubtitle ? "切换可见 / Toggle visibility" : "切换静音 / Toggle mute";
    const removable = state.tracks.filter((t) => t.kind === L.track.kind).length > 1;
    row.innerHTML = `
      <span class="tl-track-name">${escapeHtml(L.track.name)}</span>
      <span class="tl-track-flags">
        <button type="button" data-flag="locked" title="切换锁定 / Toggle lock">${L.track.locked ? "🔒" : "🔓"}</button>
        <button type="button" data-flag="${visibilityFlag}" title="${visibilityTitle}">${visibilityIcon}</button>
        ${removable ? `<button type="button" data-act="remove" title="删除轨道 / Remove track">✕</button>` : ""}
      </span>
    `;
    row.addEventListener("click", (e) => {
      const flagBtn = e.target.closest("button[data-flag]");
      const actBtn = e.target.closest("button[data-act]");
      if (flagBtn) {
        e.stopPropagation();
        toggleTrackFlag(L.track.id, flagBtn.dataset.flag);
        return;
      }
      if (actBtn && actBtn.dataset.act === "remove") {
        e.stopPropagation();
        removeTrack(L.track.id);
        return;
      }
      state.selectedTrackId = L.track.id;
      render();
    });
    headersDiv.appendChild(row);
  });

  // "+ track" buttons at the bottom of the header column.
  const addRow = document.createElement("div");
  addRow.className = "tl-add-row";
  addRow.innerHTML = `
    <button type="button" class="tl-add-btn" data-add="video" title="添加视频轨 / Add video track">+ V</button>
    <button type="button" class="tl-add-btn" data-add="audio" title="添加音频轨 / Add audio track">+ A</button>
    <button type="button" class="tl-add-btn" data-add="subtitle" title="添加字幕轨 / Add subtitle track">+ S</button>
  `;
  addRow.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-add]");
    if (!btn) return;
    e.stopPropagation();
    addTrack(btn.dataset.add);
  });
  headersDiv.appendChild(addRow);

  const scrollDiv = document.createElement("div");
  scrollDiv.className = "tl-scroll";
  scrollDiv.appendChild(svg);

  container.appendChild(headersDiv);
  container.appendChild(scrollDiv);

  // Restore the user's horizontal scroll position FIRST so the auto-scroll-
  // into-view check below sees the same offset the user was looking at.
  scrollDiv.scrollLeft = Math.max(0, Number(state.timelineScrollLeft) || 0);

  // Keep state.timelineScrollLeft in sync with the user's scrolling so the
  // next render() (e.g. playhead tick) doesn't reset us back to 0.
  scrollDiv.addEventListener("scroll", () => {
    state.timelineScrollLeft = scrollDiv.scrollLeft;
  }, { passive: true });

  // Ctrl + Wheel = zoom around the cursor. Without Ctrl, fall through to the
  // browser's normal horizontal/vertical scroll on the scroll div.
  scrollDiv.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = scrollDiv.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const oldScale = _lastTlGeometry.scale || scale;
    // Pin the time under the cursor — it stays under the cursor after zoom.
    const timeUnderCursor = (scrollDiv.scrollLeft + offsetX) / oldScale;
    // Dynamic bounds: max zooms in to per-frame visibility (fps-based), min
    // zooms out far enough to see one hour OR the full timeline (whichever
    // is longer) at a glance. Both anchors track the live container width
    // so resizing the panel auto-rescales the limits.
    const dur = _lastTlGeometry.runtime || 1;
    const ergonomicFit = _ergonomicFitScale(dur, scrollDiv.clientWidth);
    const [minZ, maxZ] = _computeTimelineZoomBounds(scrollDiv.clientWidth, ergonomicFit, dur);
    const prev = Math.max(minZ, Math.min(maxZ, Number(state.timelineZoom) || 1));
    const factor = e.deltaY < 0 ? 1.6 : 1 / 1.6;
    const next = Math.max(minZ, Math.min(maxZ, prev * factor));
    if (next === prev) return;
    state.timelineZoom = next;
    // Pre-compute the new scrollLeft. The scale relationship isn't strictly
    // linear when zoom crosses the 1.0 boundary (the formula switches between
    // interpolation and multiplication), so we approximate with the same
    // ratio — close enough that the visible jump is sub-pixel.
    state.timelineScrollLeft = Math.max(0, timeUnderCursor * (oldScale * (next / prev)) - offsetX);
    render();
  }, { passive: false });

  // Scroll selected clip into view. Search every V track since selected V
  // clips can now live on V2/V3 after a cross-track drop.
  let selSeg = null;
  for (const vLane of videoLanes) {
    const found = getVideoTrackSegments(vLane.track).find((s) => s.clip.id === state.selectedSequenceId);
    if (found) { selSeg = found; break; }
  }
  if (selSeg) {
    const clipX = Math.round(selSeg.start * scale);
    const clipW = Math.round(selSeg.duration * scale);
    const cW    = scrollDiv.clientWidth;
    if (clipX < scrollDiv.scrollLeft || clipX + clipW > scrollDiv.scrollLeft + cW) {
      scrollDiv.scrollLeft = Math.max(0, clipX - 20);
      state.timelineScrollLeft = scrollDiv.scrollLeft;
    }
  }
}

// Stop drag on mouseup anywhere
window.addEventListener("mouseup", () => { _tlDrag.active = false; });

/** Pick a "nice" tick interval (seconds) that gives roughly targetPx between ticks */
function _niceInterval(secondsPerTick) {
  const nice = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const n of nice) if (n >= secondsPerTick) return n;
  return nice[nice.length - 1];
}

/** Lighten a hex colour by mixing with white */
function _lighten(hex, amount = 0.25) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2,"0")}${lg.toString(16).padStart(2,"0")}${lb.toString(16).padStart(2,"0")}`;
}

function renderInspector() {
  // Subtitle cue wins when selected — most-recent selection model.
  if (state.selectedSubtitleId) {
    let target = null;
    for (const t of getSubtitleTracks()) {
      const c = t.clips.find((x) => x.id === state.selectedSubtitleId);
      if (c) { target = c; break; }
    }
    if (target) {
      els.inspectorEmpty.classList.add("hidden");
      els.clipInspector.classList.add("hidden");
      if (els.audioClipInspector) els.audioClipInspector.classList.add("hidden");
      if (els.subtitleClipInspector) els.subtitleClipInspector.classList.remove("hidden");
      if (els.subtitleCueText) els.subtitleCueText.value = target.text || "";
      if (els.subtitleCueStart) els.subtitleCueStart.value = Number(target.timelineStart || 0).toFixed(3);
      if (els.subtitleCueDuration) els.subtitleCueDuration.value = Number(target.duration || 0).toFixed(3);
      if (els.subtitleFontSize) els.subtitleFontSize.value = String(state.subtitleFontPx || 18);
      if (els.subtitleFontSizeLabel) els.subtitleFontSizeLabel.textContent = `${state.subtitleFontPx || 18} px`;
      return;
    }
  }
  if (els.subtitleClipInspector) els.subtitleClipInspector.classList.add("hidden");

  // A clip wins when selected — single-clip inspector mode at a time.
  if (state.selectedAudioClipId) {
    const aClip = getAudioClipById(state.selectedAudioClipId) || (function findInAnyA() {
      for (const t of getAudioTracks()) {
        const c = t.clips.find((x) => x.id === state.selectedAudioClipId);
        if (c) return c;
      }
      return null;
    })();
    if (aClip) {
      els.inspectorEmpty.classList.add("hidden");
      els.clipInspector.classList.add("hidden");
      if (els.audioClipInspector) els.audioClipInspector.classList.remove("hidden");
      if (els.audioClipName) els.audioClipName.value = aClip.name;
      if (els.audioTrimStart) els.audioTrimStart.value = Number(aClip.trimStart || 0).toFixed(3);
      if (els.audioTrimEnd) els.audioTrimEnd.value = Number(aClip.trimEnd || 0).toFixed(3);
      if (els.audioTimelineStart) els.audioTimelineStart.value = Number(aClip.timelineStart || 0).toFixed(3);
      if (els.audioGain) els.audioGain.value = String(Number(aClip.gain) || 1);
      if (els.audioGainLabel) els.audioGainLabel.textContent = `${Math.round((Number(aClip.gain) || 1) * 100)}%`;
      if (els.audioFadeIn) els.audioFadeIn.value = String(Number(aClip.fadeIn) || 0);
      if (els.audioFadeOut) els.audioFadeOut.value = String(Number(aClip.fadeOut) || 0);
      return;
    }
  }

  const clip = selectedSequenceClip();
  if (els.audioClipInspector) els.audioClipInspector.classList.add("hidden");
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
  // Speed / fade / gain (data-only for now; exporter integration is a
  // separate session).
  if (els.clipSpeed) els.clipSpeed.value = String(Number(clip.playbackRate) || 1);
  if (els.clipFadeIn) els.clipFadeIn.value = String(Number(clip.fadeIn) || 0);
  if (els.clipFadeOut) els.clipFadeOut.value = String(Number(clip.fadeOut) || 0);
  if (els.clipGain) els.clipGain.value = String(Number(clip.gain) || 1);
  if (els.clipGainLabel) els.clipGainLabel.textContent = `${Math.round((Number(clip.gain) || 1) * 100)}%`;
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
  els.previewModeChip.textContent = state.previewMode === "timeline" ? t("timelinePreview") : t("clipPreview");
  els.activeSegmentLabel.textContent = segment
    ? `${state.uiLanguage === "en" ? "Clip" : "片段"} ${segment.index + 1}/${state.sequence.length} | ${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)}`
    : t("timelineNotLoaded");
  els.proxyStatusLabel.textContent = describeProxyStatus(currentMedia);
  els.playTimelineButton.textContent = state.uiLanguage === "en"
    ? (playingTimeline ? "Pause Timeline" : "Play Timeline")
    : (playingTimeline ? "暂停时间线" : "播放时间线");
  _updateSubtitleOverlay();

  // Try the cheap path first: move the playhead via direct DOM mutation. If
  // the SVG isn't built yet (initial render or after a clip-change), fall
  // back to a full renderSequence so the playhead still appears.
  if (!_movePlayheadOnly()) {
    renderSequence();
  }
}

function renderOutputPath() {
  els.appendButton.disabled = !state.selectedLibraryId || state.exporting;
  if (els.openExportButton) {
    els.openExportButton.disabled = state.exporting || state.sequence.length === 0;
  }
  if (els.confirmExportButton) {
    els.confirmExportButton.disabled = state.exporting;
  }
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
  if (els.estimatedSize) els.estimatedSize.textContent = state.exportEstimate?.estimatedFileSizeLabel || "-";
  if (els.estimatedRenderTime) els.estimatedRenderTime.textContent = state.exportEstimate?.estimatedRenderLabel || "-";
  const durationLabel = formatTimecode(getSequenceDuration());
  if (els.estimatedDuration) els.estimatedDuration.textContent = durationLabel;
  if (els.estimatedDurationModal) els.estimatedDurationModal.textContent = durationLabel;
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
  renderSequence();      // renders visual timeline
  renderInspector();
  // renderTimelineTransport calls renderSequence internally; call it AFTER
  // so the playhead position is correct, but skip the second renderSequence
  // by calling the transport helper that doesn't re-render clips.
  _renderTransportOnly();
  syncAspectControls();
  renderExportSummary();
  renderOutputPath();
  renderUndoRedo();
}

function renderUndoRedo() {
  if (els.undoButton) els.undoButton.disabled = _history.undoStack.length === 0 || state.exporting;
  if (els.redoButton) els.redoButton.disabled = _history.redoStack.length === 0 || state.exporting;
}

/** Transport-only update (no clip re-render) used inside render() */
function _renderTransportOnly() {
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
  els.previewModeChip.textContent = state.previewMode === "timeline" ? t("timelinePreview") : t("clipPreview");
  els.activeSegmentLabel.textContent = segment
    ? `${state.uiLanguage === "en" ? "Clip" : "片段"} ${segment.index + 1}/${state.sequence.length} | ${formatTimecode(segment.start)} -> ${formatTimecode(segment.end)}`
    : t("timelineNotLoaded");
  els.proxyStatusLabel.textContent = describeProxyStatus(currentMedia);
  els.playTimelineButton.textContent = state.uiLanguage === "en"
    ? (playingTimeline ? "Pause Timeline" : "Play Timeline")
    : (playingTimeline ? "暂停时间线" : "播放时间线");
  _updateSubtitleOverlay();
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
    audioMuted: false,
    // V clips now carry an explicit `timelineStart` so they can be free-
    // positioned (drag to reorder, leave gaps, etc.). New clips are appended
    // at the current V-track end so the legacy "concat" behavior holds by
    // default until the user drags.
    timelineStart: 0,
  };
}

function appendClipsToSequence(clips) {
  pushHistorySnapshot();
  // New clips land after the existing last V clip's end.
  let cursor = 0;
  for (const c of state.sequence) {
    const end = (Number(c.timelineStart) || 0) + Math.max(0, (Number(c.trimEnd) || 0) - (Number(c.trimStart) || 0));
    if (end > cursor) cursor = end;
  }
  const next = clips.map((c) => {
    const sc = buildSequenceClip(c);
    sc.timelineStart = roundMs(cursor);
    cursor = sc.timelineStart + Math.max(0, sc.trimEnd - sc.trimStart);
    return sc;
  });
  state.sequence.push(...next);
  for (const lib of clips) warmUpPoolForClip(lib);
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
      // Drop the source-path pool entry (warmed up before the proxy was
      // ready) — its huge raw file is no longer what we want loaded into a
      // <video> element. Create a fresh entry for the proxy instead.
      const sourceEntry = _videoPool.get(mediaClip.path);
      if (sourceEntry && sourceEntry.video !== _activeVideoEl) {
        if (sourceEntry.video === _initialVideo) {
          _initialVideo.pause();
          _initialVideo.removeAttribute("src");
          _initialVideo.load();
          _initialVideoAssigned = false;
        } else {
          sourceEntry.video.pause();
          sourceEntry.video.removeAttribute("src");
          sourceEntry.video.load();
          sourceEntry.video.remove();
        }
        _videoPool.delete(mediaClip.path);
      }
      _getOrCreatePoolVideo(previewPath);
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

function loadPlayerSource(sourcePath, context, seekTime, autoplay, { fast = false } = {}) {
  const token = createId("preview");
  state.previewContext = {
    ...context,
    token,
    sourcePath,
    seekTime,
    usingProxy: context.mediaClip?.previewPath === sourcePath,
  };

  // Pool lookup is O(1) and avoids the html5 video reload entirely when this
  // source has been seen before — that's what makes hover-scrubbing across
  // clip boundaries feel like a single continuous video.
  const video = _getOrCreatePoolVideo(sourcePath);
  _setActiveVideo(video);

  const applyState = () => {
    if (state.previewContext?.token !== token) return;
    const target = clampNumber(
      seekTime,
      0,
      Number.isFinite(video.duration) ? video.duration : seekTime,
    );
    _seekVideo(video, target, { fast });
    if (autoplay) video.play().catch(() => null);
  };

  // HAVE_METADATA or beyond → seek immediately, no wait for a load event.
  if (video.readyState >= 1) {
    applyState();
  } else {
    video.addEventListener("loadedmetadata", applyState, { once: true });
  }
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

function previewLibraryClip(clip) {
  if (!clip) return;
  state.previewMode = "library";
  state.selectedLibraryId = clip.id;
  els.previewTitle.textContent = clip.name;
  els.previewMeta.textContent = `${formatDuration(clip.duration)} source`;
  els.previewHint.textContent = clip.hasAudio
    ? "Source clip loaded. Double-click it to add it to the sequence."
    : "This source clip has no audio track. Export will fill silence automatically.";

  const sourcePath = clip.previewPath || clip.path;
  loadPlayerSource(sourcePath, { kind: "library", mediaId: clip.id, mediaClip: clip }, 0, false);
  if (!clip.previewPath) ensurePreviewPath(clip).catch(() => null);
  renderTimelineTransport();
}

// Show the frame at the given timeline `time` in the program monitor WITHOUT
// moving the committed playhead, changing selection, or switching preview mode.
// Used for the 剪映-style hover preview: the user sees the frame under their
// cursor without disturbing where they last clicked.
function previewHoverFrame(time) {
  if (state.sequence.length === 0) return;
  const total = getSequenceDuration();
  if (total <= 0) return;
  const cursor = clampNumber(time, 0, total);
  const segment = findTimelineSegment(cursor);
  if (!segment) return;

  const mediaClip = getLibraryClipById(segment.clip.mediaId);
  const sourcePath = mediaClip?.previewPath || mediaClip?.path || segment.clip.path;
  const localTime = roundMs(segment.clip.trimStart + (cursor - segment.start));

  if (state.previewContext?.sourcePath === sourcePath) {
    // Hover within the same source: keyframe-snapped seek, much cheaper than
    // a precise seek and visually indistinguishable while the user is moving.
    _seekVideo(els.previewPlayer, localTime, { fast: true });
    return;
  }

  // Different source file — switch pool entries. fast:true on the post-load
  // seek keeps the cross-clip hover responsive too.
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
  }, localTime, false, { fast: true });
}

// After hover ends, snap the monitor back to whatever the committed state says
// it should show (timeline cursor frame or library clip).
function _revertMonitorToCommitted() {
  if (!els.previewPlayer.paused) return;
  if (state.previewMode === "timeline" && state.sequence.length > 0) {
    previewHoverFrame(state.timelineCursor);
    return;
  }
  if (state.previewMode === "library") {
    const clip = selectedLibraryClip();
    if (!clip) return;
    const sourcePath = clip.previewPath || clip.path;
    if (state.previewContext?.sourcePath === sourcePath) return;
    loadPlayerSource(sourcePath, { kind: "library", mediaId: clip.id, mediaClip: clip }, 0, false);
  }
}

// Skip-aware wrapper around previewTimelineAt. The program monitor is V1-only
// today: previewing the time of a V2/V3 clip would snap to whatever V1 has at
// that timestamp (or hold the last V1 frame) and silently overwrite the user's
// selection. Use this from any post-mutation site that wants to "follow" a
// specific clip; it stays a no-op for V2/V3.
function previewAfterClipMutation(clipId, time) {
  const owner = clipId ? findClipOwner(clipId) : null;
  if (!owner || owner.track !== getVideoTracks()[0]) return;
  previewTimelineAt(time, { forceReload: true });
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
  // Reuse the loaded video whenever the underlying file matches — even if the
  // sequence-clip id changed (e.g. crossing a split boundary). That keeps
  // scrubbing smooth instead of forcing a full reload on every move.
  const reusingCurrentSource = !options.forceReload &&
    context?.kind === "timeline" &&
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
    // Keep the context's segment metadata current so auto-advance + scrub
    // math stay accurate when we cross into a different sequence clip that
    // happens to share the same source file.
    state.previewContext = {
      ...context,
      mediaId: segment.clip.mediaId,
      mediaClip,
      sequenceId: segment.clip.id,
      segmentIndex: segment.index,
      segmentStart: segment.start,
      segmentEnd: segment.end,
      localStart: segment.clip.trimStart,
      localEnd: segment.clip.trimEnd,
    };
    if (Math.abs(els.previewPlayer.currentTime - localTime) > 0.02) {
      els.previewPlayer.currentTime = localTime;
    }
    if (options.autoplay) els.previewPlayer.play().catch(() => null);
    // Even in the same-source branch we may have just switched from library
    // mode into timeline mode — hide the misleading native controls now.
    _refreshActiveVideoControls();
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
  try {
    const filePaths = await window.editorAPI.openVideos();
    if (!filePaths?.length) return;
    await importByPaths(filePaths);
  } catch (error) {
    setStatus("Import Failed", error.message || "Could not import the selected files.", 0);
  }
}

// Shared import path used by the Import button, drag-and-drop, and project
// load. Filters duplicates against the library, probes via ffprobe, then
// kicks off proxy preparation in the background.
async function importByPaths(filePaths) {
  if (!filePaths?.length) return [];
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
      thumbnailStripPath: null,
      waveformPath: null,
    };
    state.library.push(clip);
    imported.push(clip);
    existingPaths.add(result.path);
  });

  if (imported.length === 0) {
    render();
    setStatus("Ready", "No new playable clips were added from that selection.", 0);
    return [];
  }

  const firstClip = imported[0];
  state.selectedLibraryId = firstClip.id;
  queuePreviewPreparation(imported);
  // Generate thumbnail strips + waveforms in the background; results land
  // in state.library entries when ready and a render() picks them up.
  imported.forEach((clip) => {
    queueThumbnailStrip(clip);
    if (clip.hasAudio) queueWaveform(clip);
  });
  previewLibraryClip(firstClip);
  render();
  refreshExportEstimate();
  setStatus("Ready", `Imported ${imported.length} clip${imported.length === 1 ? "" : "s"}.`, 0);
  return imported;
}

// Promise-throttled thumbnail strip generation. Each call is queued behind
// the previous so we don't spawn 50 parallel ffmpeg processes on a big import.
let _thumbQueue = Promise.resolve();
function queueThumbnailStrip(mediaClip) {
  if (!mediaClip || mediaClip.thumbnailStripPath) return;
  _thumbQueue = _thumbQueue
    .then(() => window.editorAPI.buildThumbnailStrip(mediaClip.path))
    .then((out) => {
      if (out) {
        mediaClip.thumbnailStripPath = out;
        renderLibrary();
        renderSequence();
      }
    })
    .catch(() => null);
}

let _waveQueue = Promise.resolve();
function queueWaveform(mediaClip) {
  if (!mediaClip || mediaClip.waveformPath) return;
  _waveQueue = _waveQueue
    .then(() => window.editorAPI.buildWaveform(mediaClip.path))
    .then((out) => {
      if (out) {
        mediaClip.waveformPath = out;
        renderLibrary();
        renderSequence();
      }
    })
    .catch(() => null);
}

// ── Subtitle file parsing / serialization ─────────────────────────────
// SRT format:
//   <index>\n
//   HH:MM:SS,mmm --> HH:MM:SS,mmm\n
//   <one or more text lines>\n
//   \n   (blank line between cues)
//
// VTT is similar but uses '.' for the millisecond separator and starts with
// "WEBVTT" header. We normalize both into the same in-memory cue shape:
//   { id, timelineStart, duration, text }

function _parseSrtTimestamp(stamp) {
  // Accept "HH:MM:SS,mmm" or "HH:MM:SS.mmm" or "MM:SS,mmm".
  const m = String(stamp).trim().match(/^(?:(\d+):)?(\d+):(\d+)[,.](\d+)$/);
  if (!m) return null;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0").slice(0, 3));
  return h * 3600 + min * 60 + s + ms / 1000;
}

function parseSubtitleFile(text, formatHint = "srt") {
  if (!text) return [];
  // Strip BOM, normalize line endings, drop WEBVTT header if present.
  const cleaned = String(text)
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/^WEBVTT[^\n]*\n+/i, "");
  const blocks = cleaned.split(/\n{2,}/);
  const cues = [];
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    const lines = block.split("\n");
    // Optional numeric index line — skip if present.
    let idx = 0;
    if (/^\d+$/.test(lines[0])) idx = 1;
    const timeLine = lines[idx];
    if (!timeLine || !timeLine.includes("-->")) continue;
    const [startRaw, endRaw] = timeLine.split("-->").map((s) => s.trim().split(/\s+/)[0]);
    const start = _parseSrtTimestamp(startRaw);
    const end = _parseSrtTimestamp(endRaw);
    if (start == null || end == null || end <= start) continue;
    const text = lines.slice(idx + 1).join("\n").trim();
    if (!text) continue;
    cues.push({
      id: createId("sub"),
      timelineStart: roundMs(start),
      duration: roundMs(end - start),
      text,
    });
  }
  return cues;
}

function _toSrtTimestamp(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const totalMs = Math.round(safe * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function serializeSubtitlesToSrt(cues) {
  return cues
    .slice()
    .sort((a, b) => (a.timelineStart || 0) - (b.timelineStart || 0))
    .map((cue, i) => {
      const start = _toSrtTimestamp(cue.timelineStart);
      const end = _toSrtTimestamp((cue.timelineStart || 0) + (cue.duration || 0));
      return `${i + 1}\n${start} --> ${end}\n${cue.text || ""}\n`;
    })
    .join("\n");
}

// Add a parsed cue list to a subtitle track (creating S1 if needed). If a
// non-empty subtitle track exists, the user is prompted to clear it first;
// the alternative would be merging cues with overlapping timestamps which
// is confusing.
function loadSubtitleCues(cues, { mode = "replace" } = {}) {
  if (!cues || cues.length === 0) {
    setStatus("No cues", "字幕文件里没有读到任何 cue。", 0);
    return;
  }
  pushHistorySnapshot();
  const track = getOrCreateFirstSubtitleTrack();
  if (mode === "replace") track.clips = [];
  for (const c of cues) track.clips.push(c);
  render();
  refreshExportEstimate();
  setStatus("Subtitles loaded", `Imported ${cues.length} cue${cues.length === 1 ? "" : "s"} → ${track.name}.`, null);
}

async function importSubtitleFile() {
  try {
    const res = await window.editorAPI.openSubtitleFile();
    if (!res) return;
    const cues = parseSubtitleFile(res.text, res.path?.endsWith(".vtt") ? "vtt" : "srt");
    loadSubtitleCues(cues, { mode: "replace" });
  } catch (e) {
    setStatus("Import Failed", e.message || "Could not load subtitle file.", 0);
  }
}

// ── Offline subtitle generation (ytsubtitle / faster-whisper) ──────────
// Calls the bundled Python CLI in D:\youtubesubtitle\.venv\Scripts\python.exe
// via the main process IPC. Streams progress events back to update a live
// status bar; on completion, reads the generated .srt file and loads cues
// into the subtitle track (shifted to the right timeline position).

const YTSUB_ROOT_STORAGE = "cutline.ytsubRoot";
// Cached bundled engine path — resolved lazily via main process IPC since
// the renderer doesn't have __dirname. Falls back to the legacy external
// install path while the IPC resolves on first open.
let _bundledEngineRoot = null;
async function _getBundledEngineRoot() {
  if (_bundledEngineRoot) return _bundledEngineRoot;
  try {
    _bundledEngineRoot = await window.editorAPI.getEngineRoot();
  } catch {
    _bundledEngineRoot = "subtitle-engine";
  }
  return _bundledEngineRoot;
}

// Registered progress listener (set inside runLocalSubtitleGeneration so we
// can dispose it on completion without leaking listeners across runs).
let _activeTranscribeUnsubscribe = null;

function _setTranscribeStatus(text, etaText = "") {
  if (els.ytsubStatus) els.ytsubStatus.textContent = text;
  if (els.ytsubEta) els.ytsubEta.textContent = etaText;
}

function _setTranscribePercent(pct) {
  if (!els.ytsubProgressBar) return;
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  els.ytsubProgressBar.style.width = `${v}%`;
}

function _formatEtaSecs(s) {
  if (!Number.isFinite(s) || s < 0) return "";
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `ETA ${sec}s`;
  return `ETA ${m}m ${String(sec).padStart(2, "0")}s`;
}

async function openGenerateSubtitlesModal() {
  if (state.exporting) return;
  if (state.sequence.length === 0 && !state.selectedSequenceId) {
    setStatus("Empty", "时间线为空 — 先添加视频片段。", 0);
    return;
  }
  if (!els.generateSubtitleModal) return;
  // Default to the editor's bundled subtitle-engine folder. Only honor a saved
  // override if the user explicitly picked one in a previous session.
  const bundledRoot = await _getBundledEngineRoot();
  try {
    const saved = localStorage.getItem(YTSUB_ROOT_STORAGE);
    if (els.ytsubRoot) els.ytsubRoot.value = saved || bundledRoot;
    const savedModel = localStorage.getItem("cutline.ytsubModel");
    if (savedModel && els.ytsubModel) els.ytsubModel.value = savedModel;
    const savedDevice = localStorage.getItem("cutline.ytsubDevice");
    if (savedDevice && els.ytsubDevice) els.ytsubDevice.value = savedDevice;
  } catch {}
  _setTranscribeStatus("准备就绪 / Ready.");
  _setTranscribePercent(0);
  els.generateSubtitleModal.classList.remove("hidden");
  els.generateSubtitleModal.setAttribute("aria-hidden", "false");
  await _refreshEngineStatus();
  setTimeout(() => els.confirmGenerateSubtitle?.focus(), 30);
}

// Inspect the engine root the user is pointed at and toggle the Setup button
// + status hint accordingly. Called when opening the modal AND after the
// "Reset" button picks the bundled path.
async function _refreshEngineStatus() {
  if (!els.ytsubEngineStatus) return;
  const root = (els.ytsubRoot?.value || "").trim();
  els.ytsubEngineStatus.textContent = "检测中… / Probing…";
  let info;
  try {
    info = await window.editorAPI.checkEngineStatus(root || undefined);
  } catch (e) {
    els.ytsubEngineStatus.textContent = `检查失败 / Check failed: ${e.message || e}`;
    return;
  }
  if (!info.rootExists) {
    els.ytsubEngineStatus.textContent = `⚠ 目录不存在 / Folder not found: ${info.root}`;
    if (els.setupEngineButton) els.setupEngineButton.disabled = true;
    if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.disabled = true;
    return;
  }
  if (!info.venvExists) {
    els.ytsubEngineStatus.innerHTML = `⚠ 未安装 venv / venv not found at <code>${escapeHtml(info.root)}\\.venv</code> — 点击「安装 Engine」`;
    if (els.setupEngineButton) els.setupEngineButton.disabled = false;
    if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.disabled = true;
    return;
  }
  els.ytsubEngineStatus.innerHTML = `✓ Engine 就绪 / Ready (<code>${escapeHtml(info.root)}</code>)`;
  if (els.setupEngineButton) els.setupEngineButton.disabled = true;
  if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.disabled = false;
}

async function runEngineSetupFlow() {
  if (!els.setupEngineButton) return;
  const root = (els.ytsubRoot?.value || "").trim() || (await _getBundledEngineRoot());
  els.setupEngineButton.disabled = true;
  if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.disabled = true;
  _setTranscribePercent(5);
  _setTranscribeStatus("正在安装 venv 和依赖… 这要几分钟，第一次跑会下载 ~300MB");
  // Reuse the same progress channel so the modal's progress block streams
  // pip's "Collecting..." / "Installing..." lines live.
  const unsub = window.editorAPI.onTranscribeProgress((data) => {
    if (data?.event === "log" && data.line) _setTranscribeStatus(data.line.slice(0, 200));
  });
  try {
    await window.editorAPI.runEngineSetup(root);
    _setTranscribePercent(100);
    _setTranscribeStatus("✓ Engine 安装完成 / Setup complete.");
  } catch (e) {
    _setTranscribeStatus(`安装失败 / Setup failed: ${e.message || e}`);
  } finally {
    unsub();
    await _refreshEngineStatus();
  }
}

function closeGenerateSubtitlesModal() {
  if (!els.generateSubtitleModal) return;
  // If a transcribe job is running, signal cancel — both to short-circuit our
  // per-clip loop AND to kill the active Python subprocess in main.js so the
  // user doesn't pay for it after closing the modal.
  _transcribeCancelled = true;
  try { window.editorAPI.cancelTranscribe?.(); } catch {}
  els.generateSubtitleModal.classList.add("hidden");
  els.generateSubtitleModal.setAttribute("aria-hidden", "true");
  if (_activeTranscribeUnsubscribe) {
    _activeTranscribeUnsubscribe();
    _activeTranscribeUnsubscribe = null;
  }
}

// Pick the audio source(s) for transcription. Returns an array of source
// descriptors so the caller can loop over them; for "all-timeline" mode we
// include every V-track clip (in timelineStart order) so the user gets
// continuous coverage. "selected" / "timeline" return a single-element array.
function _pickTranscribeSources(mode) {
  if (mode === "selected" && state.selectedSequenceId) {
    const owner = findClipOwner(state.selectedSequenceId);
    if (owner && owner.track.kind === "video") {
      return [{
        inputPath: owner.clip.path,
        trimStart: Number(owner.clip.trimStart) || 0,
        trimEnd: Number(owner.clip.trimEnd) || owner.clip.sourceDuration,
        timelineOffset: Number(owner.clip.timelineStart) || 0,
        name: owner.clip.name,
      }];
    }
  }
  if (mode === "all-timeline") {
    const all = [];
    for (const t of state.tracks) {
      if (t.kind !== "video" || t.hidden) continue;
      for (const c of t.clips) {
        all.push({
          inputPath: c.path,
          trimStart: Number(c.trimStart) || 0,
          trimEnd: Number(c.trimEnd) || c.sourceDuration,
          timelineOffset: Number(c.timelineStart) || 0,
          name: c.name,
        });
      }
    }
    all.sort((a, b) => a.timelineOffset - b.timelineOffset);
    return all;
  }
  const first = state.sequence[0];
  if (!first) return [];
  return [{
    inputPath: first.path,
    trimStart: Number(first.trimStart) || 0,
    trimEnd: Number(first.trimEnd) || first.sourceDuration,
    timelineOffset: Number(first.timelineStart) || 0,
    name: first.name,
  }];
}

// Tracked so the Cancel button can abort an in-flight run between clips.
let _transcribeCancelled = false;

async function runLocalSubtitleGeneration() {
  const ytsubRoot = (els.ytsubRoot?.value || "").trim() || (await _getBundledEngineRoot());
  // Only persist a NON-bundled custom path so we don't lock users into a
  // stale absolute path after they move the app folder.
  try {
    const bundled = await _getBundledEngineRoot();
    if (ytsubRoot && ytsubRoot !== bundled) localStorage.setItem(YTSUB_ROOT_STORAGE, ytsubRoot);
    else localStorage.removeItem(YTSUB_ROOT_STORAGE);
  } catch {}
  const model = els.ytsubModel?.value || "medium";
  const device = els.ytsubDevice?.value || "auto";
  const language = els.ytsubLanguage?.value || "";
  const lowVram = !!els.ytsubLowVram?.checked;
  const accurateTiming = !!els.ytsubAccurate?.checked;
  const initialPrompt = els.ytsubPrompt?.value || "";
  const mode = els.ytsubSource?.value || "all-timeline";
  try {
    localStorage.setItem("cutline.ytsubModel", model);
    localStorage.setItem("cutline.ytsubDevice", device);
  } catch {}

  const sources = _pickTranscribeSources(mode);
  if (sources.length === 0) {
    _setTranscribeStatus("找不到可转写的视频片段。");
    return;
  }

  _transcribeCancelled = false;
  els.confirmGenerateSubtitle.disabled = true;
  // Switch the cancel button into "stop the running job" mode while we work.
  if (els.cancelGenerateSubtitle) els.cancelGenerateSubtitle.textContent = "取消 / Cancel";

  const collectedCues = [];
  const totalClipDur = sources.reduce(
    (acc, s) => acc + Math.max(0, (Number(s.trimEnd) || 0) - (Number(s.trimStart) || 0)),
    0,
  );
  let processedClipDur = 0;

  for (let i = 0; i < sources.length; i++) {
    if (_transcribeCancelled) break;
    const source = sources[i];
    const clipDur = Math.max(0, (Number(source.trimEnd) || 0) - (Number(source.trimStart) || 0));
    const baseLabel = sources.length > 1
      ? `片段 ${i + 1}/${sources.length} ${source.name || ""} · `
      : "";

    _setTranscribeStatus(`${baseLabel}提取音频中… / Extracting audio…`);
    if (totalClipDur > 0) {
      _setTranscribePercent((processedClipDur / totalClipDur) * 100);
    }

    let audioPath;
    try {
      audioPath = await window.editorAPI.extractSubtitleAudio({
        inputPath: source.inputPath,
        trimStart: source.trimStart,
        trimEnd: source.trimEnd,
      });
    } catch (e) {
      _setTranscribeStatus(`音频提取失败: ${e.message || e}`);
      _resetTranscribeUI();
      return;
    }

    if (_transcribeCancelled) break;

    // Wire the progress stream for THIS clip. Reset between clips so the bar
    // moves smoothly and the per-clip ETA isn't polluted by the previous run.
    let totalSec = clipDur;
    // Track whether the first real progress event has arrived. Until then,
    // log lines (model-load chatter from faster-whisper) are the only signal
    // we have; once progress starts flowing we ignore log noise so the
    // numeric readout doesn't get clobbered.
    let progressStarted = false;
    if (_activeTranscribeUnsubscribe) _activeTranscribeUnsubscribe();
    _activeTranscribeUnsubscribe = window.editorAPI.onTranscribeProgress((data) => {
      if (!data || typeof data !== "object") return;
      switch (data.event) {
        case "duration":
          if (Number.isFinite(data.duration) && data.duration > 0) totalSec = data.duration;
          break;
        case "progress": {
          progressStarted = true;
          const processed = Number(data.seconds) || 0;
          // Overall percent across all clips — much more useful than per-clip
          // percent when transcribing a whole timeline.
          const overallProcessed = processedClipDur + Math.min(processed, totalSec);
          const pct = totalClipDur > 0 ? Math.min(99, (overallProcessed / totalClipDur) * 100) : 0;
          _setTranscribePercent(pct);
          _setTranscribeStatus(
            `${baseLabel}${pct.toFixed(1)}% · ${formatTimecode(processed)} / ${formatTimecode(totalSec)} · ${data.cue_count || 0} cues`,
            _formatEtaSecs(data.eta_seconds),
          );
          break;
        }
        case "done":
          _setTranscribeStatus(`${baseLabel}片段完成 — ${data.cue_count || 0} cues.`);
          break;
        case "log":
          // Suppress log noise once real progress is flowing so it doesn't
          // overwrite the percent / ETA readout.
          if (!progressStarted && data.line) {
            _setTranscribeStatus(`${baseLabel}${data.line.slice(0, 200)}`);
          }
          break;
      }
    });

    _setTranscribeStatus(`${baseLabel}启动本地转写进程… / Starting local Whisper…`);
    let result;
    try {
      result = await window.editorAPI.transcribeLocal({
        inputPath: audioPath,
        ytsubRoot,
        model,
        device,
        language,
        lowVram,
        accurateTiming,
        initialPrompt,
      });
    } catch (e) {
      if (_activeTranscribeUnsubscribe) { _activeTranscribeUnsubscribe(); _activeTranscribeUnsubscribe = null; }
      if (_transcribeCancelled) break;
      _setTranscribeStatus(`转写失败: ${e.message || e}`);
      _resetTranscribeUI();
      return;
    }
    if (_activeTranscribeUnsubscribe) { _activeTranscribeUnsubscribe(); _activeTranscribeUnsubscribe = null; }

    // Cues come back relative to the extracted audio slice — shift by the
    // clip's timeline offset so they land at the right place in the project.
    const cues = parseSubtitleFile(result?.srtText || "", "srt");
    for (const c of cues) {
      c.timelineStart = roundMs((Number(c.timelineStart) || 0) + (source.timelineOffset || 0));
    }
    collectedCues.push(...cues);

    processedClipDur += clipDur;
  }

  if (_transcribeCancelled) {
    _setTranscribeStatus("已取消 / Cancelled.");
    _resetTranscribeUI();
    return;
  }

  if (collectedCues.length === 0) {
    _setTranscribeStatus("Whisper 没有返回任何 cue。");
    _resetTranscribeUI();
    return;
  }
  loadSubtitleCues(collectedCues, { mode: "replace" });
  _setTranscribePercent(100);
  _setTranscribeStatus(`完成 — 导入 ${collectedCues.length} 条字幕。`);
  _resetTranscribeUI();
  setTimeout(closeGenerateSubtitlesModal, 1500);
}

// Restore the buttons after a run finishes / errors / is cancelled.
function _resetTranscribeUI() {
  if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.disabled = false;
  if (els.cancelGenerateSubtitle) els.cancelGenerateSubtitle.textContent = "取消 / Cancel";
  if (_activeTranscribeUnsubscribe) {
    _activeTranscribeUnsubscribe();
    _activeTranscribeUnsubscribe = null;
  }
}

async function exportSubtitleFile() {
  const cues = getSubtitleTracks().flatMap((t) => t.clips);
  if (cues.length === 0) {
    setStatus("Nothing to export", "字幕轨为空 — 先导入或生成字幕。", 0);
    return;
  }
  try {
    const srt = serializeSubtitlesToSrt(cues);
    const written = await window.editorAPI.saveSubtitleFile(null, srt);
    if (!written) return;
    setStatus("Saved", `字幕已导出到 ${written}.`, null);
  } catch (e) {
    setStatus("Export Failed", e.message || "Could not save subtitle file.", 0);
  }
}

// ── Project save / load ────────────────────────────────────────────────
// Serialized format is intentionally simple JSON so the file is human-
// inspectable. Library is referenced by absolute file path; on load we
// re-probe every clip so a missing file is flagged early.
const PROJECT_FORMAT_VERSION = 1;

function serializeProject() {
  return {
    format: "cutline-project",
    version: PROJECT_FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    library: state.library.map((c) => ({
      path: c.path,
      name: c.name,
      duration: c.duration,
      width: c.width,
      height: c.height,
      hasAudio: c.hasAudio,
      hasVideo: c.hasVideo,
      sizeLabel: c.sizeLabel,
    })),
    tracks: state.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      name: t.name,
      locked: !!t.locked,
      hidden: !!t.hidden,
      muted: !!t.muted,
      solo: !!t.solo,
      clips: t.clips.map((c) => ({
        ...c,
        // Strip transient runtime-only fields so the file stays clean
        previewPath: undefined,
        previewStatus: undefined,
        previewPromise: undefined,
      })),
    })),
    cursor: state.timelineCursor,
    selectedSequenceId: state.selectedSequenceId,
    selectedAudioClipId: state.selectedAudioClipId,
    selectedSubtitleId: state.selectedSubtitleId,
    selectedLibraryId: state.selectedLibraryId,
    timelineZoom: state.timelineZoom,
  };
}

async function applyProjectJson(jsonText, sourcePath) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    setStatus("Open Failed", `工程文件解析失败: ${e.message}`, 0);
    return false;
  }
  if (parsed?.format !== "cutline-project") {
    setStatus("Open Failed", "不是 Cutline 工程文件。", 0);
    return false;
  }
  // Re-probe every referenced media file so we get fresh metadata + catch
  // missing files up-front.
  const libPaths = (parsed.library || []).map((c) => c.path).filter(Boolean);
  let probes = [];
  if (libPaths.length > 0) {
    try {
      probes = await window.editorAPI.probeFiles(libPaths);
    } catch (e) {
      probes = [];
    }
  }
  const probeByPath = new Map(probes.map((p) => [p.path, p]));
  const reLibrary = (parsed.library || []).map((c) => {
    const probe = probeByPath.get(c.path);
    return {
      id: createId("media"),
      path: c.path,
      name: c.name || probe?.name || c.path.split(/[/\\]/).pop(),
      duration: probe?.duration ?? c.duration,
      width: probe?.width ?? c.width,
      height: probe?.height ?? c.height,
      hasAudio: probe?.hasAudio ?? c.hasAudio,
      hasVideo: probe?.hasVideo ?? c.hasVideo,
      sizeLabel: probe?.sizeLabel ?? c.sizeLabel,
      previewPath: null,
      previewStatus: probe?.error ? "failed" : "idle",
      previewPromise: null,
      previewError: probe?.error || null,
    };
  });

  // Replace state — wipe history + selection + cursor so the loaded project
  // is the new baseline.
  state.library = reLibrary;
  // The saved file doesn't persist library ids, so reLibrary entries get fresh
  // ids above. Timeline/audio clips still carry their OLD mediaId, so re-link
  // each clip to the new library entry by matching its stored `path`. Without
  // this, every clip's mediaId dangles after load — breaking proxy preview,
  // timeline thumbnails/waveforms, library↔clip selection, and the cascade
  // delete that removes timeline clips when their library source is removed.
  // Subtitle cues carry no path and are left untouched.
  const newLibraryIdByPath = new Map(reLibrary.map((c) => [c.path, c.id]));
  state.tracks = (parsed.tracks || []).map((t) => ({
    id: t.id,
    kind: t.kind,
    name: t.name,
    locked: !!t.locked,
    hidden: !!t.hidden,
    muted: !!t.muted,
    solo: !!t.solo,
    clips: Array.isArray(t.clips)
      ? t.clips.map((c) =>
          c && c.path && newLibraryIdByPath.has(c.path)
            ? { ...c, mediaId: newLibraryIdByPath.get(c.path) }
            : c,
        )
      : [],
  }));
  // Ensure at least one V and one A track exist.
  if (!state.tracks.some((t) => t.kind === "video")) {
    state.tracks.unshift({ id: "video-0", kind: "video", name: "V1", locked: false, hidden: false, clips: [] });
  }
  if (!state.tracks.some((t) => t.kind === "audio")) {
    state.tracks.push({ id: "audio-0", kind: "audio", name: "A1", locked: false, muted: false, solo: false, clips: [] });
  }
  state.sequence = state.tracks.find((t) => t.kind === "video").clips;
  state.audioClips = state.tracks.find((t) => t.kind === "audio").clips;
  state.timelineCursor = Number(parsed.cursor) || 0;
  state.selectedSequenceId = parsed.selectedSequenceId || null;
  state.selectedAudioClipId = parsed.selectedAudioClipId || null;
  state.selectedSubtitleId = parsed.selectedSubtitleId || null;
  state.selectedLibraryId = parsed.selectedLibraryId || (reLibrary[0]?.id ?? null);
  state.timelineZoom = Number(parsed.timelineZoom) || 1;
  state.timelineScrollLeft = 0;
  state.multiSelectIds = [];
  state.projectPath = sourcePath || null;
  // Wipe undo/redo so the loaded project is the new starting point.
  _history.undoStack.length = 0;
  _history.redoStack.length = 0;
  // Re-probe proxies + thumbnails in the background for every clip.
  queuePreviewPreparation(reLibrary);
  reLibrary.forEach((c) => {
    queueThumbnailStrip(c);
    if (c.hasAudio) queueWaveform(c);
  });
  if (state.selectedLibraryId) {
    const lib = getLibraryClipById(state.selectedLibraryId);
    if (lib) previewLibraryClip(lib);
  }
  render();
  refreshExportEstimate();
  setStatus("Opened", `Loaded project from ${sourcePath || "memory"}.`, null);
  return true;
}

async function saveProject() {
  if (state.exporting) return;
  try {
    const json = JSON.stringify(serializeProject(), null, 2);
    const written = await window.editorAPI.saveProjectFile(state.projectPath, json);
    if (!written) return;
    state.projectPath = written;
    addRecentProject(written);
    setStatus("Saved", `Project saved → ${written}`, null);
  } catch (e) {
    setStatus("Save Failed", e.message || "Could not save project.", 0);
  }
}

async function saveProjectAs() {
  if (state.exporting) return;
  try {
    const json = JSON.stringify(serializeProject(), null, 2);
    const written = await window.editorAPI.saveProjectFile(null, json);
    if (!written) return;
    state.projectPath = written;
    addRecentProject(written);
    setStatus("Saved", `Project saved → ${written}`, null);
  } catch (e) {
    setStatus("Save Failed", e.message || "Could not save project.", 0);
  }
}

async function openProjectFromDisk() {
  if (state.exporting) return;
  try {
    const filePath = await window.editorAPI.openProjectFile();
    if (!filePath) return;
    const result = await window.editorAPI.readProjectFile(filePath);
    if (!result) return;
    const ok = await applyProjectJson(result.text, result.path);
    if (ok) addRecentProject(result.path);
  } catch (e) {
    setStatus("Open Failed", e.message || "Could not open project.", 0);
  }
}

// ── Recent projects (localStorage, last 8 paths) ───────────────────────
const RECENT_KEY = "cutline.recentProjects";
const RECENT_MAX = 8;
function getRecentProjects() {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function addRecentProject(filePath) {
  if (!filePath) return;
  const list = getRecentProjects().filter((p) => p !== filePath);
  list.unshift(filePath);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
  } catch {}
}

function showRecentProjectsMenu(anchorEl) {
  const list = getRecentProjects();
  // Reuse the timeline context-menu styling.
  const menu = document.createElement("div");
  menu.className = "tl-context-menu";
  if (list.length === 0) {
    menu.innerHTML = `<div class="menu-label">暂无最近工程 / No recent projects</div>`;
  } else {
    menu.innerHTML = `<div class="menu-label">最近工程 / Recent</div>` + list.map((p, i) => {
      const display = p.length > 60 ? "…" + p.slice(-58) : p;
      return `<button type="button" data-path="${escapeHtml(p)}">${escapeHtml(display)}</button>`;
    }).join("") + `<div class="menu-divider"></div><button type="button" data-clear="1" class="danger">清空 / Clear</button>`;
  }
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  menu.style.left = `${Math.round(rect.left)}px`;
  menu.style.top = `${Math.round(rect.bottom + 4)}px`;
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
  };
  const outside = (e) => { if (!menu.contains(e.target) && e.target !== anchorEl) close(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  menu.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.clear) {
      try { localStorage.removeItem(RECENT_KEY); } catch {}
      close();
      return;
    }
    const targetPath = btn.dataset.path;
    close();
    if (!targetPath) return;
    try {
      const result = await window.editorAPI.readProjectFile(targetPath);
      if (!result) return;
      const ok = await applyProjectJson(result.text, result.path);
      if (ok) addRecentProject(result.path);
    } catch (err) {
      setStatus("Open Failed", err.message || "Could not open project.", 0);
    }
  });
  setTimeout(() => {
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", esc, true);
  }, 0);
}

// ── Autosave (localStorage, 1s debounce) ───────────────────────────────
// Lets the user recover after a crash / accidental close without forcing
// every action to hit disk.
const AUTOSAVE_KEY = "cutline.autosave";
let _autosaveTimer = 0;
function scheduleAutosave() {
  clearTimeout(_autosaveTimer);
  _autosaveTimer = setTimeout(() => {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeProject()));
    } catch (e) {
      // Quota errors are non-fatal; just skip this autosave round.
    }
  }, 1000);
}

// OS drag-and-drop import. Adds a translucent overlay during a drag so the
// user knows the drop will be accepted. Resolves File objects to absolute
// paths via the preload helper (webUtils.getPathForFile in Electron 32+).
function wireDragAndDropImport() {
  const overlay = document.createElement("div");
  overlay.className = "dnd-overlay hidden";
  overlay.innerHTML = `<div class="dnd-overlay-msg">拖入视频文件 / Drop video files to import</div>`;
  document.body.appendChild(overlay);

  let dragDepth = 0;
  const accept = (types) => Array.from(types || []).includes("Files");

  window.addEventListener("dragenter", (e) => {
    if (!accept(e.dataTransfer?.types)) return;
    dragDepth++;
    overlay.classList.remove("hidden");
  });
  window.addEventListener("dragover", (e) => {
    if (!accept(e.dataTransfer?.types)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", (e) => {
    if (!accept(e.dataTransfer?.types)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add("hidden");
  });
  window.addEventListener("drop", async (e) => {
    if (!accept(e.dataTransfer?.types)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.classList.add("hidden");
    if (state.exporting) return;
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    const paths = files
      .map((f) => window.editorAPI.resolveDroppedFilePath(f))
      .filter(Boolean);
    if (paths.length === 0) {
      setStatus("Drop Failed", "无法解析拖入文件的路径。", 0);
      return;
    }
    try {
      await importByPaths(paths);
    } catch (err) {
      setStatus("Import Failed", err.message || "Drop import failed.", 0);
    }
  });
}

function tryRestoreAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    const hasContent = (parsed?.tracks || []).some((t) => (t.clips || []).length > 0);
    if (!hasContent) return false;
    // Only auto-restore if there's no project loaded yet AND user confirms.
    // Use confirm() since we don't have a custom modal lying around.
    const ts = parsed.savedAt ? new Date(parsed.savedAt).toLocaleString() : "unknown time";
    const yes = window.confirm(`Found an autosaved session from ${ts}. Restore it?`);
    if (!yes) {
      // Drop it so the user isn't re-prompted on every relaunch.
      try { localStorage.removeItem(AUTOSAVE_KEY); } catch {}
      return false;
    }
    applyProjectJson(raw, null);
    return true;
  } catch {
    return false;
  }
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

function bindInspectorInputs() {
  const commitTrim = () => {
    const clip = selectedSequenceClip();
    if (!clip) return;
    const nextStart = clampNumber(els.trimStart.value, 0, clip.sourceDuration);
    const nextEnd = clampNumber(els.trimEnd.value, nextStart + 0.001, clip.sourceDuration);
    if (clip.trimStart === roundMs(nextStart) && clip.trimEnd === roundMs(nextEnd)) return;
    pushHistorySnapshot();
    clip.trimStart = roundMs(nextStart);
    clip.trimEnd = roundMs(nextEnd);
    const segment = getSequenceSegmentByClipId(clip.id);
    if (segment) {
      const nextCursor = clampNumber(state.timelineCursor, segment.start, roundMs(segment.start + (clip.trimEnd - clip.trimStart)));
      previewAfterClipMutation(clip.id, nextCursor);
    }
    render();
    refreshExportEstimate();
  };
  els.trimStart.addEventListener("change", commitTrim);
  els.trimEnd.addEventListener("change", commitTrim);

  // Speed / fade / gain — data-only commits (no exporter integration yet).
  // We still snapshot history so undo/redo covers the change.
  const commitClipField = (field, value) => {
    const clip = selectedSequenceClip();
    if (!clip) return;
    if (clip[field] === value) return;
    pushHistorySnapshot();
    clip[field] = value;
    render();
  };
  if (els.clipSpeed) {
    els.clipSpeed.addEventListener("change", () => {
      const v = clampNumber(els.clipSpeed.value, 0.25, 4);
      commitClipField("playbackRate", Number(v.toFixed(3)));
    });
  }
  if (els.clipFadeIn) {
    els.clipFadeIn.addEventListener("change", () => {
      commitClipField("fadeIn", Math.max(0, Number(els.clipFadeIn.value) || 0));
    });
  }
  if (els.clipFadeOut) {
    els.clipFadeOut.addEventListener("change", () => {
      commitClipField("fadeOut", Math.max(0, Number(els.clipFadeOut.value) || 0));
    });
  }
  if (els.clipGain) {
    els.clipGain.addEventListener("input", () => {
      const v = clampNumber(els.clipGain.value, 0, 2);
      if (els.clipGainLabel) els.clipGainLabel.textContent = `${Math.round(v * 100)}%`;
    });
    els.clipGain.addEventListener("change", () => {
      const v = clampNumber(els.clipGain.value, 0, 2);
      commitClipField("gain", Number(v.toFixed(2)));
    });
  }

  // ── Audio inspector commits ──
  const findSelectedAudioClip = () => {
    if (!state.selectedAudioClipId) return null;
    const owner = findClipOwner(state.selectedAudioClipId);
    return owner && owner.track.kind === "audio" ? owner.clip : null;
  };
  const commitAField = (field, value) => {
    const a = findSelectedAudioClip();
    if (!a || a[field] === value) return;
    pushHistorySnapshot();
    a[field] = value;
    render();
    refreshExportEstimate();
  };
  if (els.audioTrimStart) {
    els.audioTrimStart.addEventListener("change", () => {
      const a = findSelectedAudioClip();
      if (!a) return;
      const next = clampNumber(els.audioTrimStart.value, 0, a.sourceDuration);
      commitAField("trimStart", roundMs(next));
    });
  }
  if (els.audioTrimEnd) {
    els.audioTrimEnd.addEventListener("change", () => {
      const a = findSelectedAudioClip();
      if (!a) return;
      const next = clampNumber(els.audioTrimEnd.value, a.trimStart + 0.001, a.sourceDuration);
      commitAField("trimEnd", roundMs(next));
    });
  }
  if (els.audioTimelineStart) {
    els.audioTimelineStart.addEventListener("change", () => {
      commitAField("timelineStart", roundMs(Math.max(0, Number(els.audioTimelineStart.value) || 0)));
    });
  }
  if (els.audioGain) {
    els.audioGain.addEventListener("input", () => {
      const v = clampNumber(els.audioGain.value, 0, 2);
      if (els.audioGainLabel) els.audioGainLabel.textContent = `${Math.round(v * 100)}%`;
    });
    els.audioGain.addEventListener("change", () => {
      const v = clampNumber(els.audioGain.value, 0, 2);
      commitAField("gain", Number(v.toFixed(2)));
    });
  }
  if (els.audioFadeIn) {
    els.audioFadeIn.addEventListener("change", () => {
      commitAField("fadeIn", Math.max(0, Number(els.audioFadeIn.value) || 0));
    });
  }
  if (els.audioFadeOut) {
    els.audioFadeOut.addEventListener("change", () => {
      commitAField("fadeOut", Math.max(0, Number(els.audioFadeOut.value) || 0));
    });
  }
  if (els.removeAudioClipButton) {
    els.removeAudioClipButton.addEventListener("click", () => {
      if (state.selectedAudioClipId) removeAudioClipById(state.selectedAudioClipId);
    });
  }

  // ── Subtitle inspector commits ──
  const findSelectedSubtitle = () => {
    if (!state.selectedSubtitleId) return null;
    for (const t of getSubtitleTracks()) {
      const c = t.clips.find((x) => x.id === state.selectedSubtitleId);
      if (c) return c;
    }
    return null;
  };
  const commitSub = (field, value) => {
    const c = findSelectedSubtitle();
    if (!c || c[field] === value) return;
    pushHistorySnapshot();
    c[field] = value;
    render();
  };
  if (els.subtitleCueText) {
    els.subtitleCueText.addEventListener("change", () => {
      commitSub("text", els.subtitleCueText.value || "");
    });
  }
  if (els.subtitleCueStart) {
    els.subtitleCueStart.addEventListener("change", () => {
      commitSub("timelineStart", roundMs(Math.max(0, Number(els.subtitleCueStart.value) || 0)));
    });
  }
  if (els.subtitleCueDuration) {
    els.subtitleCueDuration.addEventListener("change", () => {
      commitSub("duration", roundMs(Math.max(0.05, Number(els.subtitleCueDuration.value) || 0.05)));
    });
  }
  if (els.subtitleFontSize) {
    // Live preview while dragging the slider — no history snapshot per pixel.
    els.subtitleFontSize.addEventListener("input", () => {
      const v = Math.max(8, Math.min(96, Number(els.subtitleFontSize.value) || 18));
      state.subtitleFontPx = v;
      if (els.subtitleFontSizeLabel) els.subtitleFontSizeLabel.textContent = `${v} px`;
      _updateSubtitleOverlay();
    });
    // Persist the chosen size so it survives relaunches.
    els.subtitleFontSize.addEventListener("change", () => {
      try { localStorage.setItem("cutline.subtitleFontPx", String(state.subtitleFontPx)); } catch {}
    });
  }
  if (els.splitSubtitleAtPlayhead) {
    els.splitSubtitleAtPlayhead.addEventListener("click", () => {
      if (state.selectedSubtitleId) splitSubtitleAtPlayhead(state.selectedSubtitleId);
    });
  }
  if (els.removeSubtitleButton) {
    els.removeSubtitleButton.addEventListener("click", () => {
      if (state.selectedSubtitleId) removeSubtitleById(state.selectedSubtitleId);
    });
  }
}

function moveSelectedClip(direction) {
  // Move Up/Down operates on timeline order (sorted by timelineStart), not
  // the raw array. After the swap, clips snap edge-to-edge — gaps between the
  // moved clip and its neighbor are collapsed. Free-drag is the way to
  // preserve gaps; the Move buttons explicitly normalize the layout.
  // Operate within the selected clip's OWN V track so V2/V3 moves work too.
  const owner = state.selectedSequenceId ? findClipOwner(state.selectedSequenceId) : null;
  if (!owner || owner.track.kind !== "video") return;
  if (owner.track.locked) return;
  const segments = getVideoTrackSegments(owner.track);
  const myIdx = segments.findIndex((s) => s.clip.id === state.selectedSequenceId);
  if (myIdx === -1) return;
  const targetIdx = myIdx + direction;
  if (targetIdx < 0 || targetIdx >= segments.length) return;

  pushHistorySnapshot();
  // Build a new clip order (timeline-wise), swap, then reassign timelineStart
  // cumulatively so the moved clip and the rest stay edge-to-edge.
  const orderedClips = segments.map((s) => s.clip);
  [orderedClips[myIdx], orderedClips[targetIdx]] = [orderedClips[targetIdx], orderedClips[myIdx]];
  let cursor = 0;
  for (const c of orderedClips) {
    c.timelineStart = roundMs(cursor);
    cursor += Math.max(0, c.trimEnd - c.trimStart);
  }
  const relativeOffset = segments[myIdx] ? state.timelineCursor - segments[myIdx].start : 0;
  const nextSegment = getSequenceSegmentByClipId(state.selectedSequenceId);
  if (nextSegment) {
    const nextCursor = clampNumber(nextSegment.start + relativeOffset, nextSegment.start, nextSegment.end);
    previewAfterClipMutation(state.selectedSequenceId, nextCursor);
  }
  render();
  refreshExportEstimate();
}

function removeSequenceClipById(id) {
  if (state.exporting) return;
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  if (owner.track.locked) {
    setStatus("Locked", `轨道 ${owner.track.name} 已锁定，不能删除片段。`, 0);
    return;
  }
  const track = owner.track;
  const index = track.clips.findIndex((clip) => clip.id === id);
  if (index === -1) return;
  pushHistorySnapshot();
  const wasSelected = state.selectedSequenceId === id;
  track.clips.splice(index, 1);
  // Drop A-track clips linked to this V-clip across ALL audio tracks — splice
  // in place so the legacy `state.audioClips` alias stays valid.
  for (const t of getAudioTracks()) {
    for (let i = t.clips.length - 1; i >= 0; i--) {
      if (t.clips[i].parentVideoId === id) t.clips.splice(i, 1);
    }
  }

  if (wasSelected) {
    // Prefer the same track's neighbor; fall back to any remaining V clip so
    // the inspector doesn't go blank just because V1 happens to be empty.
    const inTrack = track.clips[index] || track.clips[index - 1];
    const fallback = inTrack || getVideoTracks().flatMap((t) => t.clips)[0] || null;
    state.selectedSequenceId = fallback?.id || null;
    state.timelineCursor = 0;

    if (fallback) {
      const segment = getSequenceSegmentByClipId(fallback.id);
      if (segment) previewAfterClipMutation(fallback.id, segment.start);
    } else if (selectedLibraryClip()) {
      previewLibraryClip(selectedLibraryClip());
    } else {
      state.previewContext = null;
      state.previewMode = "library";
      _clearActivePreview();
      els.previewTitle.textContent = "No clip selected";
      els.previewMeta.textContent = "Ready";
      els.previewHint.textContent = "Select a clip in the media bin or sequence to preview it here.";
    }
  } else {
    state.timelineCursor = clampNumber(state.timelineCursor, 0, getSequenceDuration());
  }

  render();
  refreshExportEstimate();
}

function removeSelectedClip() {
  if (!state.selectedSequenceId) return;
  removeSequenceClipById(state.selectedSequenceId);
}

// Select every clip on V1 (the primary editable lane). The first one becomes
// the "primary" selection; the rest go into multiSelectIds for bulk delete.
function selectAllSequenceClips() {
  const v1 = getVideoTracks()[0];
  if (!v1 || v1.clips.length === 0) return;
  state.selectedSequenceId = v1.clips[0].id;
  state.multiSelectIds = v1.clips.slice(1).map((c) => c.id);
  state.selectedAudioClipId = null;
  render();
}

// Duplicate the currently selected V clip on its own track, placed right
// after the original (Ctrl+D). Pure data clone — no proxy regen needed.
function duplicateSelectedClip() {
  if (state.exporting || !state.selectedSequenceId) return;
  const owner = findClipOwner(state.selectedSequenceId);
  if (!owner || owner.track.kind !== "video" || owner.track.locked) return;
  const src = owner.clip;
  pushHistorySnapshot();
  const dur = Math.max(0, src.trimEnd - src.trimStart);
  const dup = {
    ...src,
    id: createId("seq"),
    timelineStart: roundMs((Number(src.timelineStart) || 0) + dur),
  };
  const idx = owner.track.clips.findIndex((c) => c.id === src.id);
  owner.track.clips.splice(idx + 1, 0, dup);
  state.selectedSequenceId = dup.id;
  render();
  refreshExportEstimate();
  setStatus("Duplicated", `Created a copy of "${src.name}".`, null);
}

// Ripple delete on V1: remove the selected clip and shift every subsequent
// V1 clip left by the deleted clip's duration so the timeline closes the gap.
// V2/V3 clips and audio clips are left alone (they have explicit timeline
// positions independent of V1 sequencing).
function rippleDeleteSelectedSequenceClip() {
  if (state.exporting || !state.selectedSequenceId) return;
  const owner = findClipOwner(state.selectedSequenceId);
  if (!owner || owner.track.kind !== "video" || owner.track.locked) return;
  const track = owner.track;
  const idx = track.clips.findIndex((c) => c.id === state.selectedSequenceId);
  if (idx === -1) return;
  pushHistorySnapshot();
  const deletedDur = Math.max(0, owner.clip.trimEnd - owner.clip.trimStart);
  const deletedStart = Number(owner.clip.timelineStart) || 0;
  // Pull every later clip on the same track left by deletedDur. Sort by start
  // first so the shift order is stable.
  track.clips.splice(idx, 1);
  for (const c of track.clips) {
    if ((Number(c.timelineStart) || 0) > deletedStart - 0.001) {
      c.timelineStart = roundMs(Math.max(0, (Number(c.timelineStart) || 0) - deletedDur));
    }
  }
  // Drop A-track clips that were detached from this V clip.
  for (const t of getAudioTracks()) {
    for (let i = t.clips.length - 1; i >= 0; i--) {
      if (t.clips[i].parentVideoId === owner.clip.id) t.clips.splice(i, 1);
    }
  }
  state.selectedSequenceId = track.clips[idx]?.id || track.clips[idx - 1]?.id || null;
  state.timelineCursor = clampNumber(state.timelineCursor, 0, getSequenceDuration());
  render();
  refreshExportEstimate();
  setStatus("Ripple Deleted", `Removed clip and closed the gap (${formatPrecise(deletedDur)}).`, null);
}

// Set trim-in to the current playhead position within the selected clip.
function markInAtPlayhead() {
  const clip = selectedSequenceClip();
  const playhead = getSelectedClipPlayhead();
  if (!clip || playhead === null) return;
  if (playhead >= clip.trimEnd - 0.05) {
    setStatus("Mark In", "Playhead is past Trim Out — move it earlier first.", null);
    return;
  }
  pushHistorySnapshot();
  clip.trimStart = roundMs(playhead);
  render();
  refreshExportEstimate();
  setStatus("Mark In", `Trim In set to ${formatTimecode(clip.trimStart)}.`, null);
}

// Set trim-out to the current playhead position within the selected clip.
function markOutAtPlayhead() {
  const clip = selectedSequenceClip();
  const playhead = getSelectedClipPlayhead();
  if (!clip || playhead === null) return;
  if (playhead <= clip.trimStart + 0.05) {
    setStatus("Mark Out", "Playhead is before Trim In — move it later first.", null);
    return;
  }
  pushHistorySnapshot();
  clip.trimEnd = roundMs(playhead);
  render();
  refreshExportEstimate();
  setStatus("Mark Out", `Trim Out set to ${formatTimecode(clip.trimEnd)}.`, null);
}

// Unified clipboard. `kind` tells the paste handler whether to materialize a
// V-clip (with parentTrackKind="video") or A-clip (kind="audio"). Mixed-kind
// pasting is allowed — see resolvePasteTargetTrack() for the routing rule.
function copySequenceClipToClipboard(id) {
  // Search every V track so Ctrl+C / right-click-copy works for V2/V3 clips.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  const clip = owner.clip;
  _clipClipboard = {
    kind: "video",
    mediaId: clip.mediaId,
    path: clip.path,
    name: clip.name,
    sourceDuration: clip.sourceDuration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    hasAudio: clip.hasAudio,
    hasVideo: clip.hasVideo,
    audioMuted: clip.audioMuted,
  };
  setStatus("Copied", `Copied "${clip.name}" to clipboard.`, null);
}

function cutSequenceClip(id) {
  copySequenceClipToClipboard(id);
  removeSequenceClipById(id);
}

function copyAudioClipToClipboard(id) {
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "audio") return;
  const clip = owner.clip;
  _clipClipboard = {
    kind: "audio",
    mediaId: clip.mediaId,
    path: clip.path,
    name: clip.name,
    sourceDuration: clip.sourceDuration,
    trimStart: clip.trimStart,
    trimEnd: clip.trimEnd,
    hasAudio: true,
  };
  setStatus("Copied", `Copied audio clip "${clip.name}" to clipboard.`, null);
}

function cutAudioClip(id) {
  copyAudioClipToClipboard(id);
  removeAudioClipById(id);
}

// Pick the track that should receive a paste. Rules (剪映-style):
// 1. If the user explicitly selected a track via the track header and that
//    track's kind matches the clipboard, paste there.
// 2. Otherwise paste onto the track of the currently selected clip (V → V1,
//    A → the A track that hosts the selected A clip).
// 3. Fall back to the first track of the matching kind.
function resolvePasteTargetTrack(kind) {
  if (state.selectedTrackId) {
    const t = getTrackById(state.selectedTrackId);
    if (t && t.kind === kind && !t.locked) return t;
  }
  if (kind === "video") {
    if (state.selectedSequenceId) {
      const owner = findClipOwner(state.selectedSequenceId);
      if (owner && owner.track.kind === "video" && !owner.track.locked) return owner.track;
    }
    return getVideoTracks().find((t) => !t.locked) || null;
  }
  if (kind === "audio") {
    if (state.selectedAudioClipId) {
      const owner = findClipOwner(state.selectedAudioClipId);
      if (owner && owner.track.kind === "audio" && !owner.track.locked) return owner.track;
    }
    return getAudioTracks().find((t) => !t.locked) || null;
  }
  return null;
}

function pasteSequenceClipFromClipboard() {
  if (!_clipClipboard || state.exporting) return;

  // Audio-kind clipboard onto an A track.
  if (_clipClipboard.kind === "audio") {
    const target = resolvePasteTargetTrack("audio");
    if (!target) {
      setStatus("Paste failed", "没有可用的音频轨道（可能都被锁了）。", 0);
      return;
    }
    pushHistorySnapshot();
    const dur = Math.max(0, _clipClipboard.trimEnd - _clipClipboard.trimStart);
    // Drop at the playhead by default; clamp to ≥ 0.
    const start = roundMs(Math.max(0, state.timelineCursor));
    const next = {
      id: createId("a"),
      mediaId: _clipClipboard.mediaId,
      path: _clipClipboard.path,
      name: _clipClipboard.name,
      sourceDuration: _clipClipboard.sourceDuration,
      trimStart: _clipClipboard.trimStart,
      trimEnd: _clipClipboard.trimEnd,
      timelineStart: start,
      hasAudio: true,
      audioMuted: false,
      parentVideoId: null,
      gain: 1,
    };
    target.clips.push(next);
    state.selectedAudioClipId = next.id;
    state.selectedSequenceId = null;
    render();
    refreshExportEstimate();
    setStatus("Pasted", `Pasted "${next.name}" → ${target.name} @ ${formatTimecode(start)}.`, null);
    return;
  }

  // Video-kind clipboard onto a V track.
  const target = resolvePasteTargetTrack("video");
  if (!target) {
    setStatus("Paste failed", "没有可用的视频轨道（可能都被锁了）。", 0);
    return;
  }
  pushHistorySnapshot();
  const next = {
    id: createId("seq"),
    mediaId: _clipClipboard.mediaId,
    path: _clipClipboard.path,
    name: _clipClipboard.name,
    sourceDuration: _clipClipboard.sourceDuration,
    trimStart: _clipClipboard.trimStart,
    trimEnd: _clipClipboard.trimEnd,
    hasAudio: _clipClipboard.hasAudio,
    hasVideo: _clipClipboard.hasVideo,
    audioMuted: Boolean(_clipClipboard.audioMuted),
    timelineStart: 0,
  };
  // Position the new V clip: if target is V1, append at the V1 end (legacy
  // edge-to-edge behavior). For V2+, drop it at the playhead.
  if (target === getVideoTracks()[0]) {
    let cursor = 0;
    for (const c of target.clips) {
      const end = (Number(c.timelineStart) || 0) + Math.max(0, c.trimEnd - c.trimStart);
      if (end > cursor) cursor = end;
    }
    next.timelineStart = roundMs(cursor);
  } else {
    next.timelineStart = roundMs(Math.max(0, state.timelineCursor));
  }
  target.clips.push(next);
  // Keep state.sequence alias pointing at V1 (which it does by construction).
  state.sequence = (state.tracks.find((t) => t.kind === "video") || { clips: [] }).clips;
  state.selectedSequenceId = next.id;
  const lib = getLibraryClipById(next.mediaId);
  if (lib) warmUpPoolForClip(lib);
  const segment = getSequenceSegmentByClipId(next.id);
  if (segment) previewAfterClipMutation(next.id, segment.start);
  render();
  refreshExportEstimate();
  setStatus("Pasted", `Pasted "${next.name}" → ${target.name} @ ${formatTimecode(next.timelineStart)}.`, null);
}

async function exportSingleSequenceClip(id) {
  if (state.exporting) return;
  // Search every V track so right-click → export works on V2/V3 clips.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  const clip = owner.clip;
  const baseName = clip.name.replace(/\.[^.]+$/, "");
  const suggested = `cutline-${baseName}-${Date.now()}.mp4`;
  const outputPath = await window.editorAPI.saveExport(suggested);
  if (!outputPath) return;

  state.exporting = true;
  renderOutputPath();
  setStatus("Rendering", `Exporting "${clip.name}"…`, 2);
  try {
    const result = await window.editorAPI.exportProject({
      clips: [sequenceClipToExportClip(clip)],
      outputPath,
      settings: getExportSettings(),
    });
    els.estimatedSize.textContent = result.outputSizeLabel || humanFileSize(result.outputSizeBytes || 0);
    els.estimatedRenderTime.textContent = "Completed";
    const completedPipelineLabel = result.pipelineLabel || result.encoderLabel;
    els.renderCapability.textContent = completedPipelineLabel || els.renderCapability.textContent;
    setStatus(
      "Finished",
      `Exported "${clip.name}" to ${result.outputPath}. Final size ${result.outputSizeLabel}.`,
      100,
    );
  } catch (error) {
    setStatus("Export Failed", error.message || "Single-clip export did not complete.", 0);
  } finally {
    state.exporting = false;
    renderOutputPath();
    refreshExportEstimate();
  }
}

async function exportSingleSequenceClipAudio(id) {
  if (state.exporting) return;
  // Search every V track so right-click → export-audio works on V2/V3 clips.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  const clip = owner.clip;
  if (!clip.hasAudio) return;
  const audioSettings = getAudioExportSettings();
  const baseName = clip.name.replace(/\.[^.]+$/, "");
  const suggested = `cutline-${baseName}-audio-${Date.now()}.${audioSettings.audioFormat}`;
  const outputPath = await window.editorAPI.saveAudioExport(suggested, audioSettings.audioFormat);
  if (!outputPath) return;

  state.exporting = true;
  renderOutputPath();
  setStatus(
    "Rendering",
    `Exporting audio of "${clip.name}" to ${audioSettings.audioFormat.toUpperCase()}…`,
    2,
  );
  try {
    const result = await window.editorAPI.exportProjectAudio({
      clips: [sequenceClipToExportClip(clip)],
      outputPath,
      audioFormat: audioSettings.audioFormat,
      audioBitrate: audioSettings.audioBitrate,
    });
    els.estimatedSize.textContent = result.outputSizeLabel || humanFileSize(result.outputSizeBytes || 0);
    els.estimatedRenderTime.textContent = "Completed";
    els.renderCapability.textContent = result.pipelineLabel || els.renderCapability.textContent;
    setStatus(
      "Finished",
      `Exported audio of "${clip.name}" to ${result.outputPath}. Final size ${result.outputSizeLabel}.`,
      100,
    );
  } catch (error) {
    setStatus("Audio Export Failed", error.message || "The clip audio export did not complete.", 0);
  } finally {
    state.exporting = false;
    renderOutputPath();
    refreshExportEstimate();
  }
}

function revealClipFileInFolder(id) {
  // Search every V track so "Reveal in folder" works on V2/V3 clips too.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  window.editorAPI.revealInFolder(owner.clip.path).catch(() => null);
}

function toggleSequenceClipAudioMute(id) {
  if (state.exporting) return;
  // Search every V track so "Detach / restore audio" works on V2/V3 clips.
  const owner = findClipOwner(id);
  if (!owner || owner.track.kind !== "video") return;
  const clip = owner.clip;
  if (!clip.hasAudio) return;
  pushHistorySnapshot();

  if (!clip.audioMuted) {
    // Detach: mark V-clip silent + create an A-track clip aligned to the
    // current segment position so the user can move/trim/delete it on its own.
    const segment = getSequenceSegmentByClipId(clip.id);
    const timelineStart = segment ? segment.start : 0;
    clip.audioMuted = true;
    state.audioClips.push({
      id: createId("a"),
      mediaId: clip.mediaId,
      path: clip.path,
      name: clip.name,
      sourceDuration: clip.sourceDuration,
      trimStart: clip.trimStart,
      trimEnd: clip.trimEnd,
      timelineStart,
      hasAudio: true,
      audioMuted: false,
      parentVideoId: clip.id,
      gain: 1,
    });
  } else {
    // Restore: drop any A-track clip linked to this V-clip across ALL audio
    // tracks (not just A1) and un-mute the video. We splice in place to keep
    // the alias `state.audioClips === firstAudioTrack.clips` intact.
    for (const t of getAudioTracks()) {
      for (let i = t.clips.length - 1; i >= 0; i--) {
        if (t.clips[i].parentVideoId === clip.id) t.clips.splice(i, 1);
      }
    }
    clip.audioMuted = false;
  }

  // Reflect mute immediately on the active preview <video> if it's this clip.
  if (_activeVideoEl && state.previewContext?.sequenceId === clip.id) {
    _activeVideoEl.muted = clip.audioMuted;
  }
  render();
  refreshExportEstimate();
}

function removeAudioClipById(id) {
  if (state.exporting) return;
  // Search every audio track — the clip may live on A2/A3/... not just A1.
  let removed = null;
  for (const t of getAudioTracks()) {
    const idx = t.clips.findIndex((c) => c.id === id);
    if (idx !== -1) {
      if (t.locked) {
        setStatus("Locked", `轨道 ${t.name} 已锁定，不能删除片段。`, 0);
        return;
      }
      pushHistorySnapshot();
      removed = t.clips[idx];
      t.clips.splice(idx, 1);
      break;
    }
  }
  if (!removed) return;
  // If this A-clip was the detached audio of a V-clip, restore the V-clip's
  // internal audio so the user isn't left with silence. The parent may live
  // on V2/V3, so search every V track instead of just state.sequence (V1).
  if (removed.parentVideoId) {
    const parent = findClipOwner(removed.parentVideoId);
    if (parent && parent.track.kind === "video") parent.clip.audioMuted = false;
  }
  if (state.selectedAudioClipId === id) state.selectedAudioClipId = null;
  render();
  refreshExportEstimate();
}

function removeLibraryClip(id) {
  // Remove from library
  const libIndex = state.library.findIndex((clip) => clip.id === id);
  if (libIndex === -1) return;
  state.library.splice(libIndex, 1);

  // Also remove any sequence clips that reference this media — across EVERY
  // V track (V2/V3), and across audio tracks too. Splice in place: reassigning
  // `state.sequence = state.sequence.filter(...)` would detach the alias from
  // tracks[0].clips and silently desync the rest of the app.
  for (const t of getVideoTracks()) {
    for (let i = t.clips.length - 1; i >= 0; i--) {
      if (t.clips[i].mediaId === id) t.clips.splice(i, 1);
    }
  }
  for (const t of getAudioTracks()) {
    for (let i = t.clips.length - 1; i >= 0; i--) {
      if (t.clips[i].mediaId === id) t.clips.splice(i, 1);
    }
  }

  // Clear stale selections that point to removed clips
  if (state.selectedLibraryId === id) {
    state.selectedLibraryId = state.library[0]?.id || null;
  }
  if (state.selectedSequenceId && !findClipOwner(state.selectedSequenceId)) {
    const remaining = getVideoTracks().flatMap((t) => t.clips)[0];
    state.selectedSequenceId = remaining?.id || null;
  }
  if (state.selectedAudioClipId && !findClipOwner(state.selectedAudioClipId)) {
    state.selectedAudioClipId = null;
  }
  if (getVideoTracks().every((t) => t.clips.length === 0)) {
    state.timelineCursor = 0;
  }

  // Reset the preview when it was showing the removed media (directly or via a deleted timeline clip)
  const previewStale = state.previewContext?.mediaId === id ||
                       (state.previewMode === "timeline" && state.sequence.length === 0);
  if (previewStale) {
    const libClip = state.selectedLibraryId ? getLibraryClipById(state.selectedLibraryId) : null;
    if (libClip) {
      previewLibraryClip(libClip);
    } else {
      state.previewContext = null;
      state.previewMode = "library";
      _clearActivePreview();
      els.previewTitle.textContent = "No clip selected";
      els.previewMeta.textContent = "Ready";
      els.previewHint.textContent = "Select a clip in the media bin or sequence to preview it here.";
    }
  }

  render();
  refreshExportEstimate();
}

function splitSelectedClipAtPlayhead() {
  const clip = selectedSequenceClip();
  const playhead = getSelectedClipPlayhead();
  if (!clip || playhead === null) return;
  const owner = findClipOwner(clip.id);
  if (owner?.track.locked) {
    setStatus("Locked", `轨道 ${owner.track.name} 已锁定，不能拆分。`, 0);
    return;
  }

  const splitPoint = roundMs(playhead);
  if (splitPoint <= clip.trimStart + 0.001 || splitPoint >= clip.trimEnd - 0.001) {
    setStatus("Split Skipped", "Move the playhead inside the clip before splitting.", 0);
    return;
  }

  pushHistorySnapshot();
  // Operate inside the clip's own V track so a V2/V3 split keeps the second
  // half on V2/V3 instead of dumping it into V1.
  const track = owner.track;
  const index = track.clips.findIndex((item) => item.id === clip.id);
  // Second half starts where the first half now ends (timeline-wise), so the
  // two stay edge-to-edge on the same V track with no visual gap.
  const firstHalfDuration = roundMs(splitPoint - clip.trimStart);
  const baseStart = Number(clip.timelineStart) || 0;
  const secondHalf = {
    ...clip,
    id: createId("seq"),
    trimStart: splitPoint,
    timelineStart: roundMs(baseStart + firstHalfDuration),
  };

  clip.trimEnd = splitPoint;
  track.clips.splice(index + 1, 0, secondHalf);
  state.selectedSequenceId = secondHalf.id;
  const segment = getSequenceSegmentByClipId(secondHalf.id);
  if (segment) previewAfterClipMutation(secondHalf.id, segment.start);
  render();
  refreshExportEstimate();
  setStatus("Split Complete", `Created two timeline clips at ${formatTimecode(splitPoint)}.`, 0);
}

async function chooseExportFolder() {
  const current = els.exportFolderPath?.value || "";
  const picked = await window.editorAPI.pickDirectory(current);
  if (!picked) return null;
  if (els.exportFolderPath) els.exportFolderPath.value = picked;
  state.outputPath = picked;
  try { localStorage.setItem("cutline.lastExportFolder", picked); } catch {}
  updateExportModalSummary();
  return picked;
}

// "/" separator works on every Electron platform when used in JS paths;
// the OS normalizes. We keep this client-side only — ffmpeg accepts both.
function _joinPath(folder, file) {
  if (!folder) return file;
  return folder.replace(/[\/\\]+$/, "") + "/" + file;
}

function _sanitizeFilenameSegment(name) {
  // Strip characters illegal on Windows / macOS / Linux. Falls back to a
  // timestamp-style default if the user emptied the title field.
  const cleaned = String(name || "").replace(/[\\/:*?"<>|]+/g, "").trim();
  return cleaned || `cutline-export-${Date.now()}`;
}

function getModalExportTargets() {
  const folder = els.exportFolderPath?.value || "";
  const title = _sanitizeFilenameSegment(els.exportTitle?.value || "");
  const audioFormat = els.audioFormat?.value || "m4a";
  return {
    folder,
    title,
    videoPath: folder ? _joinPath(folder, `${title}.mp4`) : null,
    audioPath: folder ? _joinPath(folder, `${title}.${audioFormat}`) : null,
  };
}

function updateExportModalSummary() {
  // Highlight the title chip in the header so the user can confirm what's being exported.
  if (els.exportModalTitleLabel) {
    const t = els.exportTitle?.value?.trim();
    els.exportModalTitleLabel.textContent = t ? `· ${t}` : "";
  }
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
      clips: serializeVideoTrackForExport(),
      audioClips: serializeAudioTrack(),
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

async function runVideoExportTo(outputPath) {
  setStatus("Rendering", "FFmpeg is combining your timeline into one MP4.", 2);
  const result = await window.editorAPI.exportProject({
    clips: serializeVideoTrackForExport(),
    audioClips: serializeAudioTrack(),
    outputPath,
    settings: getExportSettings(),
  });
  if (els.estimatedSize) els.estimatedSize.textContent = result.outputSizeLabel || humanFileSize(result.outputSizeBytes || 0);
  if (els.estimatedRenderTime) els.estimatedRenderTime.textContent = "Completed";
  const completedPipelineLabel = result.pipelineLabel || result.encoderLabel;
  if (completedPipelineLabel) els.renderCapability.textContent = completedPipelineLabel;
  return result;
}

async function runAudioExportTo(outputPath, audioSettings) {
  setStatus(
    "Rendering",
    `FFmpeg is exporting the audio track to ${audioSettings.audioFormat.toUpperCase()}.`,
    2,
  );
  const result = await window.editorAPI.exportProjectAudio({
    clips: serializeVideoTrackForExport(),
    audioClips: serializeAudioTrack(),
    outputPath,
    audioFormat: audioSettings.audioFormat,
    audioBitrate: audioSettings.audioBitrate,
    sampleRate: audioSettings.sampleRate,
  });
  return result;
}

// Drives the unified video + audio export from the modal's checkbox state.
async function runExportFromModal() {
  if (state.exporting || state.sequence.length === 0) return;
  const wantVideo = !!els.enableVideoExport?.checked;
  const wantAudio = !!els.enableAudioExport?.checked;
  if (!wantVideo && !wantAudio) {
    setStatus("Nothing to export", "勾选「视频导出」或「音频导出」其中至少一个。", 0);
    return;
  }
  const targets = getModalExportTargets();
  if (!targets.folder) {
    setStatus("Choose folder", "请先选择导出文件夹 (导出至)。", 0);
    return;
  }

  closeExportModal();
  state.exporting = true;
  renderOutputPath();

  const audioSettings = getAudioExportSettings();
  const finishedPaths = [];
  try {
    if (wantVideo) {
      const result = await runVideoExportTo(targets.videoPath);
      finishedPaths.push({ kind: "video", path: result.outputPath, sizeLabel: result.outputSizeLabel });
    }
    if (wantAudio) {
      const result = await runAudioExportTo(targets.audioPath, audioSettings);
      finishedPaths.push({ kind: "audio", path: result.outputPath, sizeLabel: result.outputSizeLabel });
      if (els.estimatedSize) els.estimatedSize.textContent = result.outputSizeLabel || humanFileSize(result.outputSizeBytes || 0);
    }
    const summary = finishedPaths
      .map((f) => `${f.kind === "video" ? "视频" : "音频"} → ${f.path} (${f.sizeLabel})`)
      .join("  |  ");
    setStatus("Finished", `导出完成: ${summary}`, 100);
    // Native OS notification — click reveals the first finished file in
    // its folder. Quiet failures (notifications disabled) are non-fatal.
    if (finishedPaths.length > 0) {
      const primary = finishedPaths[0];
      const body = finishedPaths.length === 1
        ? `${primary.kind === "video" ? "视频" : "音频"} 导出完成 (${primary.sizeLabel})`
        : `${finishedPaths.length} 个文件导出完成`;
      window.editorAPI.notifyExportDone({
        title: "Cutline Studio · 导出完成",
        body,
        outputPath: primary.path,
      }).catch(() => null);
    }
  } catch (error) {
    setStatus("Export Failed", error.message || "The export did not complete.", 0);
    window.editorAPI.notifyExportDone({
      title: "Cutline Studio · 导出失败",
      body: error.message || "The export did not complete.",
    }).catch(() => null);
  } finally {
    state.exporting = false;
    renderOutputPath();
    refreshExportEstimate();
  }
}

function openExportModal() {
  if (state.sequence.length === 0) {
    setStatus("Timeline empty", "请先添加片段到时间线再导出。", 0);
    return;
  }
  populateExportModal();
  if (els.exportModal) {
    els.exportModal.classList.remove("hidden");
    els.exportModal.setAttribute("aria-hidden", "false");
  }
  // Focus the title for quick edit.
  setTimeout(() => els.exportTitle?.focus(), 30);
}

function closeExportModal() {
  if (els.exportModal) {
    els.exportModal.classList.add("hidden");
    els.exportModal.setAttribute("aria-hidden", "true");
  }
}

function populateExportModal() {
  // Suggested title: timeline name / first clip name / timestamp fallback.
  if (els.exportTitle && !els.exportTitle.value) {
    const firstClip = state.sequence[0];
    const base = firstClip ? firstClip.name.replace(/\.[^.]+$/, "") : `cutline-${Date.now()}`;
    els.exportTitle.value = base;
  }
  // Restore last folder if user hasn't picked one yet this session.
  if (els.exportFolderPath && !els.exportFolderPath.value) {
    try {
      const last = localStorage.getItem("cutline.lastExportFolder");
      if (last) els.exportFolderPath.value = last;
    } catch {}
  }
  // Restore last-used export preset if any.
  if (els.exportPreset) {
    try {
      const lastPreset = localStorage.getItem("cutline.lastExportPreset");
      if (lastPreset && EXPORT_PRESETS[lastPreset]) {
        els.exportPreset.value = lastPreset;
      }
    } catch {}
  }
  refreshExportEstimate();
  updateExportModalSummary();
  updateExportModalSectionStates();
}

// One-shot apply for the export-modal preset selector. Each preset sets
// aspect / resolution / fps / codec / bitrate so users can hit the most
// common targets without poking 6 dropdowns.
const EXPORT_PRESETS = {
  "douyin-1080": { aspect: "9:16", res: "1920x1080", fps: 30, codec: "h264", bitrate: "12000k" },
  "douyin-720":  { aspect: "9:16", res: "1280x720",  fps: 30, codec: "h264", bitrate: "auto" },
  "xigua-1080":  { aspect: "16:9", res: "1920x1080", fps: 30, codec: "h264", bitrate: "12000k" },
  "youtube-1080":{ aspect: "16:9", res: "1920x1080", fps: 30, codec: "h264", bitrate: "12000k" },
  "youtube-4k":  { aspect: "16:9", res: "3840x2160", fps: 30, codec: "hevc", bitrate: "35000k" },
  "bilibili-1080":{ aspect: "16:9", res: "1920x1080", fps: 30, codec: "h264", bitrate: "auto" },
  "square-1080": { aspect: "1:1",  res: "1920x1080", fps: 30, codec: "h264", bitrate: "auto" },
};

function applyExportPreset(presetKey) {
  const p = EXPORT_PRESETS[presetKey];
  if (!p) return;
  if (els.aspectPreset) els.aspectPreset.value = p.aspect;
  if (els.resolutionPreset) els.resolutionPreset.value = p.res;
  if (els.fps) els.fps.value = String(p.fps);
  if (els.videoCodec) els.videoCodec.value = p.codec;
  if (els.videoBitrate) els.videoBitrate.value = p.bitrate;
  syncAspectControls();
  refreshExportEstimate();
  try { localStorage.setItem("cutline.lastExportPreset", presetKey); } catch {}
}

function updateExportModalSectionStates() {
  const videoBody = document.getElementById("videoExportBody");
  const audioBody = document.getElementById("audioExportBody");
  const videoSection = videoBody?.closest(".modal-section");
  const audioSection = audioBody?.closest(".modal-section");
  if (videoSection) videoSection.classList.toggle("disabled", !els.enableVideoExport?.checked);
  if (audioSection) audioSection.classList.toggle("disabled", !els.enableAudioExport?.checked);
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
    // Playback is V1-anchored — if the user has a V2/V3 clip selected we'd
    // otherwise feed previewTimelineAt a time that isn't on V1, which would
    // bail out silently and leave the play button doing nothing.
    const owner = state.selectedSequenceId ? findClipOwner(state.selectedSequenceId) : null;
    const segment = (owner && owner.track === getVideoTracks()[0])
      ? getSequenceSegmentByClipId(state.selectedSequenceId)
      : getSequenceSegments()[0];
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
  // Handlers are registered into _POOL_EVENT_HANDLERS so they're attached to
  // every pool video — both the initial one and any added later. Each handler
  // ignores events from videos that aren't currently active (paused stragglers
  // in the pool would otherwise fire spurious 'pause' notifications).
  _POOL_EVENT_HANDLERS.play = function () {
    if (this !== _activeVideoEl) return;
    if (state.previewMode === "timeline") startPlaybackMonitor();
    renderTimelineTransport();
  };
  _POOL_EVENT_HANDLERS.pause = function () {
    if (this !== _activeVideoEl) return;
    stopPlaybackMonitor();
    renderTimelineTransport();
  };
  _POOL_EVENT_HANDLERS.ended = function () {
    if (this !== _activeVideoEl) return;
    stopPlaybackMonitor();
    renderTimelineTransport();
  };
  _POOL_EVENT_HANDLERS.error = async function () {
    if (this !== _activeVideoEl) return;
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
        previewLibraryClip(mediaClip);
      }
    } catch (error) {
      els.previewHint.textContent = "Preview could not be prepared for this clip, but export still works.";
      setStatus("Preview Failed", error.message || "Could not prepare a preview copy.", 0);
    }
  };

  // Make sure the elements that already exist (just the initial one at this
  // point) get the handlers, and so does every pool video created later.
  _attachPoolHandlers(_initialVideo);
  for (const entry of _videoPool.values()) {
    _attachPoolHandlers(entry.video);
  }
}

function wireKeyboardShortcuts() {
  window.addEventListener("keydown", (e) => {
    // Don't hijack typing inside form fields / inputs.
    const target = e.target;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
    const key = e.key?.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (key === "a") {
        // Select all V clips on V1 (the main editable lane).
        e.preventDefault();
        selectAllSequenceClips();
        return;
      }
      if (key === "c") {
        if (state.selectedAudioClipId) {
          e.preventDefault();
          copyAudioClipToClipboard(state.selectedAudioClipId);
        } else if (state.selectedSequenceId) {
          e.preventDefault();
          copySequenceClipToClipboard(state.selectedSequenceId);
        }
        return;
      }
      if (key === "x") {
        if (state.selectedAudioClipId) {
          e.preventDefault();
          cutAudioClip(state.selectedAudioClipId);
        } else if (state.selectedSequenceId) {
          e.preventDefault();
          cutSequenceClip(state.selectedSequenceId);
        }
        return;
      }
      if (key === "v") {
        if (_clipClipboard) {
          e.preventDefault();
          pasteSequenceClipFromClipboard();
        }
        return;
      }
      if (key === "d") {
        // Duplicate selected clip in place (next to original).
        e.preventDefault();
        duplicateSelectedClip();
        return;
      }
      if (key === "s") {
        // Ctrl+S = save project.
        e.preventDefault();
        if (e.shiftKey) saveProjectAs();
        else saveProject();
        return;
      }
      if (key === "o") {
        // Ctrl+O = open project.
        e.preventDefault();
        openProjectFromDisk();
        return;
      }
      // Ctrl+0 = reset timeline zoom to fit-to-width (industry standard).
      if (key === "0") {
        e.preventDefault();
        if (state.timelineZoom !== 1 || state.timelineScrollLeft !== 0) {
          state.timelineZoom = 1;
          state.timelineScrollLeft = 0;
          render();
        }
        return;
      }
      return;
    }
    if (key === "delete" || key === "backspace") {
      // Shift+Del / Shift+Backspace = ripple delete (close gap on V1).
      if (e.shiftKey && state.selectedSequenceId) {
        e.preventDefault();
        rippleDeleteSelectedSequenceClip();
        return;
      }
      // Bulk delete every multi-selected clip + the primary.
      if ((state.multiSelectIds || []).length > 0 && state.selectedSequenceId) {
        e.preventDefault();
        const ids = [state.selectedSequenceId, ...state.multiSelectIds];
        state.multiSelectIds = [];
        for (const id of ids) removeSequenceClipById(id);
        return;
      }
      if (state.selectedSubtitleId) {
        e.preventDefault();
        removeSubtitleById(state.selectedSubtitleId);
        return;
      }
      if (state.selectedAudioClipId) {
        e.preventDefault();
        removeAudioClipById(state.selectedAudioClipId);
      } else if (state.selectedSequenceId) {
        e.preventDefault();
        removeSequenceClipById(state.selectedSequenceId);
      }
      return;
    }
    // Spacebar = play / pause timeline (industry standard).
    if (e.code === "Space") {
      e.preventDefault();
      toggleTimelinePlayback();
      return;
    }
    // Single-frame stepping with arrow keys; Shift+arrow = 10 frames.
    if (key === "arrowleft" || key === "arrowright") {
      e.preventDefault();
      const fps = Math.max(1, Number(els.fps?.value) || 30);
      const step = (e.shiftKey ? 10 : 1) / fps;
      const direction = key === "arrowright" ? 1 : -1;
      const total = getSequenceDuration();
      const next = clampNumber(state.timelineCursor + step * direction, 0, total);
      if (state.sequence.length > 0) {
        previewTimelineAt(next, { autoplay: false, forceReload: false });
      }
      return;
    }
    // I / O = mark in / mark out at current playhead for the selected clip.
    if (key === "i") {
      e.preventDefault();
      markInAtPlayhead();
      return;
    }
    if (key === "o") {
      e.preventDefault();
      markOutAtPlayhead();
      return;
    }
    // S = toggle snapping (剪映 default key).
    if (key === "s") {
      e.preventDefault();
      state.snapEnabled = !state.snapEnabled;
      setStatus(state.snapEnabled ? "Snap ON" : "Snap OFF",
        state.snapEnabled ? "Drag edges will snap to neighboring clips and the playhead." : "Snapping disabled — drag freely.", null);
      render();
      return;
    }
    // JKL transport (industry standard). K pauses; J/L reverse/forward
    // (we don't have true reverse playback so J behaves like a 1x rewind step).
    if (key === "k") {
      e.preventDefault();
      if (!els.previewPlayer.paused) els.previewPlayer.pause();
      return;
    }
    if (key === "l") {
      e.preventDefault();
      _jklStep(1);
      return;
    }
    if (key === "j") {
      e.preventDefault();
      _jklStep(-1);
      return;
    }
    // + / - = zoom in / out the timeline (剪映 standard). Accepts the
    // shifted variant "=" too so users on the main row don't need shift.
    if (key === "+" || key === "=" || key === "-" || key === "_") {
      e.preventDefault();
      _bumpTimelineZoom(key === "+" || key === "=" ? 1.6 : 1 / 1.6);
      return;
    }
    // Home / End = jump to first / last frame.
    if (key === "home") {
      e.preventDefault();
      if (state.sequence.length > 0) previewTimelineAt(0, { forceReload: true });
      return;
    }
    if (key === "end") {
      e.preventDefault();
      if (state.sequence.length > 0) previewTimelineAt(getSequenceDuration(), { forceReload: true });
      return;
    }
  });
}

// JKL: tap L repeatedly to accelerate forward playback (1x → 2x → 4x);
// tap J repeatedly to "rewind" (we don't have true reverse decoding, so each
// J press jumps the playhead back by 1 second).
let _jklRate = 1;
let _jklTimer = 0;
function _jklStep(direction) {
  if (direction > 0) {
    if (els.previewPlayer.paused || (els.previewPlayer.playbackRate || 1) < 1) {
      _jklRate = 1;
    } else {
      _jklRate = Math.min(8, _jklRate * 2);
    }
    els.previewPlayer.playbackRate = _jklRate;
    if (els.previewPlayer.paused) {
      toggleTimelinePlayback();
    }
    setStatus("Playback", `Forward ${_jklRate}x`, null);
  } else {
    // No native reverse — step back 1s × accel.
    els.previewPlayer.pause();
    _jklRate = Math.min(8, _jklRate * 2);
    const total = getSequenceDuration();
    const next = clampNumber(state.timelineCursor - _jklRate, 0, total);
    if (state.sequence.length > 0) previewTimelineAt(next, { autoplay: false, forceReload: false });
    setStatus("Playback", `Rewind ${_jklRate}s`, null);
  }
  clearTimeout(_jklTimer);
  _jklTimer = setTimeout(() => { _jklRate = 1; els.previewPlayer.playbackRate = 1; }, 1500);
}

function wireRowDivider() {
  if (!els.rowDivider) return;
  const workspace = document.querySelector(".workspace");
  if (!workspace) return;
  let drag = null;

  const onMove = (e) => {
    if (!drag) return;
    const y = e.clientY - drag.workspaceTop;
    // Clamp so neither row can collapse entirely: keep ≥18% top and
    // ≥18% bottom (≈ matches the panel minimums comfortably).
    const min = drag.workspaceHeight * 0.18;
    const max = drag.workspaceHeight * 0.82;
    const next = Math.max(min, Math.min(max, y));
    workspace.style.setProperty("--top-row-h", `${Math.round(next)}px`);
  };

  const onUp = () => {
    if (!drag) return;
    drag = null;
    els.rowDivider.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  els.rowDivider.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = workspace.getBoundingClientRect();
    drag = { workspaceTop: rect.top, workspaceHeight: rect.height };
    els.rowDivider.classList.add("dragging");
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

function wireEvents() {
  let previousAspectPreset = els.aspectPreset.value;

  wireRowDivider();
  if (els.languageSelect) {
    els.languageSelect.value = state.uiLanguage;
    els.languageSelect.addEventListener("change", () => {
      applyLanguage(els.languageSelect.value);
    });
  }
  if (els.undoButton) els.undoButton.addEventListener("click", undo);
  if (els.redoButton) els.redoButton.addEventListener("click", redo);
  if (els.openProjectButton) els.openProjectButton.addEventListener("click", openProjectFromDisk);
  if (els.saveProjectButton) els.saveProjectButton.addEventListener("click", () => saveProject());
  if (els.recentProjectsButton) els.recentProjectsButton.addEventListener("click", () => {
    showRecentProjectsMenu(els.recentProjectsButton);
  });
  if (els.importSubtitleButton) els.importSubtitleButton.addEventListener("click", importSubtitleFile);
  if (els.exportSubtitleButton) els.exportSubtitleButton.addEventListener("click", exportSubtitleFile);
  if (els.generateSubtitleButton) els.generateSubtitleButton.addEventListener("click", openGenerateSubtitlesModal);
  if (els.closeGenerateSubtitleModal) els.closeGenerateSubtitleModal.addEventListener("click", closeGenerateSubtitlesModal);
  if (els.cancelGenerateSubtitle) els.cancelGenerateSubtitle.addEventListener("click", closeGenerateSubtitlesModal);
  if (els.confirmGenerateSubtitle) els.confirmGenerateSubtitle.addEventListener("click", runLocalSubtitleGeneration);
  if (els.ytsubRootBrowse) els.ytsubRootBrowse.addEventListener("click", async () => {
    const fallback = (await _getBundledEngineRoot()) || "";
    const picked = await window.editorAPI.pickDirectory(els.ytsubRoot?.value || fallback);
    if (picked && els.ytsubRoot) {
      els.ytsubRoot.value = picked;
      await _refreshEngineStatus();
    }
  });
  if (els.ytsubResetRoot) els.ytsubResetRoot.addEventListener("click", async () => {
    if (!els.ytsubRoot) return;
    els.ytsubRoot.value = await _getBundledEngineRoot();
    try { localStorage.removeItem(YTSUB_ROOT_STORAGE); } catch {}
    await _refreshEngineStatus();
  });
  if (els.setupEngineButton) els.setupEngineButton.addEventListener("click", runEngineSetupFlow);
  if (els.ytsubRoot) {
    els.ytsubRoot.addEventListener("change", _refreshEngineStatus);
  }
  if (els.generateSubtitleModal) {
    els.generateSubtitleModal.addEventListener("click", (e) => {
      if (e.target === els.generateSubtitleModal) closeGenerateSubtitlesModal();
    });
  }
  wireKeyboardShortcuts();
  wireDragAndDropImport();
  els.importButton.addEventListener("click", importVideos);
  els.appendButton.addEventListener("click", () => addSelectedLibraryClipToSequence());
  els.libraryList.addEventListener("click", handleLibraryClick);
  els.libraryList.addEventListener("dblclick", handleLibraryDblClick);
  els.libraryList.addEventListener("keydown", handleLibraryKeydown);
  // Export modal: open/close + confirm
  if (els.openExportButton) els.openExportButton.addEventListener("click", openExportModal);
  if (els.closeExportModal) els.closeExportModal.addEventListener("click", closeExportModal);
  if (els.cancelExportModal) els.cancelExportModal.addEventListener("click", closeExportModal);
  if (els.confirmExportButton) els.confirmExportButton.addEventListener("click", runExportFromModal);
  if (els.exportFolderBrowse) els.exportFolderBrowse.addEventListener("click", chooseExportFolder);
  if (els.exportTitle) els.exportTitle.addEventListener("input", updateExportModalSummary);
  if (els.enableVideoExport) els.enableVideoExport.addEventListener("change", updateExportModalSectionStates);
  if (els.enableAudioExport) els.enableAudioExport.addEventListener("change", updateExportModalSectionStates);
  if (els.exportPreset) {
    els.exportPreset.addEventListener("change", () => {
      if (els.exportPreset.value === "custom") return;
      applyExportPreset(els.exportPreset.value);
    });
  }
  // Click outside the modal-shell, or press Escape, to close.
  if (els.exportModal) {
    els.exportModal.addEventListener("click", (e) => {
      if (e.target === els.exportModal) closeExportModal();
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.exportModal && !els.exportModal.classList.contains("hidden")) {
      closeExportModal();
    }
  });
  els.moveClipUp.addEventListener("click", () => moveSelectedClip(-1));
  els.moveClipDown.addEventListener("click", () => moveSelectedClip(1));
  els.removeClip.addEventListener("click", removeSelectedClip);
  els.splitClipButton.addEventListener("click", splitSelectedClipAtPlayhead);
  els.splitClipInspector.addEventListener("click", splitSelectedClipAtPlayhead);
  els.playTimelineButton.addEventListener("click", toggleTimelinePlayback);
  els.jumpStartButton.addEventListener("click", () => previewTimelineAt(0, { forceReload: true }));
  els.jumpEndButton.addEventListener("click", () => previewTimelineAt(getSequenceDuration(), { forceReload: true }));
  if (els.timelineZoomPill) {
    els.timelineZoomPill.addEventListener("click", () => {
      if (state.timelineZoom === 1 && state.timelineScrollLeft === 0) return;
      state.timelineZoom = 1;
      state.timelineScrollLeft = 0;
      render();
    });
  }
  if (els.previewZoomLabel) {
    els.previewZoomLabel.addEventListener("click", () => {
      if (state.previewZoom === 1 && state.previewPanX === 0 && state.previewPanY === 0) return;
      state.previewZoom = 1;
      state.previewPanX = 0;
      state.previewPanY = 0;
      _applyPreviewZoom();
      _updatePreviewZoomLabel();
    });
  }
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

  [els.renderMode, els.fps, els.videoBitrate, els.crf, els.videoPreset, els.videoCodec, els.audioBitrate, els.audioSampleRate, els.audioFormat]
    .filter(Boolean)
    .forEach((element) => element.addEventListener("change", refreshExportEstimate));

  bindInspectorInputs();
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
  // Inject visual timeline styles.
  const tlStyle = document.createElement("style");
  tlStyle.textContent = `
    /* ── Visual timeline container ── */
    .tl-container {
      width: 100%;
      min-height: 116px;
      background: #111318;
      border-radius: 6px;
      overflow-x: auto;
      overflow-y: hidden;
      scrollbar-width: thin;
      scrollbar-color: #374151 #111318;
      position: relative;
      box-sizing: border-box;
    }
    .tl-container::-webkit-scrollbar { height: 6px; }
    .tl-container::-webkit-scrollbar-track { background: #111318; }
    .tl-container::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }

    .tl-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 116px;
    }
    .tl-empty-msg {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      color: #4b5563;
      font-size: 13px;
    }
    .tl-empty-msg svg { opacity: 0.5; }
  `;
  document.head.appendChild(tlStyle);

  // Restore the user-preferred subtitle font size from a previous session.
  try {
    const saved = Number(localStorage.getItem("cutline.subtitleFontPx"));
    if (Number.isFinite(saved) && saved >= 8 && saved <= 96) {
      state.subtitleFontPx = saved;
    }
  } catch {}
  // Restore the user-preferred subtitle overlay position from a previous session.
  try {
    const sx = Number(localStorage.getItem("cutline.subtitleOverlayX"));
    if (Number.isFinite(sx) && sx >= 0 && sx <= 100) state.subtitleOverlayX = sx;
    const sy = Number(localStorage.getItem("cutline.subtitleOverlayY"));
    if (Number.isFinite(sy) && sy >= 0 && sy <= 100) state.subtitleOverlayY = sy;
  } catch {}
  // Restore the user-preferred UI language (defaults to zh).
  try {
    const savedLang = localStorage.getItem("cutline.uiLanguage");
    applyLanguage(savedLang === "en" ? "en" : "zh");
  } catch {
    applyLanguage("zh");
  }

  render();
  wireEvents();
  wirePreviewStageZoom();
  _attachSubtitleOverlayDrag();
  // Offer to restore the previous session if we crashed / were closed mid-edit.
  try { tryRestoreAutosave(); } catch {}
  try {
    state.renderCapabilities = await window.editorAPI.getRenderCapabilities();
    renderExportSummary();
  } catch (error) {
    els.exportFootnote.textContent = error.message || "Could not detect export capabilities.";
  }
}

initialize();
