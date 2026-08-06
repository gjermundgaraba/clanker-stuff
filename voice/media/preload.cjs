/** @type {typeof import("electron")} */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piVoice", {
  getResearchConfig() {
    return ipcRenderer.invoke("voice:research-config");
  },
  /** @param {(message: unknown) => void} listener - Receives parent messages. */
  onMessage(listener) {
    ipcRenderer.on("voice:parent-message", (_event, message) => {
      listener(message);
    });
  },
  send(message) {
    ipcRenderer.send("voice:message", message);
  },
});
