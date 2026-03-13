const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const NodeID3 = require("node-id3");
const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require("electron");
const { dialog } = require("electron");

const isDev = !!process.env.VITE_DEV_SERVER_URL;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
let preferredYtDlpRunner = null;

function sanitizePart(value) {
  return String(value ?? "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDownloadTitle(title, artist) {
  const base = sanitizePart(title || "Unknown Title");
  const artistText = sanitizePart(artist || "");
  if (!artistText) return base;
  const escapedArtist = artistText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutArtistPrefix = base.replace(new RegExp(`^${escapedArtist}\\s*[-–—:|]+\\s*`, "i"), "").trim();
  return withoutArtistPrefix || base;
}

function runYtDlpDownload(targetDir, item) {
  return new Promise((resolve, reject) => {
    const safeArtist = sanitizePart(item.artist || "Unknown Artist");
    const safeTitle = normalizeDownloadTitle(item.title || "Unknown Title", safeArtist);
    const baseOutputName = `${safeArtist} - ${safeTitle}`;
    const outtmpl = path.join(targetDir, `${baseOutputName}.%(ext)s`);
    const expectedOutputPath = path.join(targetDir, `${baseOutputName}.mp3`);
    const args = [
      "--format", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "192K",
      "--concurrent-fragments", "4",
      "--add-metadata",
      "--no-playlist",
      "--no-warnings",
      "-o", outtmpl,
      String(item.url),
    ];
    const attempts = preferredYtDlpRunner === "python"
      ? [
          { command: "python", args: ["-m", "yt_dlp", ...args], runner: "python" },
          { command: "yt-dlp", args, runner: "yt-dlp" },
        ]
      : preferredYtDlpRunner === "yt-dlp"
        ? [
            { command: "yt-dlp", args, runner: "yt-dlp" },
            { command: "python", args: ["-m", "yt_dlp", ...args], runner: "python" },
          ]
        : [
            { command: "python", args: ["-m", "yt_dlp", ...args], runner: "python" },
            { command: "yt-dlp", args, runner: "yt-dlp" },
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
          preferredYtDlpRunner = attempt.runner;
          resolve(expectedOutputPath);
          return;
        }
        stderr += `\n${attempt.command} exited with ${code}`;
        runAttempt(index + 1);
      });
    };
    runAttempt(0);
  });
}

function writeMp3Metadata(filePath, item) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return;
    const artist = sanitizePart(item.artist || "").trim();
    const title = sanitizePart(item.title || "").trim();
    const tags = {
      title: title || "Unknown Title",
      artist: artist || "Unknown Artist",
      performerInfo: artist || "Unknown Artist",
      albumArtist: artist || "Unknown Artist",
    };
    NodeID3.update(tags, filePath);
  } catch (err) {
    console.warn("[overlay] Could not write MP3 metadata:", err instanceof Error ? err.message : String(err));
  }
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

    const requestedParallel = Number(payload?.maxParallel);
    const maxParallel = Number.isFinite(requestedParallel)
      ? Math.min(8, Math.max(1, Math.round(requestedParallel)))
      : DEFAULT_DOWNLOAD_CONCURRENCY;

    let success = 0;
    const failed = [];
    const normalizedItems = items.map((rawItem) => ({
      url: String(rawItem?.url ?? "").trim(),
      title: String(rawItem?.title ?? "").trim(),
      artist: String(rawItem?.artist ?? "").trim(),
    }));
    let cursor = 0;
    const workerCount = Math.min(maxParallel, normalizedItems.length);
    const workers = Array.from({ length: workerCount }, () => (async () => {
      while (true) {
        const idx = cursor;
        cursor += 1;
        if (idx >= normalizedItems.length) return;
        const item = normalizedItems[idx];
        if (!item.url) {
          failed.push({ item, error: "Lege URL" });
          continue;
        }
        try {
          const outputPath = await runYtDlpDownload(targetDir, item);
          writeMp3Metadata(outputPath, item);
          success += 1;
        } catch (err) {
          failed.push({ item, error: err instanceof Error ? err.message : "Download mislukt" });
        }
      }
    })());
    await Promise.all(workers);

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
