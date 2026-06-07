const { contextBridge, ipcRenderer, webUtils } = require("electron");

function pathToFileUrl(filePath) {
  const slashes = String(filePath).replace(/\\/g, "/");
  const absolute = slashes.startsWith("/") ? slashes : "/" + slashes;
  const encoded = absolute.split("/").map((segment) => {
    if (/^[A-Za-z]:$/.test(segment)) return segment;
    return encodeURIComponent(segment);
  }).join("/");
  return "file://" + encoded;
}

contextBridge.exposeInMainWorld("editorAPI", {
  openVideos() {
    return ipcRenderer.invoke("dialog:open-videos");
  },
  saveExport(suggestedName) {
    return ipcRenderer.invoke("dialog:save-export", suggestedName);
  },
  probeFiles(filePaths) {
    return ipcRenderer.invoke("media:probe-files", filePaths);
  },
  preparePreview(filePath) {
    return ipcRenderer.invoke("media:prepare-preview", filePath);
  },
  getRenderCapabilities() {
    return ipcRenderer.invoke("export:capabilities");
  },
  estimateExport(payload) {
    return ipcRenderer.invoke("export:estimate", payload);
  },
  exportProject(payload) {
    return ipcRenderer.invoke("project:export", payload);
  },
  saveAudioExport(suggestedName, audioFormat) {
    return ipcRenderer.invoke("dialog:save-audio-export", suggestedName, audioFormat);
  },
  pickDirectory(defaultPath) {
    return ipcRenderer.invoke("dialog:pick-directory", defaultPath);
  },
  revealInFolder(filePath) {
    return ipcRenderer.invoke("system:reveal-in-folder", filePath);
  },
  exportProjectAudio(payload) {
    return ipcRenderer.invoke("project:export-audio", payload);
  },
  onExportProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("export:progress", listener);

    return () => {
      ipcRenderer.removeListener("export:progress", listener);
    };
  },
  toFileUrl(filePath) {
    return pathToFileUrl(filePath);
  },
  // Resolve a File (from a drag-and-drop event) to its absolute path on disk.
  // Electron 32+ exposes webUtils.getPathForFile for sandboxed renderers — the
  // old non-standard File.path was removed.
  resolveDroppedFilePath(file) {
    try {
      if (file && typeof webUtils?.getPathForFile === "function") {
        return webUtils.getPathForFile(file);
      }
    } catch {}
    return file?.path || null;
  },
  // Project save/load via main process (writes UTF-8 JSON; replaces existing).
  saveProjectFile(suggestedPath, jsonText) {
    return ipcRenderer.invoke("project:save-file", suggestedPath, jsonText);
  },
  openProjectFile() {
    return ipcRenderer.invoke("project:open-file");
  },
  readProjectFile(filePath) {
    return ipcRenderer.invoke("project:read-file", filePath);
  },
  // Surface a native OS notification when long renders finish.
  notifyExportDone(payload) {
    return ipcRenderer.invoke("system:notify-export-done", payload);
  },
  // Render a waveform PNG for an audio source and cache it in userData.
  buildWaveform(filePath) {
    return ipcRenderer.invoke("media:build-waveform", filePath);
  },
  // Render a horizontal thumbnail strip for a video source.
  buildThumbnailStrip(filePath) {
    return ipcRenderer.invoke("media:build-thumbnail-strip", filePath);
  },
  // Subtitle file I/O.
  openSubtitleFile() {
    return ipcRenderer.invoke("subtitle:open-file");
  },
  saveSubtitleFile(suggestedPath, srtText) {
    return ipcRenderer.invoke("subtitle:save-file", suggestedPath, srtText);
  },
  // Extract a mono 16 kHz MP3 ready for upload to Whisper.
  extractSubtitleAudio(payload) {
    return ipcRenderer.invoke("subtitle:extract-audio", payload);
  },
  // Run local faster-whisper (ytsubtitle) and stream progress events.
  transcribeLocal(payload) {
    return ipcRenderer.invoke("subtitle:transcribe-local", payload);
  },
  // Kill any in-flight transcribe subprocess so the user can abort a long run.
  cancelTranscribe() {
    return ipcRenderer.invoke("subtitle:cancel-transcribe");
  },
  onTranscribeProgress(callback) {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("subtitle:progress", listener);
    return () => ipcRenderer.removeListener("subtitle:progress", listener);
  },
  // Bundled subtitle engine helpers.
  getEngineRoot() {
    return ipcRenderer.invoke("subtitle:engine-root");
  },
  checkEngineStatus(customRoot) {
    return ipcRenderer.invoke("subtitle:engine-status", customRoot);
  },
  runEngineSetup(customRoot) {
    return ipcRenderer.invoke("subtitle:engine-setup", customRoot);
  },
});
