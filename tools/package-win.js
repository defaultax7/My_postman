"use strict";
/* Builds a portable Windows folder and a shareable zip using a local Electron runtime.

   Usage:
     node tools/package-win.js
     node tools/package-win.js --src "C:\\path\\to\\electron-dist" [--out dist-dir] [--no-zip]

   The result is written to dist\\Postman-Replicate-<version>-win64\\. The app code is
   copied into resources\\app; user data is not included and is created next to the exe
   on first launch. */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith("--"));
const srcIndex = argv.indexOf("--src");
const outIndex = argv.indexOf("--out");
const requestedSource = srcIndex >= 0 ? argv[srcIndex + 1] : process.env.ELECTRON_DIST;
const requestedOut = outIndex >= 0 ? argv[outIndex + 1] : null;
if (srcIndex >= 0 && !requestedSource) {
  console.error("[package] --src requires an Electron distribution path.");
  process.exit(1);
}
if (outIndex >= 0 && !requestedOut) {
  console.error("[package] --out requires an output directory.");
  process.exit(1);
}
const noZip = flags.includes("--no-zip");

function fail(message) {
  console.error("[package] " + message);
  process.exit(1);
}

function isDist(dir) {
  return dir && fs.existsSync(dir) && fs.existsSync(path.join(dir, "resources")) &&
    (fs.existsSync(path.join(dir, "Postman.exe")) || fs.existsSync(path.join(dir, "electron.exe")));
}

const candidates = [
  requestedSource,
  path.join(projectRoot, "runtime"),
  path.join(projectRoot, "..", "app-11.94.0"),
  path.join(projectRoot, "..", "offline"),
].filter(Boolean);
const source = candidates.find(isDist);
if (!source) {
  fail("No Electron distribution found. Pass one with --src <electron-dist-dir>, or create runtime/ first.");
}

const folderName = `Postman-Replicate-${pkg.version}-win64`;
const outRoot = requestedOut ? path.resolve(projectRoot, requestedOut) : path.join(projectRoot, "dist");
const outDir = path.join(outRoot, folderName);
const zipPath = path.join(outRoot, folderName + ".zip");

if (path.resolve(source) === path.resolve(outDir)) fail("Source and output directories must differ.");

console.log("[package] source:", source);
console.log("[package] output:", outDir);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outRoot, { recursive: true });

const skip = (src) => {
  const rel = path.relative(source, src).split(path.sep).join("/");
  if (!rel) return true;
  if (rel === "resources/app" || rel.startsWith("resources/app/")) return false;
  if (rel === "resources/app.asar" || rel === "resources/default_app.asar") return false;
  if (rel === "debug.log" || /^Squirrel-/.test(rel)) return false;
  return true;
};

fs.cpSync(source, outDir, { recursive: true, filter: skip });
const sourceExe = fs.existsSync(path.join(outDir, "Postman.exe")) ? "Postman.exe" : "electron.exe";
fs.renameSync(path.join(outDir, sourceExe), path.join(outDir, "Postman Replicate.exe"));

const appDir = path.join(outDir, "resources", "app");
fs.mkdirSync(appDir, { recursive: true });
for (const file of ["main.js", "preload.js"]) {
  fs.copyFileSync(path.join(projectRoot, file), path.join(appDir, file));
}
for (const dir of ["lib", "renderer"]) {
  fs.cpSync(path.join(projectRoot, dir), path.join(appDir, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "postman-replicate",
      productName: "Postman Replicate",
      version: pkg.version,
      description: pkg.description,
      main: "main.js",
      private: true,
    },
    null,
    2
  ) + "\n"
);

fs.writeFileSync(
  path.join(outDir, "README.txt"),
  [
    "Postman Replicate " + pkg.version,
    "================================",
    "",
    "Run: Postman Replicate.exe",
    "",
    "Extract this folder to a writable location (for example Downloads or a",
    "folder under your user profile). Do not run it from inside the zip, and",
    "avoid Program Files: the app stores data next to the exe.",
    "",
    "This is a portable build. Collections, environments, history, cookies and",
    "settings are stored in the data folder created next to the exe. The userdata",
    "folder contains the Chromium profile/cache.",
    "",
    "To reset the app, close it and delete data and userdata.",
    "",
  ].join("\r\n")
);

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

console.log("[package] built folder:", folderName, "(" + mb(folderSize(outDir)) + ")");

if (!noZip) {
  fs.rmSync(zipPath, { force: true });
  const tarExe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  let ok = false;
  if (fs.existsSync(tarExe)) {
    const res = spawnSync(tarExe, ["-a", "-c", "-f", zipPath, "-C", outRoot, folderName], { stdio: "inherit" });
    ok = res.status === 0 && fs.existsSync(zipPath);
  }
  if (!ok) {
    const quote = (value) => "'" + value.replace(/'/g, "''") + "'";
    const command = `Compress-Archive -LiteralPath ${quote(outDir)} -DestinationPath ${quote(zipPath)} -Force`;
    const res = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
    ok = res.status === 0 && fs.existsSync(zipPath);
  }
  if (!ok) fail("Folder was built, but creating the zip failed.");
  console.log("[package] zip:", zipPath, "(" + mb(fs.statSync(zipPath).size) + ")");
}
