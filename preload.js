const { contextBridge, ipcRenderer } = require("electron");
const { pathToFileURL } = require("url");

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
  exportProject(payload) {
    return ipcRenderer.invoke("project:export", payload);
  },
  onExportProgress(callback) {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("export:progress", listener);

    return () => {
      ipcRenderer.removeListener("export:progress", listener);
    };
  },
  toFileUrl(filePath) {
    return pathToFileURL(filePath).href;
  },
});
