# Postman Replicate

A new, offline desktop API client - written from scratch, with no Postman code.

## Run

    G:\Postman\Postman-Replicate.cmd

First run creates `replicate\runtime\` (an Electron runtime directory hardlinked
to the runtime already on this machine; Postman's `app.asar` is never linked or
loaded). All state lives in `replicate\data\`; deleting that folder resets the
app.

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
- **TLS**: custom CA and client certificates (PEM cert+key or PKCS#12 with passphrase) per request, plus the verify-certificate toggle.
- History: every send stores **request and response** (status, time, size, headers, cookies, body up to 256 KB, test results, console); grouped by day, entries reopen the full request with the stored response restored, individually deletable.
- Pre-request + Tests scripts: sandboxed JS (`node:vm`, 5s limit) with a
  `pm.*` shim (`pm.environment`, `pm.globals`, `pm.variables`,
  `pm.collectionVariables`, `pm.request`, `pm.response`, `pm.test`, `pm.expect`).
- Cookie jar, redirect following, TLS verification toggle, timeout per request.
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
    lib/          engine.js  script.js  io.js  store.js
    renderer/     index.html  styles.css  app.js
    test/         smoke.js  drive.js
    tools/        make-runtime.js
    README.md     MISSING-FEATURES.html

Generated locally and ignored by git:

    runtime/      Electron runtime dir (hardlinks/junctions; created on first launch)
    data/         collections, environments, history, settings, cookies
    userdata/     Electron/Chromium profile

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
