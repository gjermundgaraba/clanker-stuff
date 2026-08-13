/* eslint-disable promise/prefer-await-to-callbacks */

import path from "node:path";
import { createInterface } from "node:readline";

import { app, BrowserWindow, ipcMain, session } from "electron";

let window;

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const trustedSender = (event) =>
  Boolean(window && event.sender === window.webContents);

ipcMain.handle("voice:research-config", (event) => {
  if (!trustedSender(event)) {
    return {};
  }
  return {
    trace: Boolean(process.env.PI_VOICE_TRACE_DIR),
  };
});

ipcMain.on("voice:message", (event, message) => {
  if (trustedSender(event) && message && typeof message === "object") {
    send(message);
  }
});

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type === "command" && message.command === "shutdown") {
    app.quit();
    return;
  }
  window?.webContents.send("voice:parent-message", message);
});

const createWindow = async () => {
  window = new BrowserWindow({
    acceptFirstMouse: true,
    alwaysOnTop: true,
    frame: false,
    hasShadow: false,
    height: 320,
    resizable: false,
    title: "Pi Voice",
    transparent: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
    },
    width: 320,
  });

  const contents = window.webContents;
  session.defaultSession.setPermissionCheckHandler(
    (requestingContents, permission) =>
      requestingContents === contents && permission === "media"
  );
  session.defaultSession.setPermissionRequestHandler(
    (requestingContents, permission, callback, details) => {
      const mediaTypes =
        "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      callback(
        requestingContents === contents &&
          permission === "media" &&
          mediaTypes.length > 0 &&
          mediaTypes.every((type) => type === "audio")
      );
    }
  );

  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  await window.loadFile(path.join(import.meta.dirname, "index.html"));
  send({ event: "ready", type: "event" });
};

const run = async () => {
  try {
    await app.whenReady();
    await createWindow();
  } catch (error) {
    send({
      event: "error",
      message: error instanceof Error ? error.message : String(error),
      type: "event",
    });
    app.quit();
  }
};

void run();

app.on("window-all-closed", () => {
  app.quit();
});
