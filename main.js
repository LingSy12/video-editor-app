const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell, Notification } = require("electron");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const {
  getRenderCapabilities,
  probeMedia,
  runExport,
  runAudioExport,
  normalizeExportSettings,
  preparePreviewMedia,
  summarizeExportSettings,
} = require("./src/exporter");

const VIDEO_FILTERS = [
  {
    name: "Video Files",
    extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"],
  },
];

let mainWindow;

const GPU_SWITCHES = Object.freeze([
  "force_high_performance_gpu",
  "ignore-gpu-blocklist",
  "enable-gpu-rasterization",
  "disable-software-rasterizer",
]);

for (const name of GPU_SWITCHES) {
  app.commandLine.appendSwitch(name);
}

async function logGpuDiagnostics() {
  try {
    console.log("[gpu] feature status", app.getGPUFeatureStatus());
    console.log("[gpu] basic info", await app.getGPUInfo("basic"));
  } catch (error) {
    console.warn("[gpu] Unable to read GPU diagnostics.", error);
  }
}

app.once("gpu-info-update", () => {
  void logGpuDiagnostics();
});

app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") {
    return;
  }

  console.warn("[gpu] GPU process exited.", details);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: "#0b0f14",
    title: "Cutline Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

async function cleanupOrphanProxyTempFiles() {
  // Remove any .tmp files left in the preview cache by a previous run that
  // was killed mid-transcode. Otherwise they sit on disk forever.
  try {
    const cacheDir = path.join(app.getPath("userData"), "preview-cache");
    const entries = await fs.promises.readdir(cacheDir);
    await Promise.all(
      entries
        .filter((name) => name.endsWith(".tmp"))
        .map((name) =>
          fs.promises.unlink(path.join(cacheDir, name)).catch(() => null),
        ),
    );
  } catch {
    // Cache dir may not exist yet — nothing to clean.
  }
}

app.whenReady().then(async () => {
  await cleanupOrphanProxyTempFiles();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

ipcMain.handle("dialog:open-videos", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Videos",
    properties: ["openFile", "multiSelections"],
    filters: VIDEO_FILTERS,
  });

  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("dialog:save-export", async (_event, suggestedName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Combined Video",
    defaultPath: suggestedName || "cutline-export.mp4",
    filters: [{ name: "MP4 Video", extensions: ["mp4"] }],
  });

  return result.canceled ? null : result.filePath;
});

ipcMain.handle("system:reveal-in-folder", async (_event, filePath) => {
  if (!filePath) return false;
  try {
    shell.showItemInFolder(filePath);
    return true;
  } catch {
    return false;
  }
});

const AUDIO_FORMAT_FILTERS = {
  m4a: { name: "AAC Audio (M4A)", extensions: ["m4a"] },
  mp3: { name: "MP3 Audio", extensions: ["mp3"] },
  wav: { name: "WAV Audio (PCM)", extensions: ["wav"] },
};

ipcMain.handle("dialog:pick-directory", async (_event, defaultPath) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Export Folder",
    defaultPath: defaultPath || undefined,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : (result.filePaths?.[0] || null);
});

ipcMain.handle("dialog:save-audio-export", async (_event, suggestedName, audioFormat) => {
  const fmt = AUDIO_FORMAT_FILTERS[audioFormat] ? audioFormat : "m4a";
  const filter = AUDIO_FORMAT_FILTERS[fmt];
  const fallback = `cutline-audio.${fmt}`;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export Combined Audio",
    defaultPath: suggestedName || fallback,
    filters: [filter],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle("media:probe-files", async (_event, filePaths) => {
  const probes = await Promise.all(
    (filePaths || []).map((filePath) =>
      probeMedia(filePath, ffprobePath).catch((error) => ({
        path: filePath,
        error: error.message,
      })),
    ),
  );

  return probes;
});

ipcMain.handle("media:prepare-preview", async (_event, filePath) => {
  return preparePreviewMedia({
    inputPath: filePath,
    ffmpegPath,
    ffprobePath,
    cacheDir: path.join(app.getPath("userData"), "preview-cache"),
  });
});

ipcMain.handle("export:capabilities", async () => {
  return getRenderCapabilities(ffmpegPath);
});

ipcMain.handle("export:estimate", async (_event, payload) => {
  const settings = normalizeExportSettings(payload?.settings || {});
  return summarizeExportSettings({
    clips: payload?.clips || [],
    audioClips: payload?.audioClips || [],
    settings,
    ffmpegPath,
  });
});

ipcMain.handle("project:export", async (event, payload) => {
  const settings = normalizeExportSettings(payload?.settings || {});

  return runExport({
    clips: payload?.clips || [],
    audioClips: payload?.audioClips || [],
    outputPath: payload?.outputPath,
    settings,
    ffmpegPath,
    onProgress(progress) {
      event.sender.send("export:progress", progress);
    },
  });
});

ipcMain.handle("project:export-audio", async (event, payload) => {
  return runAudioExport({
    clips: payload?.clips || [],
    audioClips: payload?.audioClips || [],
    outputPath: payload?.outputPath,
    audioFormat: payload?.audioFormat,
    audioBitrate: payload?.audioBitrate,
    sampleRate: payload?.sampleRate,
    ffmpegPath,
    onProgress(progress) {
      event.sender.send("export:progress", progress);
    },
  });
});

// ── Project file I/O ───────────────────────────────────────────────────
ipcMain.handle("project:save-file", async (_event, suggestedPath, jsonText) => {
  // suggestedPath: when null/undefined we always prompt; when a real path,
  // we overwrite directly (Save vs Save-As distinction lives in the renderer).
  let targetPath = suggestedPath;
  if (!targetPath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save Project",
      defaultPath: "cutline-project.cutline",
      filters: [{ name: "Cutline Project", extensions: ["cutline", "json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    targetPath = result.filePath;
  }
  await fs.promises.writeFile(targetPath, jsonText, "utf8");
  return targetPath;
});

ipcMain.handle("project:open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open Project",
    properties: ["openFile"],
    filters: [{ name: "Cutline Project", extensions: ["cutline", "json"] }],
  });
  if (result.canceled || !result.filePaths?.length) return null;
  return result.filePaths[0];
});

ipcMain.handle("project:read-file", async (_event, filePath) => {
  if (!filePath) return null;
  const text = await fs.promises.readFile(filePath, "utf8");
  return { path: filePath, text };
});

// ── Subtitle file I/O ───────────────────────────────────────────────────
const SUBTITLE_FILTERS = [
  { name: "Subtitle Files", extensions: ["srt", "vtt"] },
  { name: "All Files", extensions: ["*"] },
];

ipcMain.handle("subtitle:open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import Subtitles",
    properties: ["openFile"],
    filters: SUBTITLE_FILTERS,
  });
  if (result.canceled || !result.filePaths?.length) return null;
  const filePath = result.filePaths[0];
  const text = await fs.promises.readFile(filePath, "utf8");
  return { path: filePath, text };
});

ipcMain.handle("subtitle:save-file", async (_event, suggestedPath, srtText) => {
  let target = suggestedPath;
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export Subtitles",
      defaultPath: "subtitles.srt",
      filters: [{ name: "SubRip Subtitle", extensions: ["srt"] }],
    });
    if (result.canceled || !result.filePath) return null;
    target = result.filePath;
  }
  await fs.promises.writeFile(target, srtText, "utf8");
  return target;
});

// Resolve the absolute path to the subtitle engine. The Python source ships
// inside the app folder under "subtitle-engine/", but when running from a
// portable EXE that folder lives in a per-launch temp directory — meaning a
// venv installed there would vanish after every relaunch. So if the bundled
// folder is inside the OS temp dir we mirror the source into userData/ once,
// then return that stable path. The venv created via Setup lives next to the
// stable source, surviving across launches.
let _cachedEngineRoot = null;
async function _resolveEngineRoot() {
  if (_cachedEngineRoot) return _cachedEngineRoot;
  const bundled = path.join(__dirname, "subtitle-engine");
  const tempDir = app.getPath("temp");
  const normalize = (p) => p.replace(/\\/g, "/").toLowerCase();
  const isPortableLaunch = normalize(bundled).startsWith(normalize(tempDir) + "/");
  if (!isPortableLaunch) {
    _cachedEngineRoot = bundled;
    return bundled;
  }
  const stable = path.join(app.getPath("userData"), "subtitle-engine");
  try {
    await fs.promises.mkdir(stable, { recursive: true });
    // Mirror source — overwrite Python files (so a new editor build updates
    // the engine code) but skip the user's .venv so a pip-install survives
    // editor upgrades. We DO mirror vendor/ — the CUDA DLLs in there are what
    // makes GPU transcription work; without them ctranslate2 can't load
    // cublas64_12.dll and falls back to CPU. The cost is ~1.4GB one-time copy
    // on first launch when running portable; afterwards the dest exists so cp
    // just touches files.
    await fs.promises.cp(bundled, stable, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(bundled, src);
        return !rel.startsWith(".venv")
          && !rel.split(path.sep).includes("__pycache__");
      },
    });
  } catch (e) {
    console.warn("[subtitle-engine] failed to mirror source to userData:", e);
  }
  _cachedEngineRoot = stable;
  return stable;
}

ipcMain.handle("subtitle:engine-root", async () => {
  return _resolveEngineRoot();
});

// Engine readiness probe. Reports whether the bundled venv exists and the
// ytsubtitle package is importable, so the renderer can show a "Setup"
// button or skip straight to transcription.
ipcMain.handle("subtitle:engine-status", async (_event, customRoot) => {
  const root = customRoot || (await _resolveEngineRoot());
  const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
  let rootExists = false;
  let venvExists = false;
  try { await fs.promises.access(root); rootExists = true; } catch {}
  try { await fs.promises.access(venvPython); venvExists = true; } catch {}
  return { root, rootExists, venvExists };
});

// Run setup.bat in the engine root to create the venv + install requirements.
// Streams stdout/stderr lines to the renderer via the same subtitle:progress
// channel so the modal's progress block shows what's happening live.
ipcMain.handle("subtitle:engine-setup", async (event, customRoot) => {
  const root = customRoot || (await _resolveEngineRoot());
  try { await fs.promises.access(root); } catch {
    throw new Error(`subtitle-engine folder not found at ${root}`);
  }
  const setupBat = path.join(root, "setup.bat");
  try { await fs.promises.access(setupBat); } catch {
    throw new Error(`setup.bat missing at ${setupBat}`);
  }
  const sendLog = (line) => {
    try { event.sender.send("subtitle:progress", { event: "log", line }); } catch {}
  };
  return new Promise((resolve, reject) => {
    const proc = spawn("cmd.exe", ["/c", setupBat], {
      cwd: root,
      windowsHide: true,
      env: process.env,
    });
    let stderrBuf = "";
    proc.stdout.on("data", (chunk) => {
      const parts = chunk.toString().split(/\r?\n/);
      for (const ln of parts) if (ln.trim()) sendLog(ln.trim());
    });
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      const parts = chunk.toString().split(/\r?\n/);
      for (const ln of parts) if (ln.trim()) sendLog(ln.trim());
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ exitCode: 0 });
      else reject(new Error(`setup.bat failed (exit ${code}): ${stderrBuf.slice(-600)}`));
    });
  });
});

// Tracks the currently-running ytsubtitle child process so the renderer's
// Cancel button can tear it down (otherwise the Python worker keeps running
// in the background even after the user dismisses the modal — wastes minutes
// of CPU/GPU time per run, especially with whole-timeline transcription).
let _activeTranscribeProc = null;

function _killActiveTranscribe() {
  const proc = _activeTranscribeProc;
  if (!proc) return false;
  _activeTranscribeProc = null;
  try {
    // On Windows, tree-kill via taskkill is the only way to also stop the
    // Python `chunk_worker` subprocesses spawned by the CLI. Without /T the
    // worker keeps running and holds GPU memory until the model finishes.
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { windowsHide: true });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (e) {
    console.warn("[subtitle] kill failed:", e);
  }
  return true;
}

ipcMain.handle("subtitle:cancel-transcribe", async () => {
  return _killActiveTranscribe();
});

// Spawn the local ytsubtitle Python CLI (subtitle-engine/.venv/Scripts/python.exe
// -m ytsubtitle ...) against an input media file and stream its progress
// events back to the renderer. Returns { srtPath, vttPath, error? }.
ipcMain.handle("subtitle:transcribe-local", async (event, payload) => {
  const opts = payload || {};
  if (!opts.inputPath) throw new Error("subtitle:transcribe-local missing inputPath");
  const root = opts.ytsubRoot;
  if (!root) throw new Error("ytsubtitle root path not configured");
  try {
    await fs.promises.access(root);
  } catch {
    throw new Error(`ytsubtitle root not found: ${root}`);
  }
  // Prefer the bundled venv Python so users don't need a system Python.
  const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
  let pythonExe = venvPython;
  try { await fs.promises.access(venvPython); } catch {
    pythonExe = "python";
  }
  const cacheDir = path.join(app.getPath("userData"), "subtitle-cache");
  await fs.promises.mkdir(cacheDir, { recursive: true });
  // Each run writes into its own subdir so concurrent jobs don't clash.
  const runId = crypto.randomBytes(6).toString("hex");
  const runDir = path.join(cacheDir, `run-${runId}`);
  await fs.promises.mkdir(runDir, { recursive: true });
  const basename = "transcript";

  const args = [
    "-m", "ytsubtitle",
    opts.inputPath,
    "--output-dir", runDir,
    "--basename", basename,
    "--formats", "srt",
    "--model", opts.model || "medium",
    "--device", opts.device || "auto",
    "--progress-json",
    // Default is 60s of media between progress events; that's too quiet for the
    // GUI — fire every 1s so the bar and ETA tick continuously while Whisper
    // chews through the clip.
    "--progress-every", "1",
  ];
  if (opts.language) args.push("--language", opts.language);
  if (opts.lowVram) args.push("--low-vram");
  if (opts.accurateTiming) args.push("--accurate-timing");
  if (opts.noCpuFallback) args.push("--no-cpu-fallback");
  if (opts.initialPrompt) args.push("--initial-prompt", opts.initialPrompt);

  const senderId = event.sender.id;
  const sendProgress = (data) => {
    try { event.sender.send("subtitle:progress", data); } catch {}
  };

  // Kill any leftover proc from a previous run before starting a new one.
  // The renderer normally cancels on modal close, but if anything got out of
  // sync we don't want two ytsubtitle processes fighting for the GPU.
  _killActiveTranscribe();

  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExe, args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    _activeTranscribeProc = proc;
    let stderrBuf = "";
    let stdoutTail = "";
    let cancelled = false;
    const handleLine = (line) => {
      if (!line) return;
      if (line.startsWith("__YTSUBTITLE_PROGRESS__")) {
        try {
          const json = JSON.parse(line.slice("__YTSUBTITLE_PROGRESS__".length));
          sendProgress(json);
        } catch {}
        return;
      }
      // Pass plain stdout lines as informational status updates.
      sendProgress({ event: "log", line });
    };
    proc.stdout.on("data", (chunk) => {
      stdoutTail = (stdoutTail + chunk.toString()).slice(-4000);
      const parts = (chunk.toString()).split(/\r?\n/);
      for (const ln of parts) handleLine(ln.trim());
    });
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString();
      // Stream short stderr lines too so the user sees model-download progress.
      const parts = chunk.toString().split(/\r?\n/);
      for (const ln of parts) if (ln.trim()) sendProgress({ event: "log", line: ln.trim() });
    });
    proc.on("error", (err) => {
      if (_activeTranscribeProc === proc) _activeTranscribeProc = null;
      reject(err);
    });
    proc.on("close", async (code) => {
      if (_activeTranscribeProc === proc) _activeTranscribeProc = null;
      else cancelled = true; // somebody else (the cancel handler) cleared it
      if (cancelled) {
        reject(new Error("Transcription cancelled."));
        return;
      }
      const srtPath = path.join(runDir, `${basename}.srt`);
      try {
        const srtText = await fs.promises.readFile(srtPath, "utf8");
        resolve({ srtPath, srtText, exitCode: code });
      } catch (e) {
        const failure = stderrBuf.slice(-800) || stdoutTail.slice(-800) || "transcription failed";
        reject(new Error(`Transcription failed (exit ${code}): ${failure}`));
      }
    });
  });
});

// Extract a compact mono 16 kHz MP3 from a media file (ideal for Whisper).
// Returns absolute path. Used by the renderer-side "Generate subtitles" flow.
ipcMain.handle("subtitle:extract-audio", async (_event, payload) => {
  const inputPath = payload?.inputPath;
  if (!inputPath) throw new Error("subtitle:extract-audio missing inputPath");
  const cacheDir = path.join(app.getPath("userData"), "subtitle-cache");
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const hash = crypto.createHash("sha1")
    .update(inputPath + ":" + (payload?.trimStart || 0) + ":" + (payload?.trimEnd || 0))
    .digest("hex").slice(0, 16);
  const outPath = path.join(cacheDir, `audio-${hash}.mp3`);
  try {
    await fs.promises.access(outPath);
    return outPath;
  } catch {}
  const args = ["-y"];
  if (Number.isFinite(payload?.trimStart)) args.push("-ss", String(payload.trimStart));
  args.push("-i", inputPath);
  if (Number.isFinite(payload?.trimEnd) && Number.isFinite(payload?.trimStart)) {
    args.push("-t", String(Math.max(0, payload.trimEnd - payload.trimStart)));
  }
  args.push(
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "64k",
    outPath,
  );
  await _runFfmpeg(args);
  return outPath;
});

// ── System notification ────────────────────────────────────────────────
ipcMain.handle("system:notify-export-done", async (_event, payload) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: payload?.title || "Cutline Studio",
    body: payload?.body || "Export finished.",
    silent: false,
  });
  if (payload?.outputPath) {
    n.on("click", () => {
      try { shell.showItemInFolder(payload.outputPath); } catch {}
    });
  }
  n.show();
  return true;
});

// ── Waveform + thumbnail strip generation ──────────────────────────────
// Both cache to userData/preview-cache so re-using a clip is instant.
const { spawn } = require("child_process");
const crypto = require("crypto");

function _runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
    proc.on("error", reject);
  });
}

ipcMain.handle("media:build-waveform", async (_event, filePath) => {
  if (!filePath) return null;
  const cacheDir = path.join(app.getPath("userData"), "preview-cache");
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16);
  const outPath = path.join(cacheDir, `wave-${hash}.png`);
  try {
    await fs.promises.access(outPath);
    return outPath; // cache hit
  } catch {}
  // Render a flat horizontal waveform — 1200×80 keeps the PNG small but
  // detailed enough to read transients. `aformat` ensures stereo mixdown so
  // mono sources don't crash showwavespic.
  await _runFfmpeg([
    "-y", "-i", filePath,
    "-filter_complex", "aformat=channel_layouts=mono,showwavespic=s=1200x80:colors=#f0c089",
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
});

ipcMain.handle("media:build-thumbnail-strip", async (_event, filePath) => {
  if (!filePath) return null;
  const cacheDir = path.join(app.getPath("userData"), "preview-cache");
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const hash = crypto.createHash("sha1").update(filePath).digest("hex").slice(0, 16);
  const outPath = path.join(cacheDir, `thumbs-${hash}.png`);
  try {
    await fs.promises.access(outPath);
    return outPath; // cache hit
  } catch {}
  // 12 evenly-spaced thumbnails, 90×60 each, tiled horizontally → 1080×60.
  // fps filter samples N frames per second; we don't know the duration here so
  // we use `select` with isnan trick. Simpler: ffprobe first, then frame
  // selection. To keep this self-contained we use thumbnail filter + scale.
  await _runFfmpeg([
    "-y", "-i", filePath,
    "-vf", "fps=1/1,scale=90:60:force_original_aspect_ratio=increase,crop=90:60,tile=12x1",
    "-frames:v", "1",
    "-q:v", "5",
    outPath,
  ]);
  return outPath;
});
