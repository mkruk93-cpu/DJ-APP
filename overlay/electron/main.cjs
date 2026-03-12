const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");
const { dialog } = require("electron");

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function sanitizePart(value) {
  return String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function runYtDlpDownload(targetDir, item) {
  return new Promise((resolve, reject) => {
    const safeArtist = sanitizePart(item.artist || "Unknown Artist");
    const safeTitle = sanitizePart(item.title || "Unknown Title");
    const outtmpl = path.join(targetDir, `${safeArtist} - ${safeTitle}.%(ext)s`);
    const args = [
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "192K",
      "--no-playlist",
      "--no-warnings",
      "-o", outtmpl,
      String(item.url),
    ];
    const attempts = [
      { command: "python", args: ["-m", "yt_dlp", ...args] },
      { command: "yt-dlp", args },
    ];
    let stderr = "";
    const runAttempt = (index) => {
      const attempt = attempts[index];
      if (!attempt) {
        reject(new Error(stderr.trim() || "Geen werkende yt-dlp runner gevonden."));
        return;
      }
      const child = spawn(attempt.command, attempt.args, { stdio: ["ignore", "pipe", "pipe"] });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 6000) stderr = stderr.slice(-6000);
      });
      child.on("error", (err) => {
        stderr += `\n${attempt.command} start failed: ${err.message}`;
        runAttempt(index + 1);
      });
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        stderr += `\n${attempt.command} exited with ${code}`;
        runAttempt(index + 1);
      });
    };
    runAttempt(0);
  });
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(process.cwd(), "electron", "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.setFullScreenable(false);

  if (isDev) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(process.cwd(), "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.on("overlay:set-click-through", (_event, enabled) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setIgnoreMouseEvents(Boolean(enabled), { forward: true });
  });

  ipcMain.handle("overlay:pick-download-directory", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win ?? undefined, {
      title: "Kies download map",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });

  ipcMain.handle("overlay:download-batch", async (_event, payload) => {
    const targetDir = String(payload?.targetDir ?? "").trim();
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!targetDir) return { ok: false, error: "Geen download pad gekozen." };
    if (!items.length) return { ok: false, error: "Geen items om te downloaden." };
    fs.mkdirSync(targetDir, { recursive: true });

    let success = 0;
    const failed = [];
    for (const rawItem of items) {
      const item = {
        url: String(rawItem?.url ?? "").trim(),
        title: String(rawItem?.title ?? "").trim(),
        artist: String(rawItem?.artist ?? "").trim(),
      };
      if (!item.url) {
        failed.push({ item, error: "Lege URL" });
        continue;
      }
      try {
        // Sequential downloads keep CPU/disk pressure lower during live DJ usage.
        // eslint-disable-next-line no-await-in-loop
        await runYtDlpDownload(targetDir, item);
        success += 1;
      } catch (err) {
        failed.push({ item, error: err instanceof Error ? err.message : "Download mislukt" });
      }
    }

    return {
      ok: failed.length === 0,
      success,
      failed,
      total: items.length,
      error: failed.length > 0 ? failed[0].error : undefined,
    };
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Emergency shortcut in case click-through was enabled.
  globalShortcut.register("CommandOrControl+Shift+0", () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.setIgnoreMouseEvents(false, { forward: true });
    win.focus();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
