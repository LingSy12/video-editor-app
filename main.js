const path = require("path");
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const ffmpegPath = require("ffmpeg-static");
const ffprobePath = require("ffprobe-static").path;
const {
  probeMedia,
  runExport,
  normalizeExportSettings,
  preparePreviewMedia,
} = require("./src/exporter");

const VIDEO_FILTERS = [
  {
    name: "Video Files",
    extensions: ["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"],
  },
];

let mainWindow;

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

app.whenReady().then(() => {
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
    cacheDir: path.join(app.getPath("userData"), "preview-cache"),
  });
});

ipcMain.handle("project:export", async (event, payload) => {
  const settings = normalizeExportSettings(payload?.settings || {});

  return runExport({
    clips: payload?.clips || [],
    outputPath: payload?.outputPath,
    settings,
    ffmpegPath,
    onProgress(progress) {
      event.sender.send("export:progress", progress);
    },
  });
});
