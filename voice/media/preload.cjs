/* eslint-disable typescript/no-unsafe-call */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("piVoice", {
  getResearchConfig() {
    return ipcRenderer.invoke("voice:research-config");
  },
  onMessage(listener) {
    ipcRenderer.on("voice:parent-message", (_event, message) => {
      listener(message);
    });
  },
  send(message) {
    ipcRenderer.send("voice:message", message);
  },
});
