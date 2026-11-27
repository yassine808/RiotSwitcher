// Minimal Electron shell: one window, no framework, no extra processes.
// It is the language baseline for "JavaScript + Chromium", not the app.
const { app, BrowserWindow } = require("electron");
const path = require("path");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1100, height: 790 });
  win.loadFile(path.join(__dirname, "index.html"));
});

app.on("window-all-closed", () => app.quit());
