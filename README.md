# Postman Replicate

A new, offline desktop API client - written from scratch, with no Postman code.

## Run

    G:\Postman\Postman-Replicate.cmd

First run creates `replicate\runtime\` (an Electron runtime directory hardlinked
to the runtime already on this machine; Postman's `app.asar` is never linked or
loaded). All state lives in `replicate\data\`; deleting that folder resets the
app.

## Share as a Windows app

Build a portable folder and a zip using the local Electron runtime (no npm
packages or downloads):

    node tools/package-win.js

Or double-click `Pack-Windows.cmd` in this folder
(`..\Pack-Postman-Replicate.cmd` also works and forwards arguments).

Outputs:

    dist\Postman-Replicate-0.1.0-win64\
    dist\Postman-Replicate-0.1.0-win64.zip

Send the zip. The recipient extracts it and runs `Postman Replicate.exe`.
Collections, environments, history and settings are stored in the `data`
folder created next to the exe; `userdata` holds the Chromium profile. Delete
both to reset the app.

Use `--no-zip` to build only the folder. Use `--src <electron-dist-dir>` to
package from another Electron distribution instead of `runtime\`. This is a
portable folder build (one exe plus Electron DLLs/resources), not a single-file
installer; an installer/one-file exe needs a tool such as electron-builder.

## AI / automation

The app can be driven by external agents without Electron:

- `cli.js` — JSON CLI for collections, environments, sending requests and runs.
- `mcp-server.js` — MCP stdio server for Claude Desktop and other MCP clients.
- Full documentation: `docs/AI-INTEGRATION.md`.

Quick start:

    node cli.js list-collections
    node mcp-server.js

Both use `data\` by default; override with `--data <dir>` or
`POSTMAN_REPLICATE_DATA`. Close and reopen the desktop app after external edits.

## Features

- Request builder: method, URL, query params, headers, body (raw JSON/XML/text/JS,
  x-www-form-urlencoded, form-data with files, binary file, GraphQL), auth
  (Basic, Bearer, API key, pasted OAuth2 token).
- Response: status, time, size, timings, headers, set-cookies, pretty/raw/preview
  body, binary save-to-file, test results, console output.
- Collections: nested folders, **drag & drop reorder / move between collections / duplicate**, save/rename/delete, **descriptions with Markdown docs view**, import/export **Postman Collection v2.1**, **import Postman v1 and v2.0 collections and v1 workspace exports (collections + environments + globals)**, cURL import/export.
- **Collection Runner**: run a collection or folder with iterations, delay, order (as defined/random) and stop-on-failure, live progress + results table, JSON/HTML report export.
- Environments + globals with `{{variable}}` resolution, active-environment
  selector, script read/write.
- **TLS**: custom CA and client certificates (PEM cert+key or PKCS#12 with passphrase) per request, **per-request and global SSL verification bypass** for self-signed certificates, plus the verify-certificate toggle.
- History: every send stores **request and response** (status, time, size, headers, cookies, body up to 256 KB, test results, console); grouped by day, entries reopen the full request with the stored response restored, individually deletable.
- Pre-request + Tests scripts: sandboxed JS (`node:vm`, 5s limit) with a
  `pm.*` shim (`pm.environment`, `pm.globals`, `pm.variables`,
  `pm.collectionVariables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect`).
- Cookie jar, redirect following, TLS verification toggle (per request and global), timeout per request.
## Architecture

    main.js            Electron main: window, native menu, IPC, storage
    preload.js         contextBridge API (no node in the renderer)
    lib/engine.js      variable resolution, cookies, HTTP execution + timings
    lib/script.js      sandboxed pm.* script runner
    lib/io.js          Postman v2.1 + cURL import/export
    lib/store.js       atomic JSON persistence
    renderer/          UI (plain HTML/CSS/JS, no frameworks, no network)
    test/smoke.js      engine/library tests (node test/smoke.js)
    test/drive.js      end-to-end UI tests over CDP (see below)
    tools/make-runtime.js  builds the runtime directory

## Repository layout

Tracked source (everything needed for the project):

    .gitignore
    package.json  main.js  preload.js
    cli.js  mcp-server.js  Pack-Windows.cmd
    lib/          engine.js  script.js  io.js  store.js  agent.js
    renderer/     index.html  styles.css  app.js
    test/         smoke.js  drive.js  agent.js
    tools/        make-runtime.js  package-win.js
    docs/         AI-INTEGRATION.md
    README.md     MISSING-FEATURES.html

Generated locally and ignored by git:

    runtime/      Electron runtime dir (hardlinks/junctions; created on first launch)
    data/         collections, environments, history, settings, cookies
    userdata/     Electron/Chromium profile

## Why do folders in runtime/ show a shortcut arrow?

`tools/make-runtime.js` links instead of copying, so the ~225 MB Electron runtime
is not duplicated:

| entry | how it is created |
|---|---|
| `runtime\Postman.exe`, `*.dll`, `*.pak`, ... | **hard links** (same file records, no extra disk space, no overlay) |
| `runtime\locales` | **junction** to the Electron dist's `locales` |
| `runtime\resources\data` | **junction** to the dist's `resources\data` |
| `runtime\resources\app` | **junction** to this project folder, so Electron finds the app |

Windows Explorer shows junctions (and symlinks) with the shortcut overlay arrow.

Careful:
- deleting a junction removes only the link, not the linked folder;
- but deleting files *inside* `runtime\resources\app` deletes project files (it **is**
the project), and inside `runtime\resources\data` / `runtime\locales` deletes
Electron-dist files. Regenerate with `node tools/make-runtime.js` if needed.

Want no shortcuts at all? Use a self-contained copy instead:

    node tools/make-runtime.js --copy

That copies the runtime files and replaces the `resources\app` junction with a tiny
`loader.js` pointing at this project - no links anywhere, ~220 MB extra disk.
The mode is remembered in `.runtime-mode`, so if `runtime\` is deleted the launcher
recreates it the same way. This checkout is currently using **copy** mode.

## Requirements

- Node.js 18+ for `tools/` and `test/` (the app itself has no npm dependencies).
- An Electron distribution for the desktop shell. Point the runtime builder at any
  Electron install; unrelated app code (`app.asar`, `app`, `default_app.asar`) is
  never linked:

      node tools/make-runtime.js "C:\path\to\electron-dist"
      rem or: set ELECTRON_DIST=C:\path\to\electron-dist

## Version control

    git init
    git add .
    git commit -m "Postman Replicate v0.1"

`runtime/`, `data/` and `userdata/` are ignored, so the repository stays source-only.

## Verify

    node test/smoke.js
    Postman-Replicate.cmd --remote-debugging-port=9223
    node test/drive.js ws://127.0.0.1:9223/devtools/page/<id> http://127.0.0.1:8787

The drive test sends a live request, saves a collection, creates an environment
with a variable, runs tests scripts and reloads the window to check persistence.

## Notes

- Offline by design: the renderer makes no network calls; requests are executed
  in the main process and only target the URL you send.
- `replicate/runtime` contains only hardlinks/junctions to Electron runtime files
  (no copies), and explicitly excludes Postman's application bundle.
