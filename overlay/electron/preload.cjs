const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlayHost", {
  setClickThrough(enabled) {
    ipcRenderer.send("overlay:set-click-through", enabled);
  },
});
