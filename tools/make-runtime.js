"use strict";
/* Creates replicate/runtime: an Electron runtime directory for the replicate app.
   Files are hardlinked and directories junctioned to an existing Electron
   distribution so no space is duplicated and no unrelated app code is linked
   (app.asar / app / default_app.asar are deliberately excluded).

   Usage:
     node tools/make-runtime.js [path-to-electron-dist]
     ELECTRON_DIST=C:\path\to\electron  node tools/make-runtime.js

   Without an argument it looks for ../app-11.94.0 or ../offline next to the
   project (i.e. a Postman installation next to this folder). */
const fs = require("fs");
const path = require("path");

const repsRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(repsRoot, "..");
const candidates = [
  process.argv[2],
  process.env.ELECTRON_DIST,
  path.join(projectRoot, "app-11.94.0"),
  path.join(projectRoot, "offline"),
].filter(Boolean);
const source = candidates.find((p) => fs.existsSync(path.join(p, "Postman.exe")) || fs.existsSync(path.join(p, "electron.exe")));
const runtime = path.join(repsRoot, "runtime");

if (!source) {
  console.error(
    "[runtime] Electron distribution not found.\n" +
      "          Pass one: node tools/make-runtime.js <electron-dist-dir>\n" +
      "          or set ELECTRON_DIST. Tried:\n  " + candidates.join("\n  ")
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(repsRoot, "main.js"))) {
  console.error("[runtime] replicate/main.js missing next to this script.");
  process.exit(1);
}

const SKIP_RESOURCES = new Set(["app.asar", "app", "default_app.asar"]);

function link(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.symlinkSync(src, dest, "junction");
    return;
  }
  if (fs.existsSync(dest)) return;
  fs.linkSync(src, dest);
}

fs.mkdirSync(runtime, { recursive: true });
for (const entry of fs.readdirSync(source)) {
  if (entry === "resources") continue;
  if (entry === "debug.log" || entry.startsWith("Squirrel-")) continue;
  link(path.join(source, entry), path.join(runtime, entry));
}
fs.mkdirSync(path.join(runtime, "resources"), { recursive: true });
for (const entry of fs.readdirSync(path.join(source, "resources"))) {
  if (SKIP_RESOURCES.has(entry)) continue; // no unrelated app code is ever linked
  link(path.join(source, "resources", entry), path.join(runtime, "resources", entry));
}

// The launcher expects Postman.exe; accept a plain Electron distribution too.
const runtimeExe = path.join(runtime, "Postman.exe");
if (!fs.existsSync(runtimeExe) && fs.existsSync(path.join(runtime, "electron.exe"))) {
  fs.linkSync(path.join(runtime, "electron.exe"), runtimeExe);
}

// Expose this app to the Electron runtime as resources/app (junction, no copy).
const appLink = path.join(runtime, "resources", "app");
if (fs.existsSync(appLink)) fs.rmSync(appLink, { recursive: true, force: true });
fs.symlinkSync(repsRoot, appLink, "junction");

console.log("[runtime] Electron runtime ready:", runtime);
console.log("[runtime] source:", source, "(app code excluded)");
console.log("[runtime] app:", appLink, "->", repsRoot);
