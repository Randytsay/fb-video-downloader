import { app, BrowserWindow } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let nextProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Facebook Video Downloader",
    backgroundColor: "#0a0a0a",
  });

  const isDev = !app.isPackaged;
  const url = isDev ? "http://localhost:3000" : "http://localhost:3000"; // Next.js standard port

  mainWindow.loadURL(url);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Start Next.js server if packaged
  if (app.isPackaged) {
    const nextPath = path.join(process.resourcesPath, "app", "node_modules", ".bin", "next");
    nextProcess = spawn(nextPath, ["start"], {
      cwd: path.join(process.resourcesPath, "app"),
      shell: true,
    });
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (nextProcess) nextProcess.kill();
    app.quit();
  }
});
