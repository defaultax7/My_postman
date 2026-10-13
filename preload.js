"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  info: () => ipcRenderer.invoke("app:info"),
  store: {
    loadAll: () => ipcRenderer.invoke("store:loadAll"),
    save: (key, value) => ipcRenderer.invoke("store:save", { key, value }),
  },
  send: (payload) => ipcRenderer.invoke("req:send", payload),
  runScript: (payload) => ipcRenderer.invoke("script:run", payload),
  cookies: {
    clear: () => ipcRenderer.invoke("cookies:clear"),
  },
  io: {
    importPostman: (text) => ipcRenderer.invoke("io:import-postman", { text }),
    importAny: (text) => ipcRenderer.invoke("io:import-any", { text }),
    exportPostman: (collection) => ipcRenderer.invoke("io:export-postman", { collection }),
    parseCurl: (text) => ipcRenderer.invoke("io:parse-curl", { text }),
    buildCurl: (request) => ipcRenderer.invoke("io:build-curl", { request }),
    openFile: () => ipcRenderer.invoke("io:open-file"),
    pickFilePath: (payload) => ipcRenderer.invoke("io:pick-file-path", payload),
    saveFile: (payload) => ipcRenderer.invoke("io:save-file", payload),
    saveText: (payload) => ipcRenderer.invoke("io:save-text", payload),
    openExternal: (url) => ipcRenderer.invoke("app:open-external", url),
  },
  onMenu: (callback) => {
    ipcRenderer.on("menu", (_event, message) => callback(message));
  },
  platform: process.platform,
});
