import { app, BrowserWindow, Menu } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let nextProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 850,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    title: "Facebook Video Downloader Pro",
    backgroundColor: "#0a0a0a",
    icon: path.join(__dirname, "../public/favicon.ico"), // Use favicon if exists
  });

  // Hide the default menu bar in production
  if (app.isPackaged) {
    Menu.setApplicationMenu(null);
  }

  const isDev = !app.isPackaged;
  const url = isDev ? "http://localhost:3000" : "http://localhost:3000";

  // In production, we need to wait for the standalone server to start
  if (!isDev) {
    const checkServer = setInterval(async () => {
      try {
        const res = await fetch(url);
        if (res.ok) {
          clearInterval(checkServer);
          mainWindow.loadURL(url);
        }
      } catch (e) {
        // Server not ready yet
      }
    }, 500);
  } else {
    mainWindow.loadURL(url);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  if (app.isPackaged) {
    // Standalone Next.js server entry point
    const serverPath = path.join(process.resourcesPath, "app", ".next", "standalone", "server.js");
    
    if (fs.existsSync(serverPath)) {
      nextProcess = spawn("node", [serverPath], {
        env: { ...process.env, PORT: "3000", HOSTNAME: "localhost" },
        stdio: "inherit",
      });
    }
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
