"use strict";
const { app, BrowserWindow, ipcMain, dialog, Menu, shell, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { Store } = require("./lib/store");
const engine = require("./lib/engine");
const { runScript } = require("./lib/script");
const io = require("./lib/io");

const PACKAGED_LAYOUT = path.basename(path.dirname(__dirname)) === "resources";
const APP_ROOT = PACKAGED_LAYOUT
  ? path.resolve(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : __dirname;
const DATA_DIR = path.join(APP_ROOT, "data");
const PROFILE_DIR = path.join(APP_ROOT, "userdata");
const store = new Store(DATA_DIR);
let jar = null;
let mainWindow = null;

fs.mkdirSync(PROFILE_DIR, { recursive: true });
app.setPath("userData", PROFILE_DIR);
app.setName("Postman Replicate");

function getJar() {
  if (!jar) jar = new engine.CookieJar(store.load("cookies", []));
  return jar;
}

function persist(key, value) {
  store.save(key, value);
  return value;
}

/* ------------------------------------------------------------------ request */
function activeEnvironment() {
  const settings = store.load("settings", {});
  const environments = store.load("environments", []);
  return environments.find((e) => e.id === settings.activeEnvironmentId) || null;
}

function envToObject(env) {
  const out = {};
  if (!env) return out;
  for (const v of env.values || []) {
    if (v.enabled === false || !v.key) continue;
    out[v.key] = v.value;
  }
  return out;
}

async function handleSend(payload) {
  const request = payload && payload.request;
  if (!request) return { ok: false, error: { message: "No request supplied" } };
  const globals = store.load("globals", []);
  const env = activeEnvironment();
  const appSettings = store.load("settings", {});
  const collectionVariables = payload.collectionVariables || [];
  const session = payload.sessionVariables || {};

  const toObj = (list) => {
    const out = {};
    for (const v of list || []) {
      if (v && v.key) out[v.key] = v.value;
    }
    return out;
  };

  const scopes = [session, envToObject(env), toObj(collectionVariables), toObj(globals)];
  const logs = [];
  let testResults = [];
  let requestForSend = JSON.parse(JSON.stringify(request));

  if (request.scripts && request.scripts.preRequest) {
    const pre = runScript(request.scripts.preRequest, "prerequest", {
      environment: envToObject(env),
      globals: toObj(globals),
      collectionVariables: toObj(collectionVariables),
      sessionVariables: Object.assign({}, session),
      request: requestForSend,
      requestName: request.name,
    });
    logs.push(...pre.logs);
    if (pre.error) logs.push({ level: "error", message: "Pre-request script: " + pre.error });
    applyMutations(env, globals, pre);
    if (pre.requestMutations && pre.requestMutations.length) {
      requestForSend.headers = pre.requestMutations.map((h) => ({ key: h.key, value: h.value, enabled: true }));
    }
    Object.assign(session, pre.sessionVariables);
  }

  const response = await engine.execute(requestForSend, {
    scopes,
    jar: getJar(),
    settings: appSettings.bypassTls === true ? { verifyTls: false } : undefined,
  });

  if (response.ok && request.scripts && request.scripts.tests) {
    const post = runScript(request.scripts.tests, "tests", {
      environment: envToObject(env),
      globals: toObj(globals),
      collectionVariables: toObj(collectionVariables),
      sessionVariables: Object.assign({}, session),
      request: requestForSend,
      response,
      requestName: request.name,
    });
    testResults = post.results;
    logs.push(...post.logs);
    if (post.error) logs.push({ level: "error", message: "Test script: " + post.error });
    applyMutations(env, globals, post);
    Object.assign(session, post.sessionVariables);
  }

  persist("cookies", getJar().list());
  return {
    response,
    testResults,
    logs,
    environment: env || null,
    globals: store.load("globals", []),
    sessionVariables: session,
    request: requestForSend,
  };
}

function applyMutations(env, globals, result) {
  if (env && result.environment) {
    const environments = store.load("environments", []);
    const idx = environments.findIndex((e) => e.id === env.id);
    if (idx >= 0) {
      const map = result.environment;
      const values = (environments[idx].values || []).slice();
      for (const [key, value] of Object.entries(map)) {
        const found = values.find((v) => v.key === key);
        if (found) found.value = value;
        else values.push({ key, value, enabled: true, secret: false });
      }
      environments[idx].values = values;
      persist("environments", environments);
    }
  }
  if (result.globals) {
    const values = [];
    for (const [key, value] of Object.entries(result.globals)) values.push({ key, value, enabled: true });
    persist("globals", values);
  }
}

/* --------------------------------------------------------------- IPC wiring */
function registerIpc() {
  const windowFor = (event) => BrowserWindow.fromWebContents(event.sender);
  ipcMain.on("window:minimize", (event) => { const win = windowFor(event); if (win) win.minimize(); });
  ipcMain.on("window:toggle-maximize", (event) => {
    const win = windowFor(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("window:close", (event) => { const win = windowFor(event); if (win) win.close(); });
  ipcMain.handle("window:is-maximized", (event) => {
    const win = windowFor(event);
    return !!win && win.isMaximized();
  });

  ipcMain.handle("app:info", () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    platform: process.platform,
    electron: process.versions.electron,
  }));

  ipcMain.handle("store:loadAll", () => ({
    collections: store.load("collections", []),
    environments: store.load("environments", []),
    globals: store.load("globals", []),
    settings: store.load("settings", {}),
    history: store.load("history", []),
    session: store.load("session", null),
    cookies: getJar().list(),
  }));

  ipcMain.handle("store:save", (_e, payload) => {
    if (!payload || typeof payload.key !== "string") return null;
    return persist(payload.key, payload.value);
  });

  ipcMain.handle("req:send", (_e, payload) => handleSend(payload));
  ipcMain.handle("cookies:clear", () => {
    getJar().clear();
    persist("cookies", []);
    return [];
  });

  ipcMain.handle("script:run", (_e, payload) => {
    try {
      const env = activeEnvironment();
      return runScript(payload.code, payload.kind || "tests", {
        environment: envToObject(env),
        globals: (store.load("globals", []) || []).reduce((a, v) => (v && v.key ? ((a[v.key] = v.value), a) : a), {}),
        collectionVariables: payload.collectionVariables || {},
        sessionVariables: payload.sessionVariables || {},
        request: payload.request,
        response: payload.response,
        requestName: payload.requestName,
      });
    } catch (e) {
      return { results: [], logs: [], error: e.message };
    }
  });

  ipcMain.handle("io:import-postman", (_e, payload) => {
    try {
      return { ok: true, collection: io.importPostman(payload.text), ...io.importAny(payload.text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("io:import-any", (_e, payload) => {
    try {
      return { ok: true, ...io.importAny(payload.text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("io:export-postman", (_e, payload) => {
    try {
      return { ok: true, json: JSON.stringify(io.exportPostman(payload.collection), null, 2) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("io:parse-curl", (_e, payload) => {
    try {
      return { ok: true, request: io.parseCurl(payload.text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("io:build-curl", (_e, payload) => {
    try {
      return { ok: true, text: io.buildCurl(payload.request) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("io:pick-file-path", async (_e, payload) => {
    const opts = { properties: ["openFile"] };
    if (payload && payload.filters) opts.filters = payload.filters;
    const res = await dialog.showOpenDialog(mainWindow, opts);
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const filePath = res.filePaths[0];
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (_) {}
    return { ok: true, path: filePath, name: path.basename(filePath), size };
  });

  ipcMain.handle("app:open-external", (_e, url) => {
    if (/^https?:\/\//i.test(String(url || ""))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle("io:open-file", async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
    if (res.canceled || !res.filePaths.length) return { ok: false };
    const filePath = res.filePaths[0];
    const data = fs.readFileSync(filePath);
    return {
      ok: true,
      name: path.basename(filePath),
      path: filePath,
      size: data.length,
      dataBase64: data.toString("base64"),
    };
  });

  ipcMain.handle("io:save-file", async (_e, payload) => {
    const opts = Object.assign({ defaultPath: "response.txt" }, payload || {});
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: opts.defaultPath });
    if (res.canceled || !res.filePath) return { ok: false };
    if (opts.contentBase64) fs.writeFileSync(res.filePath, Buffer.from(opts.contentBase64, "base64"));
    else fs.writeFileSync(res.filePath, opts.content || "", "utf8");
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle("io:save-text", async (_e, payload) => {
    const res = await dialog.showSaveDialog(mainWindow, { defaultPath: payload.defaultPath || "data.json" });
    if (res.canceled || !res.filePath) return { ok: false };
    fs.writeFileSync(res.filePath, payload.content || "", "utf8");
    return { ok: true, path: res.filePath };
  });
}

/* -------------------------------------------------------------------- menu */
function buildMenu() {
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("menu", { channel, payload });
  };
  const template = [
    {
      label: "File",
      submenu: [
        { label: "New Request", accelerator: "CmdOrCtrl+N", click: () => send("new-request") },
        { label: "New Tab", accelerator: "CmdOrCtrl+T", click: () => send("new-tab") },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", click: () => send("close-tab") },
        { type: "separator" },
        { label: "Save Request", accelerator: "CmdOrCtrl+S", click: () => send("save-request") },
        { type: "separator" },
        { label: "Import cURL from Clipboard", click: () => send("import-curl") },
        { label: "Import Postman Collection...", click: () => send("import-postman") },
        { type: "separator" },
        { label: "Export Current Request as cURL", click: () => send("export-curl") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Toggle Dark/Light", accelerator: "CmdOrCtrl+Shift+D", click: () => send("toggle-theme") },
        { label: "Reset Layout", click: () => send("reset-layout") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "About Postman Replicate", click: () => send("about") },
        { label: "Open Data Folder", click: () => shell.openPath(DATA_DIR) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------- boot */
function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1400, workArea.width - 40),
    height: Math.min(880, workArea.height - 40),
    minWidth: 960,
    minHeight: 600,
    title: "Postman Replicate",
    backgroundColor: "#1c1c1c",
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  const sendWindowState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("window:state", { maximized: mainWindow.isMaximized() });
  };
  mainWindow.on("maximize", sendWindowState);
  mainWindow.on("unmaximize", sendWindowState);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(() => {
  registerIpc();
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
