const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayHost", {
  setClickThrough(enabled) {
    ipcRenderer.send("overlay:set-click-through", enabled);
  },
  pickDownloadDirectory() {
    return ipcRenderer.invoke("overlay:pick-download-directory");
  },
  downloadBatch(payload) {
    return ipcRenderer.invoke("overlay:download-batch", payload);
  },
});
