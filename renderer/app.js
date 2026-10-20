"use strict";
/* Postman Replicate - renderer (new implementation, no Postman code). */

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "value") node.value = v;
    else if (k === "checked") node.checked = !!v;
    else if (k === "disabled") node.disabled = !!v;
    else if (k === "selected") node.selected = !!v;
    else if (k === "html") node.innerHTML = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

let uidCounter = 0;
const uid = (p) => `${p || "id"}-${Date.now().toString(36)}-${(uidCounter++).toString(36)}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const fmtTime = (ms) => (ms == null ? "-" : ms < 1 ? "<1 ms" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtSize = (n) => {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};

function toast(message, type) {
  const node = h("div", { class: "toast" + (type ? " " + type : "") }, message);
  $("#toast-root").appendChild(node);
  setTimeout(() => node.remove(), type === "error" ? 6000 : 3200);
}

function blankRequest(name) {
  return {
    id: uid("req"),
    name: name || "Untitled Request",
    description: "",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none", raw: { language: "json", text: "" }, urlencoded: [], formdata: [], file: null, graphql: { query: "", variables: "" } },
    auth: { type: "none", basic: { username: "", password: "" }, bearer: { token: "" }, apikey: { key: "", value: "", in: "header" }, oauth2: { token: "", headerPrefix: "Bearer" } },
    scripts: { preRequest: "", tests: "" },
    settings: {
      followRedirects: true,
      verifyTls: true,
      timeoutMs: 30000,
      sendCookies: true,
      tls: { clientCert: false, type: "pem", certPath: "", keyPath: "", pfxPath: "", passphrase: "", caPath: "" },
    },
  };
}

function normalizeRequest(r) {
  const src = r && typeof r === "object" ? r : {};
  const defaults = blankRequest();
  const out = Object.assign({}, defaults, src);
  const srcBody = src.body && typeof src.body === "object" ? src.body : {};
  out.body = Object.assign({}, defaults.body, srcBody);
  out.body.raw = Object.assign({}, defaults.body.raw, srcBody.raw || {});
  out.body.graphql = Object.assign({}, defaults.body.graphql, srcBody.graphql || {});
  out.auth = Object.assign({}, defaults.auth, src.auth || {});
  out.auth.basic = Object.assign({}, defaults.auth.basic, (src.auth && src.auth.basic) || {});
  out.auth.bearer = Object.assign({}, defaults.auth.bearer, (src.auth && src.auth.bearer) || {});
  out.auth.apikey = Object.assign({}, defaults.auth.apikey, (src.auth && src.auth.apikey) || {});
  out.auth.oauth2 = Object.assign({}, defaults.auth.oauth2, (src.auth && src.auth.oauth2) || {});
  out.scripts = Object.assign({}, defaults.scripts, src.scripts || {});
  const srcSettings = src.settings && typeof src.settings === "object" ? src.settings : {};
  out.settings = Object.assign({}, defaults.settings, srcSettings);
  out.settings.tls = Object.assign({}, defaults.settings.tls, srcSettings.tls || {});
  if (!out.description) out.description = "";
  for (const key of ["params", "headers"]) if (!Array.isArray(out[key])) out[key] = [];
  for (const key of ["urlencoded", "formdata"]) if (!Array.isArray(out.body[key])) out.body[key] = [];
  return out;
}

/* -------------------------------------------------------------------- state */
const S = {
  collections: [],
  environments: [],
  globals: [],
  history: [],
  settings: { theme: "dark", activeEnvironmentId: null, requestPaneHeight: null },
  tabs: [],
  activeTabId: null,
  activePanel: "collections",
  info: null,
  sidebarCollapsed: false,
};

function activeTab() {
  return S.tabs.find((t) => t.id === S.activeTabId) || null;
}

function markDirty(tab) {
  if (!tab) tab = activeTab();
  if (!tab) return;
  tab.dirty = true;
  renderTabs();
  scheduleSessionSave();
}

/* -------------------------------------------------------------- persistence */
let sessionTimer = null;
function scheduleSessionSave() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(saveSession, 600);
}

function saveSession() {
  const session = {
    activeTabId: S.activeTabId,
    tabs: S.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      request: t.request,
      saved: t.saved || null,
      dirty: t.dirty || false,
    })),
  };
  return api.store.save("session", session);
}
function saveSettings() { return api.store.save("settings", S.settings); }
function saveCollections() { return api.store.save("collections", S.collections); }
function saveEnvironments() { return api.store.save("environments", S.environments); }
function saveGlobals() { return api.store.save("globals", S.globals); }
function saveHistory() { return api.store.save("history", S.history); }

/* -------------------------------------------------------------------- theme */
function applyTheme() {
  document.body.className = S.settings.theme === "light" ? "theme-light" : "theme-dark";
}

/* --------------------------------------------------------------------- tabs */
function newTab(request, options) {
  const opts = options || {};
  const tab = {
    id: uid("tab"),
    name: opts.name || (request && request.name) || "Untitled Request",
    request: normalizeRequest(request || blankRequest()),
    response: null,
    testResults: [],
    logs: [],
    sessionVariables: {},
    saved: opts.saved || null,
    dirty: false,
  };
  S.tabs.push(tab);
  S.activeTabId = tab.id;
  renderAll();
  scheduleSessionSave();
  return tab;
}

function closeTab(id) {
  const idx = S.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  S.tabs.splice(idx, 1);
  if (S.activeTabId === id) {
    const next = S.tabs[Math.min(idx, S.tabs.length - 1)];
    S.activeTabId = next ? next.id : null;
  }
  if (!S.tabs.length) newTab();
  else renderAll();
  scheduleSessionSave();
}

function openInTab(request, options) {
  newTab(clone(request), options);
}

/* ------------------------------------------------------------- kv table UI */
function kvTable(container, list, opts) {
  opts = opts || {};
  container.textContent = "";
  const table = h("table", { class: "kv-table" });
  table.appendChild(
    h("tr", {}, h("th", {}), h("th", { text: opts.keyLabel || "Key" }), h("th", { text: opts.valueLabel || "Value" }), h("th", {}))
  );
  list.forEach((row, index) => {
    const tr = h("tr", { class: row.enabled === false ? "disabled" : "" });
    const check = h("input", {
      type: "checkbox",
      checked: row.enabled !== false,
      onchange: (e) => {
        row.enabled = e.target.checked;
        tr.className = row.enabled ? "" : "disabled";
        markDirty();
      },
    });
    const keyVal = Object.prototype.hasOwnProperty.call(opts, "keyValue") ? opts.keyValue(row) : row.key;
    const keyInput = h("input", {
      type: "text",
      value: keyVal == null ? "" : keyVal,
      placeholder: opts.keyPlaceholder || "key",
      oninput: (e) => { opts.onKey ? opts.onKey(row, e.target.value) : (row.key = e.target.value); markDirty(); },
      onchange: opts.onChange,
    });
    let valueNode;
    if (opts.renderValue) {
      valueNode = opts.renderValue(row, tr);
    } else {
      const valVal = Object.prototype.hasOwnProperty.call(opts, "valueValue") ? opts.valueValue(row) : row.value;
      valueNode = h("input", {
        type: "text",
        value: valVal == null ? "" : valVal,
        placeholder: opts.valuePlaceholder || "value",
        oninput: (e) => { opts.onValue ? opts.onValue(row, e.target.value) : (row.value = e.target.value); markDirty(); },
        onchange: opts.onChange,
      });
    }
    const remove = h("button", {
      class: "icon",
      title: "Remove",
      text: "✕",
      onclick: () => {
        list.splice(index, 1);
        if (opts.afterChange) opts.afterChange();
        kvTable(container, list, opts);
        markDirty();
      },
    });
    tr.appendChild(h("td", { class: "check" }, check));
    tr.appendChild(h("td", {}, keyInput));
    tr.appendChild(h("td", {}, valueNode));
    tr.appendChild(h("td", { class: "actions" }, remove));
    table.appendChild(tr);
  });
  container.appendChild(table);
  container.appendChild(
    h("button", {
      class: "ghost",
      text: opts.addLabel || "+ Add",
      onclick: () => {
        list.push(opts.newRow ? opts.newRow() : { key: "", value: "", enabled: true });
        if (opts.afterChange) opts.afterChange();
        kvTable(container, list, opts);
        markDirty();
      },
    })
  );
}

/* ------------------------------------------------------------- request pane */
const REQUEST_TABS = ["params", "authorization", "headers", "body", "pre-request script", "tests", "settings"];

function renderRequestTabs() {
  const t = activeTab();
  const wrap = $("#request-tabs");
  wrap.textContent = "";
  const counts = {
    params: (t.request.params || []).filter((p) => p.key || p.value).length,
    headers: (t.request.headers || []).filter((p) => p.key || p.value).length,
    body: t.request.body.mode !== "none" ? 1 : 0,
  };
  REQUEST_TABS.forEach((label) => {
    const key = label.replace(/[ -]/g, "");
    const isActive = (t.requestSubTab || "params") === key;
    wrap.appendChild(
      h(
        "button",
        { class: isActive ? "active" : "", onclick: () => { t.requestSubTab = key; renderRequestPane(); } },
        label.replace(/\b\w/g, (c) => c.toUpperCase()),
        counts[key] ? h("span", { class: "count", text: " " + counts[key] }) : null
      )
    );
  });
}

function renderRequestPane() {
  const t = activeTab();
  if (!t) return;
  $("#method").value = t.request.method;
  $("#method").dataset.method = t.request.method;
  $("#url").value = t.request.url;
  renderRequestTabs();
  const body = $("#request-body");
  body.textContent = "";
  const sub = t.requestSubTab || "params";
  if (sub === "params") renderParams(body, t);
  else if (sub === "authorization") renderAuth(body, t);
  else if (sub === "headers") renderHeaders(body, t);
  else if (sub === "body") renderBody(body, t);
  else if (sub === "prerequestscript") renderScripts(body, t, "preRequest", "Pre-request Script");
  else if (sub === "tests") renderScripts(body, t, "tests", "Tests");
  else if (sub === "settings") renderSettings(body, t);
}

function renderParams(root, t) {
  root.appendChild(
    h("div", { class: "hint", text: "Query parameters are merged with the URL. {{variables}} are resolved on send." })
  );
  const wrap = h("div");
  root.appendChild(wrap);
  kvTable(wrap, t.request.params, {
    keyPlaceholder: "parameter",
    addLabel: "+ Add parameter",
    onChange: () => syncParamsToUrl(t),
    afterChange: () => syncParamsToUrl(t),
  });
}

function syncParamsToUrl(t) {
  try {
    const enabled = (t.request.params || []).filter((p) => p.enabled !== false && (p.key || p.value));
    const base = (t.request.url || "").split("?")[0];
    if (!enabled.length) {
      t.request.url = base;
    } else {
      const usp = new URLSearchParams();
      enabled.forEach((p) => usp.append(p.key, p.value));
      t.request.url = base + "?" + usp.toString();
    }
    if (S.activeTabId === t.id) $("#url").value = t.request.url;
    markDirty(t);
  } catch (_) {}
}

function renderHeaders(root, t) {
  root.appendChild(h("div", { class: "hint", text: "Content-Type and Authorization are added automatically for the matching body/auth modes unless set here." }));
  const wrap = h("div");
  root.appendChild(wrap);
  kvTable(wrap, t.request.headers, { keyPlaceholder: "header", addLabel: "+ Add header" });
}

function renderAuth(root, t) {
  const auth = t.request.auth;
  const typeSel = h(
    "select",
    {
      onchange: (e) => { auth.type = e.target.value; markDirty(t); renderRequestPane(); },
    },
    ...["none", "basic", "bearer", "apikey", "oauth2"].map((v) => h("option", { value: v, selected: auth.type === v }, v))
  );
  root.appendChild(h("div", { class: "field-row" }, h("label", { text: "Type" }), typeSel));
  const field = (label, obj, key, type) =>
    root.appendChild(
      h(
        "div",
        { class: "field-row" },
        h("label", { text: label }),
        h("input", {
          type: type || "text",
          value: obj[key] == null ? "" : obj[key],
          oninput: (e) => { obj[key] = e.target.value; markDirty(t); },
        })
      )
    );
  if (auth.type === "basic") {
    field("Username", auth.basic, "username");
    field("Password", auth.basic, "password", "password");
  } else if (auth.type === "bearer") {
    field("Token", auth.bearer, "token");
  } else if (auth.type === "apikey") {
    field("Key", auth.apikey, "key");
    field("Value", auth.apikey, "value");
    root.appendChild(
      h(
        "div",
        { class: "field-row" },
        h("label", { text: "Add to" }),
        h(
          "select",
          { onchange: (e) => { auth.apikey.in = e.target.value; markDirty(t); } },
          h("option", { value: "header", selected: auth.apikey.in !== "query" }, "Header"),
          h("option", { value: "query", selected: auth.apikey.in === "query" }, "Query param")
        )
      )
    );
  } else if (auth.type === "oauth2") {
    field("Token", auth.oauth2, "token");
    field("Header prefix", auth.oauth2, "headerPrefix");
    root.appendChild(h("div", { class: "hint", text: "Offline mode: paste an OAuth2 access token. No browser sign-in flow is performed." }));
  } else {
    root.appendChild(h("div", { class: "hint", text: "No authentication for this request." }));
  }
}

function renderBody(root, t) {
  const body = t.request.body;
  const modes = [["none", "none"], ["raw", "raw"], ["urlencoded", "x-www-form-urlencoded"], ["formdata", "form-data"], ["file", "binary file"], ["graphql", "GraphQL"]];
  root.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h("label", { class: "hint", text: "Body type:" }),
      h(
        "select",
        { onchange: (e) => { body.mode = e.target.value; markDirty(t); renderRequestPane(); } },
        ...modes.map(([v, label]) => h("option", { value: v, selected: body.mode === v }, label))
      )
    )
  );
  if (body.mode === "none") {
    root.appendChild(h("div", { class: "empty-state", text: "This request has no body." }));
  } else if (body.mode === "raw") {
    const langs = ["json", "text", "javascript", "xml", "html"];
    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "hint", text: "Language:" }),
        h(
          "select",
          { onchange: (e) => { body.raw.language = e.target.value; markDirty(t); } },
          ...langs.map((l) => h("option", { value: l, selected: body.raw.language === l }, l))
        )
      )
    );
    root.appendChild(
      h("textarea", {
        class: "code",
        value: body.raw.text || "",
        spellcheck: "false",
        oninput: (e) => { body.raw.text = e.target.value; markDirty(t); },
      })
    );
  } else if (body.mode === "urlencoded") {
    const wrap = h("div");
    root.appendChild(wrap);
    kvTable(wrap, body.urlencoded, { addLabel: "+ Add field", keyPlaceholder: "field" });
  } else if (body.mode === "formdata") {
    const wrap = h("div");
    root.appendChild(wrap);
    const renderFormValue = (row, tr) => {
      if (row.type === "file") {
        return h(
          "div",
          { class: "toolbar", style: "margin:0" },
          h("span", { class: "hint", text: row.filename ? row.filename + (row.dataBase64 ? "" : " (path only)") : "no file" }),
          h("button", {
            class: "ghost",
            text: "Choose…",
            onclick: async () => {
              const res = await api.io.openFile();
              if (!res.ok) return;
              row.filename = res.name;
              row.path = res.path;
              row.dataBase64 = res.dataBase64;
              markDirty(t);
              renderRequestPane();
            },
          })
        );
      }
      return h("input", { type: "text", value: row.value || "", oninput: (e) => { row.value = e.target.value; markDirty(t); } });
    };
    kvTable(wrap, body.formdata, {
      addLabel: "+ Add field",
      keyPlaceholder: "field",
      renderValue: renderFormValue,
      newRow: () => ({ key: "", value: "", type: "text", enabled: true }),
    });
    body.formdata.forEach((row, i) => {
      const tr = wrap.querySelectorAll("tr")[i + 1];
      if (!tr) return;
      const typeCell = document.createElement("td");
      const sel = h(
        "select",
        { onchange: (e) => { row.type = e.target.value; markDirty(t); renderRequestPane(); } },
        h("option", { value: "text", selected: row.type !== "file" }, "text"),
        h("option", { value: "file", selected: row.type === "file" }, "file")
      );
      typeCell.appendChild(sel);
      tr.insertBefore(typeCell, tr.children[2]);
    });
  } else if (body.mode === "file") {
    body.file = body.file || { filename: "", path: "", dataBase64: null };
    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("span", { class: "hint", text: body.file.filename || "No file selected" }),
        h("button", {
          class: "ghost",
          text: "Choose file…",
          onclick: async () => {
            const res = await api.io.openFile();
            if (!res.ok) return;
            body.file = { filename: res.name, path: res.path, dataBase64: res.dataBase64 };
            markDirty(t);
            renderRequestPane();
          },
        })
      )
    );
    root.appendChild(h("div", { class: "hint", text: "The file is sent as the raw request body (base64 read at save/choose time)." }));
  } else if (body.mode === "graphql") {
    root.appendChild(h("label", { class: "hint", text: "Query" }));
    root.appendChild(
      h("textarea", {
        class: "code",
        value: body.graphql.query || "",
        spellcheck: "false",
        oninput: (e) => { body.graphql.query = e.target.value; markDirty(t); },
      })
    );
    root.appendChild(h("label", { class: "hint", text: "Variables (JSON)" }));
    root.appendChild(
      h("textarea", {
        class: "code",
        style: "min-height:110px",
        value: body.graphql.variables || "",
        spellcheck: "false",
        oninput: (e) => { body.graphql.variables = e.target.value; markDirty(t); },
      })
    );
  }
}

function renderScripts(root, t, key, title) {
  root.appendChild(
    h("div", { class: "hint", text: `${title}: sandboxed JavaScript with a pm.* shim (pm.environment, pm.globals, pm.variables, pm.request, pm.response, pm.test, pm.expect). Runs offline, 5s limit.` })
  );
  root.appendChild(
    h("textarea", {
      class: "code",
      spellcheck: "false",
      value: t.request.scripts[key] || "",
      oninput: (e) => { t.request.scripts[key] = e.target.value; markDirty(t); },
    })
  );
}

function renderSettings(root, t) {
  const st = t.request.settings;
  const check = (label, key) =>
    root.appendChild(
      h(
        "div",
        { class: "field-row" },
        h("label", { text: label }),
        h("input", {
          type: "checkbox",
          style: "flex:0",
          checked: st[key] !== false,
          onchange: (e) => { st[key] = e.target.checked; markDirty(t); },
        })
      )
    );
  check("Follow redirects", "followRedirects");
  check("Send cookies from jar", "sendCookies");
  check("Verify TLS certificate", "verifyTls");
  root.appendChild(
    h(
      "div",
      { class: "field-row" },
      h("label", { text: "Timeout (ms)" }),
      h("input", {
        type: "number",
        value: st.timeoutMs || 30000,
        style: "flex:0;width:120px",
        oninput: (e) => { st.timeoutMs = Math.max(1, parseInt(e.target.value, 10) || 30000); markDirty(t); },
      })
    )
  );
  renderTlsSettings(root, t);
}

function pickTlsFile(t, apply) {
  api.io.pickFilePath().then((res) => {
    if (!res.ok) return;
    apply(res.path);
    markDirty(t);
    renderRequestPane();
  });
}

function fileRow(label, value, onPick, onClear) {
  return h(
    "div",
    { class: "field-row" },
    h("label", { text: label }),
    h("span", { class: "path-chip", title: value || "", text: value || "(not set)" }),
    h("button", { class: "ghost", text: "Choose…", onclick: onPick }),
    value ? h("button", { class: "icon", text: "✕", title: "Clear", onclick: onClear }) : null
  );
}

function renderTlsSettings(root, t) {
  const tls = t.request.settings.tls;
  root.appendChild(h("h4", { class: "section-title", text: "Client certificate & custom CA" }));
  root.appendChild(
    h(
      "div",
      { class: "field-row" },
      h("label", { text: "Use client certificate" }),
      h("input", {
        type: "checkbox",
        style: "flex:0",
        checked: !!tls.clientCert,
        onchange: (e) => { tls.clientCert = e.target.checked; markDirty(t); renderRequestPane(); },
      })
    )
  );
  if (tls.clientCert) {
    root.appendChild(
      h(
        "div",
        { class: "field-row" },
        h("label", { text: "Certificate type" }),
        h(
          "select",
          { style: "flex:0;width:180px", onchange: (e) => { tls.type = e.target.value; markDirty(t); renderRequestPane(); } },
          h("option", { value: "pem", selected: tls.type !== "pfx" }, "PEM (cert + key)"),
          h("option", { value: "pfx", selected: tls.type === "pfx" }, "PKCS#12 (.p12/.pfx)")
        )
      )
    );
    if (tls.type === "pfx") {
      root.appendChild(fileRow("PKCS#12 file", tls.pfxPath, () => pickTlsFile(t, (p) => (tls.pfxPath = p)), () => { tls.pfxPath = ""; markDirty(t); renderRequestPane(); }));
      root.appendChild(
        h(
          "div",
          { class: "field-row" },
          h("label", { text: "Passphrase" }),
          h("input", { type: "password", value: tls.passphrase || "", style: "flex:0;width:220px", oninput: (e) => { tls.passphrase = e.target.value; markDirty(t); } })
        )
      );
    } else {
      root.appendChild(fileRow("Certificate (PEM)", tls.certPath, () => pickTlsFile(t, (p) => (tls.certPath = p)), () => { tls.certPath = ""; markDirty(t); renderRequestPane(); }));
      root.appendChild(fileRow("Private key (PEM)", tls.keyPath, () => pickTlsFile(t, (p) => (tls.keyPath = p)), () => { tls.keyPath = ""; markDirty(t); renderRequestPane(); }));
      root.appendChild(
        h(
          "div",
          { class: "field-row" },
          h("label", { text: "Key passphrase" }),
          h("input", { type: "password", value: tls.passphrase || "", style: "flex:0;width:220px", oninput: (e) => { tls.passphrase = e.target.value; markDirty(t); } })
        )
      );
    }
  }
  root.appendChild(fileRow("Custom CA (PEM)", tls.caPath, () => pickTlsFile(t, (p) => (tls.caPath = p)), () => { tls.caPath = ""; markDirty(t); renderRequestPane(); }));
  root.appendChild(h("div", { class: "hint", text: "Files are read by the main process when the request is sent. PEM = certificate + private key; PKCS#12 = .p12/.pfx bundle." }));
}

/* ------------------------------------------------------------ response pane */
const RESPONSE_TABS = [["body", "Body"], ["headers", "Headers"], ["cookies", "Cookies"], ["tests", "Test Results"], ["console", "Console"]];

function renderResponse() {
  const t = activeTab();
  const meta = $("#response-meta");
  const bodyEl = $("#response-body");
  const tabsEl = $("#response-tabs");
  tabsEl.textContent = "";
  if (!t || !t.response) {
    meta.className = "empty";
    meta.textContent = "Send a request to see the response";
    bodyEl.className = "empty-body";
    bodyEl.textContent = "";
    return;
  }
  const r = t.response;
  meta.className = "";
  meta.textContent = "";
  if (r.ok) {
    const cls = r.status < 300 ? "ok" : r.status < 400 ? "warn" : "err";
    meta.appendChild(h("span", { class: "badge " + cls, text: `${r.status} ${r.statusText || ""}`.trim() }));
    meta.appendChild(h("span", { text: fmtTime(r.timings && r.timings.total) }));
    meta.appendChild(h("span", { text: fmtSize(r.body && r.body.size) }));
    if (r.body && r.body.truncated) meta.appendChild(h("span", { class: "badge warn", text: "truncated" }));
    if (r.redirects && r.redirects.length) meta.appendChild(h("span", { class: "hint", text: `${r.redirects.length} redirect(s)` }));
    if (t.historyTime) meta.appendChild(h("span", { class: "badge warn", title: "Response loaded from history", text: "history " + new Date(t.historyTime).toLocaleTimeString() }));
    meta.appendChild(h("span", { class: "hint", text: r.url || "" }));
  } else {
    meta.appendChild(h("span", { class: "badge err", text: "Error" }));
    meta.appendChild(h("span", { text: (r.error && r.error.message) || "Request failed" }));
  }

  const active = t.responseSubTab || "body";
  RESPONSE_TABS.forEach(([key, label]) => {
    let count = null;
    if (key === "headers" && r.ok) count = r.headers.length;
    if (key === "cookies" && r.ok) count = (r.cookies || []).length;
    if (key === "tests") count = (t.testResults || []).length;
    if (key === "console") count = (t.logs || []).length;
    tabsEl.appendChild(
      h(
        "button",
        { class: active === key ? "active" : "", onclick: () => { t.responseSubTab = key; renderResponse(); } },
        label,
        count ? h("span", { class: "count", text: " " + count }) : null
      )
    );
  });

  bodyEl.className = "";
  bodyEl.textContent = "";
  if (!r.ok) {
    bodyEl.appendChild(h("div", { class: "banner err", text: (r.error && (r.error.code ? r.error.code + ": " : "") + r.error.message) || "Request failed" }));
    if (r.timings) bodyEl.appendChild(h("div", { class: "hint", text: "Time: " + fmtTime(r.timings.total) }));
  } else if (active === "body") {
    renderResponseBody(bodyEl, t, r);
  } else if (active === "headers") {
    const table = h("table", { class: "kv-table" });
    table.appendChild(h("tr", {}, h("th", { text: "Header" }), h("th", { text: "Value" })));
    (r.headers || []).forEach((header) =>
      table.appendChild(h("tr", {}, h("td", { html: esc(header.key) }), h("td", { html: `<span class="code-view">${esc(header.value)}</span>` })))
    );
    bodyEl.appendChild(table);
  } else if (active === "cookies") {
    if (!(r.cookies || []).length) bodyEl.appendChild(h("div", { class: "empty-state", text: "No cookies set by this response." }));
    else {
      const table = h("table", { class: "kv-table" });
      table.appendChild(h("tr", {}, h("th", { text: "Set-Cookie" })));
      r.cookies.forEach((c) => table.appendChild(h("tr", {}, h("td", { html: `<span class="code-view">${esc(c)}</span>` }))));
      bodyEl.appendChild(table);
    }
    bodyEl.appendChild(
      h("button", { class: "ghost", text: "Clear cookie jar", onclick: async () => { await api.cookies.clear(); toast("Cookie jar cleared", "ok"); } })
    );
  } else if (active === "tests") {
    if (!(t.testResults || []).length) bodyEl.appendChild(h("div", { class: "empty-state", text: "No tests were executed for this request." }));
    (t.testResults || []).forEach((res) =>
      bodyEl.appendChild(
        h("div", { class: "test-row " + (res.passed ? "pass" : "fail") }, h("b", { text: res.passed ? "PASS " : "FAIL " }), res.name, res.error ? h("div", { class: "hint", text: res.error }) : null)
      )
    );
  } else if (active === "console") {
    if (!(t.logs || []).length) bodyEl.appendChild(h("div", { class: "empty-state", text: "No console output." }));
    (t.logs || []).forEach((log) => bodyEl.appendChild(h("div", { class: "log-line " + log.level, text: `[${log.level}] ${log.message}` })));
  }
}

function highlightJson(text) {
  const safe = esc(text);
  return safe.replace(
    /(&quot;(?:\\.|[^&])*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str, colon, bool, num) => {
      if (str) return colon ? `<span style="color:#9cdcfe">${str}</span>${colon}` : `<span style="color:#6bd968">${str}</span>`;
      if (bool) return `<span style="color:#e6c84a">${bool}</span>`;
      if (num) return `<span style="color:#b5cea8">${num}</span>`;
      return m;
    }
  );
}

function renderResponseBody(root, t, r) {
  const view = t.responseView || "pretty";
  const toolbar = h(
    "div",
    { class: "toolbar" },
    h("button", { class: view === "pretty" ? "" : "ghost", text: "Pretty", onclick: () => { t.responseView = "pretty"; renderResponse(); } }),
    h("button", { class: view === "raw" ? "" : "ghost", text: "Raw", onclick: () => { t.responseView = "raw"; renderResponse(); } }),
    h("button", { class: view === "preview" ? "" : "ghost", text: "Preview", onclick: () => { t.responseView = "preview"; renderResponse(); } }),
    h("span", { class: "spacer" }),
    h("span", { class: "hint", text: r.body.mime || "" })
  );
  root.appendChild(toolbar);
  const actions = h(
    "div",
    { class: "toolbar" },
    h("button", {
      class: "ghost",
      text: "Copy",
      onclick: async () => {
        const text = r.body.isText ? r.body.text : r.body.base64;
        await navigator.clipboard.writeText(text || "");
        toast("Response copied", "ok");
      },
    }),
    h("button", {
      class: "ghost",
      text: "Save to file…",
      onclick: async () => {
        const res = r.body.isText
          ? await api.io.saveText({ defaultPath: "response.txt", content: r.body.text || "" })
          : await api.io.saveFile({ defaultPath: "response.bin", contentBase64: r.body.base64 });
        if (res.ok) toast("Saved to " + res.path, "ok");
      },
    })
  );
  root.appendChild(actions);

  if (r.missingVariables && r.missingVariables.length) {
    root.appendChild(h("div", { class: "banner warn", text: "Unresolved variables: " + r.missingVariables.join(", ") }));
  }
  if (r.body && r.body.historyTruncated) {
    root.appendChild(h("div", { class: "banner warn", text: "Body not stored in history (binary or larger than 256 KB). Send the request again to load it." }));
  }

  if (!r.body.isText) {
    root.appendChild(h("div", { class: "banner warn", text: `Binary response (${fmtSize(r.body.size)}). Use “Save to file…” to keep it.` }));
    if (r.body.base64) {
      const head = r.body.base64.slice(0, 2048);
      root.appendChild(h("pre", { class: "code-view", text: "base64: " + head + (r.body.base64.length > 2048 ? "…" : "") }));
    }
    return;
  }
  const text = r.body.text || "";
  if (view === "raw") {
    root.appendChild(h("pre", { class: "code-view", text }));
  } else if (view === "preview") {
    const iframe = h("iframe", { class: "preview", sandbox: "" });
    iframe.srcdoc = text;
    root.appendChild(iframe);
  } else {
    let pretty = text;
    const mime = (r.body.mime || "").toLowerCase();
    if (mime.includes("json") || /^\s*[[{]/.test(text)) {
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
    }
    root.appendChild(h("pre", { class: "code-view", html: mime.includes("json") ? highlightJson(pretty) : esc(pretty) }));
  }
}

/* ---------------------------------------------------------------- sidebar */
function renderSidebar() {
  $$(".sidebar-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.panel === S.activePanel));
  $("#panel-collections").hidden = S.activePanel !== "collections";
  $("#panel-history").hidden = S.activePanel !== "history";
  $("#panel-environments").hidden = S.activePanel !== "environments";
  renderCollections();
  renderHistory();
  renderEnvironmentsPanel();
}

function methodTag(m) {
  return h("span", { class: "m " + m, text: m });
}

function renderCollections() {
  const root = $("#panel-collections");
  root.textContent = "";
  root.appendChild(
    h(
      "div",
      { class: "panel-head" },
      h("span", { text: "Collections" }),
      h(
        "span",
        { class: "sidebar-section-actions" },
        h("button", { class: "icon", title: "New collection", text: "＋", onclick: () => newCollection() }),
        h("button", { class: "icon", title: "Import", text: "⇩", onclick: () => openImportModal() })
      )
    )
  );
  if (!S.collections.length) {
    root.appendChild(h("div", { class: "empty-state", text: "No collections yet." }));
    root.appendChild(h("div", { style: "text-align:center" }, h("button", { text: "Create Collection", onclick: () => newCollection() })));
    return;
  }
  S.collections.forEach((col) => root.appendChild(renderCollectionNode(col)));
}

/* ------------------------------------------------- drag & drop, duplicate */
let dragPayload = null;
const DROP_CLASSES = ["drop-before", "drop-after", "drop-inside"];

function clearDropHints() {
  $$(".tree-item").forEach((el) => el.classList.remove(...DROP_CLASSES));
}

function dropPosition(event, row, allowInside) {
  const rect = row.getBoundingClientRect();
  const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
  if (allowInside && ratio >= 0.3 && ratio <= 0.7) return "inside";
  return ratio < 0.5 ? "before" : "after";
}

function dragHandlers(payload, allowInside) {
  return {
    draggable: "true",
    ondragstart: (e) => {
      dragPayload = payload;
      try { e.dataTransfer.setData("text/plain", JSON.stringify(payload)); } catch (_) {}
      e.dataTransfer.effectAllowed = "move";
    },
    ondragend: () => { dragPayload = null; clearDropHints(); },
    ondragover: (e) => {
      if (!dragPayload) return;
      if (dragPayload.kind === "collection" && payload.kind !== "collection") return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.currentTarget;
      const pos = dropPosition(e, row, allowInside);
      clearDropHints();
      row.classList.add("drop-" + pos);
    },
    ondragleave: (e) => {
      const row = e.currentTarget;
      if (!row.contains(e.relatedTarget)) row.classList.remove(...DROP_CLASSES);
    },
    ondrop: (e) => {
      if (!dragPayload) return;
      e.preventDefault();
      e.stopPropagation();
      const pos = dropPosition(e, e.currentTarget, allowInside);
      const payloadNow = dragPayload;
      clearDropHints();
      moveNode(payloadNow, Object.assign({ position: pos }, payload));
    },
  };
}

function findItemEntry(collection, id) {
  const walk = (list, parent) => {
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (item.id === id) return { list, index: i, item, parent };
      if (item.items) {
        const found = walk(item.items, item);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(collection.items, collection);
}

function itemContains(node, id) {
  if (!node) return false;
  if (node.id === id) return true;
  return (node.items || []).some((child) => itemContains(child, id));
}

function moveNode(payload, target) {
  if (!payload || !target) return;
  if (payload.kind === "collection") {
    if (target.kind !== "collection" || payload.collectionId === target.collectionId) return;
    const from = S.collections.findIndex((c) => c.id === payload.collectionId);
    let to = S.collections.findIndex((c) => c.id === target.collectionId);
    if (from < 0 || to < 0) return;
    const [col] = S.collections.splice(from, 1);
    if (from < to) to -= 1;
    if (target.position === "after") to += 1;
    S.collections.splice(Math.max(0, Math.min(S.collections.length, to)), 0, col);
    saveCollections();
    renderCollections();
    return;
  }
  const sourceCol = S.collections.find((c) => c.id === payload.collectionId);
  const targetCol = S.collections.find((c) => c.id === target.collectionId);
  if (!sourceCol || !targetCol) return;
  const source = findItemEntry(sourceCol, payload.itemId);
  if (!source) return;
  let destList = null;
  let destIndex = 0;
  if (target.kind === "collection") {
    destList = targetCol.items;
    destIndex = target.position === "before" ? 0 : targetCol.items.length;
  } else {
    const targetEntry = findItemEntry(targetCol, target.itemId);
    if (!targetEntry) return;
    if (source.item.type === "folder" && itemContains(source.item, targetEntry.item.id)) return;
    if (target.position === "inside" && targetEntry.item.type === "folder") {
      destList = targetEntry.item.items;
      destIndex = destList.length;
    } else {
      destList = targetEntry.list;
      destIndex = targetEntry.index + (target.position === "after" ? 1 : 0);
    }
  }
  const sameList = source.list === destList;
  const sourceIndex = source.index;
  source.list.splice(source.index, 1);
  if (sameList && sourceIndex < destIndex) destIndex -= 1;
  destList.splice(Math.max(0, Math.min(destList.length, destIndex)), 0, source.item);
  saveCollections();
  renderCollections();
}

function cloneTreeWithNewIds(item) {
  const copy = clone(item);
  copy.id = uid(copy.type === "folder" ? "fld" : "req");
  if (copy.type === "request") copy.request.id = uid("req");
  if (copy.items) copy.items = copy.items.map(cloneTreeWithNewIds);
  return copy;
}

function duplicateItem(collection, item) {
  const entry = findItemEntry(collection, item.id);
  if (!entry) return;
  entry.list.splice(entry.index + 1, 0, cloneTreeWithNewIds(item));
  saveCollections();
  renderCollections();
  toast("Duplicated “" + item.name + "”", "ok");
}

function duplicateCollection(collection) {
  const copy = cloneTreeWithNewIds(collection);
  copy.name = collection.name + " copy";
  copy._open = true;
  S.collections.push(copy);
  saveCollections();
  renderCollections();
  toast("Duplicated “" + collection.name + "”", "ok");
}

/* ------------------------------------------------------- context menu */
let contextMenuEl = null;
let contextMenuCleanup = null;

function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
  if (contextMenuCleanup) {
    contextMenuCleanup();
    contextMenuCleanup = null;
  }
}

function openContextMenu(event, entries) {
  event.preventDefault();
  event.stopPropagation();
  closeContextMenu();

  const menu = h("div", { class: "context-menu", role: "menu" });
  for (const entry of entries) {
    if (entry.separator) {
      menu.appendChild(h("div", { class: "context-sep", role: "separator" }));
      continue;
    }
    menu.appendChild(
      h(
        "button",
        {
          class: "context-item" + (entry.danger ? " danger" : ""),
          type: "button",
          role: "menuitem",
          onclick: () => { closeContextMenu(); entry.action(); },
        },
        h("span", { class: "context-icon", text: entry.icon || "" }),
        h("span", { text: entry.label })
      )
    );
  }

  document.body.appendChild(menu);
  const pad = 6;
  const rect = menu.getBoundingClientRect();
  const x = Math.max(pad, Math.min(event.clientX, window.innerWidth - rect.width - pad));
  const y = Math.max(pad, Math.min(event.clientY, window.innerHeight - rect.height - pad));
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  contextMenuEl = menu;

  const onPointerDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeContextMenu(); return; }
    const items = Array.from(menu.querySelectorAll(".context-item"));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length].focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1].focus();
    }
  };
  const dismiss = () => closeContextMenu();
  document.addEventListener("mousedown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);
  window.addEventListener("scroll", dismiss, true);
  contextMenuCleanup = () => {
    document.removeEventListener("mousedown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("scroll", dismiss, true);
  };
  const first = menu.querySelector(".context-item");
  if (first) first.focus({ preventScroll: true });
}

function collectionContextMenu(col) {
  return [
    { label: "Run collection", icon: "▶", action: () => openRunnerModal({ collection: col, folder: null }) },
    { label: "Docs", icon: "📄", action: () => openDocsModal(col, col, "collection") },
    { separator: true },
    { label: "New request", icon: "＋", action: () => addRequestTo(col, null) },
    { label: "New folder", icon: "🗀", action: () => addFolderTo(col, null) },
    { separator: true },
    { label: "Duplicate", icon: "⧉", action: () => duplicateCollection(col) },
    { label: "Export", icon: "⇧", action: () => exportCollection(col) },
    { label: "Rename", icon: "✎", action: () => renameCollection(col) },
    { separator: true },
    { label: "Delete", icon: "✕", danger: true, action: () => deleteCollection(col) },
  ];
}

function folderContextMenu(col, item, parent) {
  return [
    { label: "Run folder", icon: "▶", action: () => openRunnerModal({ collection: col, folder: item }) },
    { label: "Docs", icon: "📄", action: () => openDocsModal(col, item, "folder") },
    { separator: true },
    { label: "New request", icon: "＋", action: () => addRequestTo(col, item) },
    { separator: true },
    { label: "Duplicate", icon: "⧉", action: () => duplicateItem(col, item) },
    { label: "Rename", icon: "✎", action: () => renameItem(item) },
    { separator: true },
    { label: "Delete", icon: "✕", danger: true, action: () => deleteItem(col, item, parent) },
  ];
}

function requestContextMenu(col, item, parent) {
  return [
    { label: "Docs", icon: "📄", action: () => openDocsModal(col, item, "request") },
    { separator: true },
    { label: "Duplicate", icon: "⧉", action: () => duplicateItem(col, item) },
    { label: "Rename", icon: "✎", action: () => renameItem(item) },
    { separator: true },
    { label: "Delete", icon: "✕", danger: true, action: () => deleteItem(col, item, parent) },
  ];
}

function renderCollectionNode(col, depth) {
  const wrap = h("div", { class: "tree-children", style: depth ? "" : "margin-left:0;border:none;padding-left:0" });
  const header = h(
    "div",
    Object.assign(
      {
        class: "tree-item",
        onclick: (e) => { if (e.target.closest("button")) return; col._open = !col._open; renderCollections(); },
        oncontextmenu: (e) => openContextMenu(e, collectionContextMenu(col)),
      },
      dragHandlers({ kind: "collection", collectionId: col.id }, false, { self: true })
    ),
    h("span", { text: col._open === false ? "▸" : "▾" }),
    h("b", { text: col.name })
  );
  wrap.appendChild(header);
  if (col._open !== false) {
    (col.items || []).forEach((item) => wrap.appendChild(renderItemNode(col, item, null)));
  }
  const dropRoot = h("div", { class: "tree-drop-root", text: "drop here" });
  Object.assign(dropRoot, dragHandlers({ kind: "item", collectionId: col.id, itemId: "" }, null, false));
  Object.assign(dropRoot, {
    ondragover: (e) => { if (!dragPayload || dragPayload.kind !== "item") return; e.preventDefault(); dropRoot.classList.add("over"); },
    ondragleave: () => dropRoot.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); dropRoot.classList.remove("over"); moveNode(dragPayload, { kind: "collection", collectionId: col.id, position: "after" }); },
  });
  wrap.appendChild(dropRoot);
  return wrap;
}

function renderItemNode(col, item, parent) {
  const wrap = h("div", { class: "tree-children" });
  if (item.type === "folder") {
    wrap.appendChild(
      h(
        "div",
        Object.assign(
          {
            class: "tree-item",
            onclick: (e) => { if (e.target.closest("button")) return; item._open = !item._open; renderCollections(); },
            oncontextmenu: (e) => openContextMenu(e, folderContextMenu(col, item, parent)),
          },
          dragHandlers({ kind: "item", collectionId: col.id, itemId: item.id }, true)
        ),
        h("span", { text: item._open === false ? "▸" : "▾" }),
        h("span", { text: "🗀 " + item.name })
      )
    );
    if (item._open !== false) (item.items || []).forEach((child) => wrap.appendChild(renderItemNode(col, child, item)));
  } else {
    wrap.appendChild(
      h(
        "div",
        Object.assign(
          {
            class: "tree-item",
            onclick: () => openSaved(col, item),
            oncontextmenu: (e) => openContextMenu(e, requestContextMenu(col, item, parent)),
          },
          dragHandlers({ kind: "item", collectionId: col.id, itemId: item.id }, false)
        ),
        methodTag(item.request.method || "GET"),
        h("span", { text: item.name })
      )
    );
  }
  return wrap;
}

function findItemLocation(list, item) {
  for (let i = 0; i < list.length; i++) {
    if (list[i] === item) return { list, index: i };
    if (list[i].items) {
      const found = findItemLocation(list[i].items, item);
      if (found) return found;
    }
  }
  return null;
}

async function newCollection() {
  const name = await promptModal("New Collection", "Collection name", "");
  if (!name) return;
  S.collections.push({ id: uid("col"), name, description: "", variables: [], items: [], _open: true });
  await saveCollections();
  renderCollections();
  $("#panel-collections").scrollTop = 0;
}

async function renameCollection(col) {
  const name = await promptModal("Rename Collection", "Collection name", col.name);
  if (!name) return;
  col.name = name;
  await saveCollections();
  renderCollections();
}

async function renameItem(item) {
  const name = await promptModal("Rename", "Name", item.name);
  if (!name) return;
  item.name = name;
  if (item.request) item.request.name = name;
  await saveCollections();
  renderCollections();
}

async function deleteCollection(col) {
  if (!(await confirmModal(`Delete collection “${col.name}” and all its requests?`))) return;
  S.collections = S.collections.filter((c) => c !== col);
  await saveCollections();
  renderCollections();
}

async function deleteItem(col, item, parent) {
  if (!(await confirmModal(`Delete “${item.name}”?`))) return;
  const found = findItemLocation(col.items, item);
  if (found) found.list.splice(found.index, 1);
  await saveCollections();
  renderCollections();
}

function folderOptions(collection) {
  const out = [{ value: "", label: "(root)" }];
  const walk = (items, prefix) => {
    for (const it of items || []) {
      if (it.type === "folder") {
        out.push({ value: it.id, label: prefix + it.name });
        walk(it.items, prefix + it.name + " / ");
      }
    }
  };
  walk(collection.items, "");
  return out;
}

function findFolder(collection, id) {
  if (!id) return { items: collection.items };
  let found = null;
  const walk = (items) => {
    for (const it of items || []) {
      if (it.type === "folder") {
        if (it.id === id) found = it;
        else walk(it.items);
      }
    }
  };
  walk(collection.items);
  return found || { items: collection.items };
}

async function addRequestTo(collection, folder) {
  const target = folder || { items: collection.items };
  const name = await promptModal("New Request", "Request name", "New Request");
  if (!name) return;
  const item = { id: uid("req"), type: "request", name, description: "", request: normalizeRequest(Object.assign(blankRequest(name), { name, description: "" })) };
  target.items.push(item);
  await saveCollections();
  renderCollections();
  openSaved(collection, item);
}

async function addFolderTo(collection, folder) {
  const target = folder || { items: collection.items };
  const name = await promptModal("New Folder", "Folder name", "New Folder");
  if (!name) return;
  target.items.push({ id: uid("fld"), type: "folder", name, description: "", items: [] });
  await saveCollections();
  renderCollections();
}

async function exportCollection(col) {
  const res = await api.io.exportPostman(clone(col));
  if (!res.ok) return toast(res.error, "error");
  const saved = await api.io.saveText({ defaultPath: `${col.name.replace(/[^\w.-]+/g, "_")}.postman_collection.json`, content: res.json });
  if (saved.ok) toast("Collection exported", "ok");
}

function openSaved(collection, item) {
  newTab(clone(item.request), { name: item.name, saved: { collectionId: collection.id, itemId: item.id } });
}

/* ----------------------------------------------------------------- history */
const HISTORY_BODY_LIMIT = 256 * 1024;

function snapshotResponse(r) {
  if (!r) return null;
  let body = null;
  if (r.body) {
    const textTooLong = r.body.isText && r.body.text && r.body.text.length > HISTORY_BODY_LIMIT;
    body = {
      size: r.body.size,
      received: r.body.received,
      truncated: r.body.truncated,
      mime: r.body.mime,
      charset: r.body.charset,
      encoding: r.body.encoding,
      isText: r.body.isText,
      text: r.body.isText && r.body.text ? (textTooLong ? r.body.text.slice(0, HISTORY_BODY_LIMIT) : r.body.text) : null,
      base64: null,
      historyTruncated: !!textTooLong || !r.body.isText,
    };
  }
  return {
    ok: r.ok,
    status: r.status,
    statusText: r.statusText,
    httpVersion: r.httpVersion,
    headers: r.headers || [],
    cookies: r.cookies || [],
    url: r.url,
    redirects: r.redirects || [],
    timings: r.timings || null,
    missingVariables: r.missingVariables || [],
    error: r.error || null,
    notFollowedRedirect: r.notFollowedRedirect || null,
    body,
  };
}

function historyGroup(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString();
}

function deleteHistoryEntry(entry) {
  S.history = S.history.filter((x) => x.id !== entry.id);
  saveHistory();
  renderHistory();
}

function openHistoryEntry(entry) {
  const tab = newTab(clone(entry.request), { name: entry.name || "History Request" });
  tab.request.name = entry.name || tab.name;
  if (entry.response) {
    tab.response = clone(entry.response);
    tab.testResults = clone(entry.testResults || []);
    tab.logs = clone(entry.logs || []);
    tab.historyTime = entry.time;
    tab.responseSubTab = "body";
    renderAll();
  }
}

function renderHistory() {
  const root = $("#panel-history");
  root.textContent = "";
  root.appendChild(
    h(
      "div",
      { class: "panel-head" },
      h("span", { text: `History (${S.history.length})` }),
      h("button", { class: "icon", title: "Clear history", text: "🗑", onclick: async () => { S.history = []; await saveHistory(); renderHistory(); } })
    )
  );
  if (!S.history.length) {
    root.appendChild(h("div", { class: "empty-state", text: "Requests you send appear here, with their responses." }));
    return;
  }
  let lastGroup = null;
  S.history.forEach((entry) => {
    const group = historyGroup(entry.time);
    if (group !== lastGroup) {
      lastGroup = group;
      root.appendChild(h("div", { class: "hist-group", text: group }));
    }
    const resp = entry.response;
    const statusBadge = resp && resp.ok
      ? h("span", { class: "badge " + (resp.status < 300 ? "ok" : resp.status < 400 ? "warn" : "err"), text: String(resp.status) })
      : h("span", { class: "badge err", text: "ERR" });
    root.appendChild(
      h(
        "div",
        { class: "hist-item", title: resp ? "Open request with stored response" : "Open request", onclick: () => openHistoryEntry(entry) },
        h("div", { class: "hist-line" }, methodTag(entry.method), h("span", { class: "url", text: entry.url }), statusBadge),
        h(
          "div",
          { class: "hist-meta" },
          h("span", { text: new Date(entry.time).toLocaleTimeString() }),
          resp && resp.ok ? h("span", { text: fmtTime(entry.durationMs) }) : h("span", { text: "failed" }),
          resp && resp.body ? h("span", { text: fmtSize(resp.body.size) }) : null,
          entry.testResults && entry.testResults.length
            ? h("span", { text: `${entry.testResults.filter((x) => x.passed).length}/${entry.testResults.length} tests` })
            : null,
          resp && resp.body && resp.body.historyTruncated ? h("span", { text: "body not stored" }) : null,
          h("span", { class: "hist-actions" }, h("button", { class: "icon", title: "Delete", text: "✕", onclick: (e) => { e.stopPropagation(); deleteHistoryEntry(entry); } }))
        )
      )
    );
  });
}

function addHistory(tab) {
  const r = tab.response || {};
  S.history.unshift({
    id: uid("hist"),
    time: Date.now(),
    durationMs: r.ok && r.timings ? Math.round(r.timings.total) : null,
    name: tab.name,
    method: tab.request.method,
    url: tab.request.url,
    status: r.ok ? r.status : null,
    request: clone(tab.request),
    response: snapshotResponse(tab.response),
    testResults: clone(tab.testResults || []),
    logs: clone(tab.logs || []),
  });
  if (S.history.length > 300) S.history.length = 300;
  saveHistory();
  if (S.activePanel === "history") renderHistory();
}

/* ------------------------------------------------------------ environments */
function renderEnvironmentsPanel() {
  const root = $("#panel-environments");
  root.textContent = "";
  root.appendChild(
    h(
      "div",
      { class: "panel-head" },
      h("span", { text: "Environments" }),
      h("button", { class: "icon", title: "New environment", text: "＋", onclick: () => editEnvironment(null) })
    )
  );
  S.environments.forEach((env) => {
    root.appendChild(
      h(
        "div",
        { class: "tree-item", onclick: () => editEnvironment(env) },
        h("span", { text: env.name }),
        h(
          "span",
          { class: "row-actions" },
          h("button", { class: "icon", title: "Duplicate", text: "⧉", onclick: (e) => { e.stopPropagation(); duplicateEnvironment(env); } }),
          h("button", { class: "icon", title: "Delete", text: "✕", onclick: async (e) => { e.stopPropagation(); if (await confirmModal(`Delete environment “${env.name}”?`)) { S.environments = S.environments.filter((x) => x !== env); if (S.settings.activeEnvironmentId === env.id) { S.settings.activeEnvironmentId = null; saveSettings(); } await saveEnvironments(); renderEnvironmentsPanel(); renderEnvSelect(); } } })
        )
      )
    );
  });
  root.appendChild(
    h("div", { class: "panel-head", style: "margin-top:14px" }, h("span", { text: "Globals" }), h("button", { class: "icon", text: "✎", onclick: () => editGlobals() }))
  );
  root.appendChild(h("div", { class: "hint", text: `${S.globals.length} global variable(s)` }));
}

function duplicateEnvironment(env) {
  const copy = clone(env);
  copy.id = uid("env");
  copy.name = env.name + " copy";
  S.environments.push(copy);
  saveEnvironments();
  renderEnvironmentsPanel();
  renderEnvSelect();
}

function renderEnvSelect() {
  const sel = $("#env-select");
  sel.textContent = "";
  sel.appendChild(h("option", { value: "", selected: !S.settings.activeEnvironmentId }, "No Environment"));
  S.environments.forEach((env) => sel.appendChild(h("option", { value: env.id, selected: S.settings.activeEnvironmentId === env.id }, env.name)));
}

async function editEnvironment(env) {
  const isNew = !env;
  const model = env || { id: uid("env"), name: "New Environment", values: [] };
  const nameInput = h("input", { type: "text", value: model.name, style: "width:100%" });
  const kvWrap = h("div");
  const values = clone(model.values || []);
  kvTable(kvWrap, values, { addLabel: "+ Add variable", keyPlaceholder: "variable" });
  openModal({
    title: isNew ? "New Environment" : "Edit Environment",
    body: h("div", {}, h("div", { class: "field-row" }, h("label", { text: "Name" }), nameInput), kvWrap),
    actions: [
      { label: "Cancel", ghost: true, onClick: (close) => close() },
      {
        label: "Save",
        primary: true,
        onClick: async (close) => {
          model.name = nameInput.value.trim() || "Environment";
          model.values = values;
          if (isNew) S.environments.push(model);
          await saveEnvironments();
          close();
          renderEnvironmentsPanel();
          renderEnvSelect();
          toast("Environment saved", "ok");
        },
      },
    ],
  });
}

async function editGlobals() {
  const values = clone(S.globals || []);
  const kvWrap = h("div");
  kvTable(kvWrap, values, { addLabel: "+ Add global", keyPlaceholder: "variable" });
  openModal({
    title: "Edit Globals",
    body: kvWrap,
    actions: [
      { label: "Cancel", ghost: true, onClick: (close) => close() },
      { label: "Save", primary: true, onClick: async (close) => { S.globals = values; await saveGlobals(); close(); renderEnvironmentsPanel(); toast("Globals saved", "ok"); } },
    ],
  });
}

/* --------------------------------------------------------- docs rendering */
function tinyMarkdown(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  let inList = false;
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="#" data-href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) {
      out.push(inCode ? "</pre>" : "<pre class='docs-code'>");
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(esc(raw)); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (!line.trim()) { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  if (inCode) out.push("</pre>");
  return out.join("\n");
}

function itemDescription(node, kind) {
  if (kind === "request") return node.description || (node.request && node.request.description) || "";
  return node.description || "";
}

function openDocsModal(collection, node, kind) {
  const viewer = h("div", { class: "docs-view" });
  const editor = h("textarea", { class: "code docs-editor", spellcheck: "false" });
  let description = itemDescription(node, kind);
  editor.value = description;
  const renderView = () => {
    let html = tinyMarkdown(description) || "<p class='hint'>No description yet. Write one below and press Save.</p>";
    if (kind !== "request") {
      const items = node.items || [];
      html += "<h3>Contents</h3>";
      if (!items.length) html += "<p class='hint'>Empty.</p>";
      else {
        html += "<ul class='docs-index'>" + items.map((it) => {
          const first = (it.description || "").split("\n")[0];
          if (it.type === "folder") return `<li><b>🗀 ${esc(it.name)}</b>${first ? " — " + esc(first) : ""}</li>`;
          return `<li><span class="m ${esc(it.request.method || "GET")}">${esc(it.request.method || "GET")}</span> ${esc(it.name)} <code>${esc(it.request.url || "")}</code>${first ? " — " + esc(first) : ""}</li>`;
        }).join("") + "</ul>";
      }
    }
    viewer.innerHTML = html;
    $$("a[data-href]", viewer).forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); api.io.openExternal(a.dataset.href); };
    });
  };
  renderView();
  editor.addEventListener("input", () => { description = editor.value; renderView(); });
  const body = h(
    "div",
    {},
    viewer,
    h("h4", { class: "section-title", text: kind === "request" ? "Request description" : kind === "folder" ? "Folder description" : "Collection description" }),
    editor
  );
  openModal({
    title: `Docs — ${node.name}`,
    body,
    actions: [
      { label: "Close", ghost: true, onClick: (c) => c() },
      {
        label: "Save",
        primary: true,
        onClick: async (c) => {
          description = editor.value;
          node.description = description;
          if (kind === "request") {
            node.request.description = description;
            node.request.name = node.name;
          }
          renderView();
          await saveCollections();
          renderCollections();
          c();
          toast("Description saved", "ok");
        },
      },
    ],
  });
}

/* -------------------------------------------------------- collection runner */
function flattenRequests(collection, folder) {
  const out = [];
  const walk = (items) => {
    for (const it of items || []) {
      if (it.type === "folder") walk(it.items);
      else out.push({ collection, item: it });
    }
  };
  walk(folder ? folder.items : collection.items);
  return out;
}

function runnerTargets() {
  const out = [];
  for (const col of S.collections) {
    out.push({ id: "col:" + col.id, label: col.name, collection: col, folder: null });
    const walk = (items, prefix) => {
      for (const it of items || []) {
        if (it.type === "folder") {
          out.push({ id: "fld:" + it.id, label: prefix + it.name, collection: col, folder: it });
          walk(it.items, prefix + it.name + " / ");
        }
      }
    };
    walk(col.items, col.name + " / ");
  }
  return out;
}

function computeRunSummary(results, startedAt, finishedAt, expectedRequests) {
  const timed = results.filter((r) => r.time != null);
  return {
    requests: results.length,
    expectedRequests,
    status2xx: results.filter((r) => r.status >= 200 && r.status < 300).length,
    errors: results.filter((r) => !r.status).length,
    passedTests: results.reduce((a, r) => a + r.passed, 0),
    failedTests: results.reduce((a, r) => a + r.failed, 0),
    durationMs: finishedAt - startedAt,
    avgMs: timed.length ? Math.round(timed.reduce((a, r) => a + r.time, 0) / timed.length) : 0,
  };
}

function runnerReportHtml(report) {
  const rows = report.results.map((r) => `<tr class="${r.failed || r.error ? "bad" : "good"}"><td>${r.iteration}</td><td>${esc(r.method)}</td><td>${esc(r.name)}</td><td><code>${esc(r.url)}</code></td><td>${r.status == null ? "-" : r.status}</td><td>${r.time == null ? "-" : r.time + " ms"}</td><td>${r.passed}</td><td>${r.failed}</td><td>${esc(r.error || "")}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Collection Runner report</title><style>body{font:14px Segoe UI,system-ui,sans-serif;background:#151515;color:#eee;padding:24px}h1{font-size:20px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #333;padding:6px 8px;text-align:left;font-size:13px}th{background:#222}tr.bad{background:#3a1d1d}tr.good{background:#1d2a1d}code{color:#9cdcfe}.sum{margin:12px 0 18px;color:#aaa}.sum b{color:#fff}</style></head><body><h1>Collection Runner report</h1><div class="sum">Target <b>${esc(report.target)}</b> · ${report.summary.requests}/${report.summary.expectedRequests} requests · <b>${report.summary.status2xx}</b> 2xx · <b>${report.summary.errors}</b> error(s) · <b>${report.summary.passedTests}</b> test pass / <b>${report.summary.failedTests}</b> fail · ${(report.summary.durationMs / 1000).toFixed(1)}s</div><table><tr><th>Iter</th><th>Method</th><th>Name</th><th>URL</th><th>Status</th><th>Time</th><th>Tests ✓</th><th>Tests ✗</th><th>Error</th></tr>${rows}</table></body></html>`;
}

function openRunnerModal(target) {
  const targets = runnerTargets();
  if (!targets.length) { toast("Create a collection first", "error"); return; }
  const preselected = target
    ? targets.find((x) => (target.folder ? x.folder === target.folder : x.collection === target.collection && !x.folder)) || targets[0]
    : targets[0];
  const targetSel = h("select", { style: "width:320px" }, ...targets.map((x) => h("option", { value: x.id, selected: x.id === preselected.id }, x.label)));
  const count = h("span", { class: "hint" });
  const iterInput = h("input", { type: "number", value: 1, min: 1, max: 100, style: "width:80px" });
  const delayInput = h("input", { type: "number", value: 0, min: 0, max: 60000, style: "width:90px" });
  const orderSel = h("select", {}, h("option", { value: "defined" }, "As defined"), h("option", { value: "random" }, "Random"));
  const stopChk = h("input", { type: "checkbox", style: "flex:0" });
  const bar = h("div", { class: "bar" });
  const summary = h("div", { class: "hint", text: "Ready." });
  const table = h("table", { class: "kv-table runner-table" });
  let report = null;
  let stopped = false;
  let running = false;

  const refreshCount = () => {
    const t = targets.find((x) => x.id === targetSel.value);
    count.textContent = `${flattenRequests(t.collection, t.folder).length} request(s)`;
  };
  targetSel.onchange = refreshCount;

  const runBtn = h("button", { class: "primary", text: "Run" });
  const stopBtn = h("button", { class: "ghost", text: "Stop", disabled: true });
  const exportJson = h("button", { class: "ghost", text: "Report JSON", disabled: true });
  const exportHtml = h("button", { class: "ghost", text: "Report HTML", disabled: true });
  stopBtn.onclick = () => { stopped = true; };
  exportJson.onclick = async () => {
    if (!report) return;
    const res = await api.io.saveText({ defaultPath: "runner-report.json", content: JSON.stringify(report, null, 2) });
    if (res.ok) toast("Report saved", "ok");
  };
  exportHtml.onclick = async () => {
    if (!report) return;
    const res = await api.io.saveText({ defaultPath: "runner-report.html", content: runnerReportHtml(report) });
    if (res.ok) toast("Report saved", "ok");
  };

  const body = h(
    "div",
    { class: "runner" },
    h("div", { class: "field-row" }, h("label", { text: "Run" }), targetSel, count),
    h("div", { class: "field-row" }, h("label", { text: "Iterations" }), iterInput, h("label", { text: "Delay (ms)", style: "width:90px" }), delayInput),
    h("div", { class: "field-row" }, h("label", { text: "Order" }), orderSel, h("label", { text: "Stop on failure", style: "width:120px" }), stopChk),
    h("div", { class: "runner-progress" }, bar),
    summary,
    table
  );

  const { close } = openModal({
    title: "Collection Runner",
    body,
    actions: [
      exportJson,
      exportHtml,
      { label: "Close", ghost: true, onClick: () => { stopped = true; close(); } },
      stopBtn,
      runBtn,
    ],
  });
  refreshCount();

  function appendResult(r) {
    const tr = h(
      "tr",
      { class: r.error || r.failed ? "bad" : "" },
      h("td", { text: String(r.iteration) }),
      h("td", {}, methodTag(r.method)),
      h("td", { text: r.name }),
      h("td", { html: `<span class="code-view">${esc(r.url)}</span>` }),
      h("td", { text: r.status == null ? "-" : String(r.status) }),
      h("td", { text: r.time == null ? "-" : r.time + " ms" }),
      h("td", { text: `${r.passed}/${r.passed + r.failed}` }),
      h("td", { text: r.error || "" })
    );
    table.appendChild(tr);
  }

  runBtn.onclick = async () => {
    if (running) return;
    const t = targets.find((x) => x.id === targetSel.value);
    const list = flattenRequests(t.collection, t.folder);
    if (!list.length) { toast("Nothing to run", "error"); return; }
    const iterations = Math.max(1, Math.min(100, parseInt(iterInput.value, 10) || 1));
    const delay = Math.max(0, Math.min(60000, parseInt(delayInput.value, 10) || 0));
    const randomOrder = orderSel.value === "random";
    const stopOnError = stopChk.checked;
    running = true;
    stopped = false;
    runBtn.disabled = true;
    stopBtn.disabled = false;
    exportJson.disabled = true;
    exportHtml.disabled = true;
    table.textContent = "";
    const results = [];
    const runSession = {};
    const startedAt = Date.now();
    const expected = list.length * iterations;
    let done = 0;
    const update = () => { bar.style.width = `${expected ? Math.round((done / expected) * 100) : 0}%`; };
    summary.textContent = `Running ${expected} request(s)…`;
    update();

    outer: for (let iteration = 1; iteration <= iterations; iteration++) {
      const ordered = randomOrder ? list.slice().sort(() => Math.random() - 0.5) : list;
      for (const entry of ordered) {
        if (stopped) break outer;
        let sent;
        try {
          sent = await api.send({
            request: clone(entry.item.request),
            collectionVariables: t.collection.variables || [],
            sessionVariables: runSession,
          });
        } catch (e) {
          sent = { response: { ok: false, error: { message: e.message } }, testResults: [], logs: [] };
        }
        Object.assign(runSession, sent.sessionVariables || {});
        if (sent.environment) {
          const idx = S.environments.findIndex((e) => e.id === sent.environment.id);
          if (idx >= 0) S.environments[idx] = sent.environment;
        }
        if (sent.globals) S.globals = sent.globals;
        const rr = sent.response || {};
        const tests = sent.testResults || [];
        const failed = tests.filter((x) => !x.passed).length;
        const result = {
          iteration,
          name: entry.item.name,
          method: entry.item.request.method,
          url: entry.item.request.url,
          status: rr.ok ? rr.status : null,
          time: rr.ok && rr.timings ? Math.round(rr.timings.total) : null,
          passed: tests.length - failed,
          failed,
          error: rr.ok ? (rr.missingVariables && rr.missingVariables.length ? "unresolved: " + rr.missingVariables.join(", ") : null) : (rr.error && rr.error.message) || "request failed",
          tests,
        };
        results.push(result);
        done += 1;
        update();
        appendResult(result);
        table.parentElement.scrollTop = table.parentElement.scrollHeight;
        if (stopOnError && (failed || result.error)) { summary.textContent = `Stopped on failure at iteration ${iteration}.`; break outer; }
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      if (stopped) break;
    }

    running = false;
    runBtn.disabled = false;
    stopBtn.disabled = true;
    const finishedAt = Date.now();
    const summaryData = computeRunSummary(results, startedAt, finishedAt, expected);
    report = {
      type: "postman-replicate.runner-report",
      generatedAt: new Date().toISOString(),
      target: t.label,
      options: { iterations, delay, order: orderSel.value, stopOnError },
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      summary: summaryData,
      results,
    };
    summary.textContent = stopped
      ? `Stopped after ${results.length} request(s).`
      : `Done: ${summaryData.requests} request(s), ${summaryData.status2xx} 2xx, ${summaryData.errors} error(s), tests ${summaryData.passedTests} passed / ${summaryData.failedTests} failed, ${(summaryData.durationMs / 1000).toFixed(1)}s.`;
    exportJson.disabled = false;
    exportHtml.disabled = false;
  };
}

/* ------------------------------------------------------------------ modals */
function openModal({ title, body, actions }) {
  const root = $("#modal-root");
  root.textContent = "";
  const modal = h("div", { class: "modal" });
  modal.appendChild(h("h3", { text: title }));
  modal.appendChild(h("div", { class: "modal-body" }, body));
  const actionBar = h("div", { class: "modal-actions" });
  const close = () => { root.classList.remove("open"); root.textContent = ""; };
  (actions || []).forEach((a) => {
    if (a && a.nodeType) {
      actionBar.appendChild(a);
      return;
    }
    actionBar.appendChild(h("button", { class: a.primary ? "primary" : "ghost", text: a.label, onclick: () => a.onClick(close) }));
  });
  modal.appendChild(actionBar);
  root.appendChild(modal);
  root.classList.add("open");
  root.onclick = (e) => { if (e.target === root) close(); };
  return { close, modal };
}

function promptModal(title, label, value) {
  return new Promise((resolve) => {
    const input = h("input", { type: "text", value: value || "", style: "width:100%" });
    const { close } = openModal({
      title,
      body: h("div", {}, h("div", { class: "hint", text: label }), input),
      actions: [
        { label: "Cancel", ghost: true, onClick: () => { close(); resolve(null); } },
        { label: "OK", primary: true, onClick: () => { const v = input.value.trim(); close(); resolve(v); } },
      ],
    });
    input.focus();
    input.select();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const v = input.value.trim(); close(); resolve(v); }
      if (e.key === "Escape") { close(); resolve(null); }
    });
  });
}

function confirmModal(message) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title: "Confirm",
      body: h("div", { text: message }),
      actions: [
        { label: "Cancel", ghost: true, onClick: () => { close(); resolve(false); } },
        { label: "Delete", primary: true, onClick: () => { close(); resolve(true); } },
      ],
    });
  });
}

/* ------------------------------------------------------------------ import */
function openImportModal() {
  const area = h("textarea", { spellcheck: "false", placeholder: "Paste a Postman Collection v2.1 JSON or a cURL command…" });
  const { close } = openModal({
    title: "Import",
    body: h("div", {}, area),
    actions: [
      { label: "From file…", ghost: true, onClick: async () => {
        const res = await api.io.openFile();
        if (res.ok) {
          const text = res.dataBase64 ? atob(res.dataBase64) : "";
          area.value = text;
        }
      } },
      { label: "Cancel", ghost: true, onClick: (c) => c() },
      {
        label: "Import",
        primary: true,
        onClick: async (c) => {
          const text = area.value.trim();
          if (!text) return;
          if (/^curl\b/im.test(text)) {
            const res = await api.io.parseCurl(text);
            if (!res.ok) { toast(res.error, "error"); return; }
            c();
            openInTab(res.request, { name: res.request.name });
            toast("cURL imported", "ok");
            return;
          }
          const res = await api.io.importAny(text);
          if (!res.ok) { toast("Import failed: " + res.error, "error"); return; }
          for (const col of res.collections || []) S.collections.push(col);
          for (const env of res.environments || []) S.environments.push(env);
          if (res.globals && res.globals.length) S.globals = res.globals;
          await Promise.all([saveCollections(), saveEnvironments(), saveGlobals()]);
          c();
          S.activePanel = "collections";
          renderEnvSelect();
          renderSidebar();
          const bits = [];
          if ((res.collections || []).length) bits.push(`${res.collections.length} collection(s)`);
          if ((res.environments || []).length) bits.push(`${res.environments.length} environment(s)`);
          if (res.globals && res.globals.length) bits.push(`${res.globals.length} global(s)`);
          toast(bits.length ? `Imported ${bits.join(", ")}` : "Nothing imported", bits.length ? "ok" : "error");
        },
      },
    ],
  });
}

function openCurlModal() {
  const t = activeTab();
  if (!t) return;
  api.io.buildCurl(clone(t.request)).then((res) => {
    if (!res.ok) return toast(res.error, "error");
    const area = h("textarea", { spellcheck: "false", value: res.text, readonly: true });
    openModal({
      title: "Request as cURL",
      body: area,
      actions: [
        { label: "Copy", ghost: true, onClick: async () => { await navigator.clipboard.writeText(res.text); toast("cURL copied", "ok"); } },
        { label: "Close", primary: true, onClick: (c) => c() },
      ],
    });
    area.focus();
    area.select();
  });
}

async function importCurlFromClipboard() {
  const text = await navigator.clipboard.readText();
  const res = await api.io.parseCurl(text);
  if (!res.ok) return toast("Clipboard does not contain a cURL command", "error");
  openInTab(res.request, { name: res.request.name });
  toast("cURL imported", "ok");
}

/* ------------------------------------------------------------------- save */
function showSaveModal() {
  const t = activeTab();
  if (!t) return;
  const nameInput = h("input", { type: "text", value: t.name, style: "width:100%" });
  const colSel = h("select", { style: "width:100%" });
  const folderSel = h("select", { style: "width:100%" });
  const newColInput = h("input", { type: "text", placeholder: "New collection name", style: "width:100%;display:none" });

  const refreshFolders = () => {
    const col = S.collections.find((c) => c.id === colSel.value);
    folderSel.textContent = "";
    if (!col) return;
    folderOptions(col).forEach((o) => folderSel.appendChild(h("option", { value: o.value, selected: t.saved && t.saved.collectionId === col.id ? o.value : "" }, o.label)));
  };

  S.collections.forEach((c) => colSel.appendChild(h("option", { value: c.id, selected: t.saved && t.saved.collectionId === c.id }, c.name)));
  colSel.appendChild(h("option", { value: "__new__" }, "+ New collection…"));
  colSel.onchange = () => {
    newColInput.style.display = colSel.value === "__new__" ? "" : "none";
    refreshFolders();
  };
  if (!S.collections.length) colSel.value = "__new__";
  refreshFolders();
  newColInput.style.display = colSel.value === "__new__" ? "" : "none";

  openModal({
    title: "Save Request",
    body: h(
      "div",
      {},
      h("div", { class: "hint", text: "Request name" }),
      nameInput,
      h("div", { class: "hint", text: "Collection", style: "margin-top:10px" }),
      colSel,
      newColInput,
      h("div", { class: "hint", text: "Folder", style: "margin-top:10px" }),
      folderSel
    ),
    actions: [
      { label: "Cancel", ghost: true, onClick: (c) => c() },
      {
        label: "Save",
        primary: true,
        onClick: async (c) => {
          let collection = S.collections.find((x) => x.id === colSel.value);
          if (colSel.value === "__new__") {
            const name = newColInput.value.trim();
            if (!name) return toast("Collection name is required", "error");
            collection = { id: uid("col"), name, description: "", variables: [], items: [], _open: true };
            S.collections.push(collection);
          }
          const folder = findFolder(collection, folderSel.value);
          t.name = nameInput.value.trim() || "Untitled Request";
          t.request.name = t.name;
          const existing = t.saved && t.saved.collectionId === collection.id ? findItemLocation(collection.items, { id: t.saved.itemId }) : null;
          if (t.saved && t.saved.collectionId === collection.id) {
            const item = (function loc(list) {
              for (const it of list) {
                if (it.id === t.saved.itemId) return it;
                if (it.items) { const f = loc(it.items); if (f) return f; }
              }
              return null;
            })(collection.items);
            if (item) {
              item.name = t.name;
              item.request = clone(t.request);
              t.dirty = false;
              await saveCollections();
              renderAll();
              c();
              toast("Request saved", "ok");
              return;
            }
          }
          const item = { id: uid("req"), type: "request", name: t.name, request: clone(t.request) };
          folder.items.push(item);
          t.saved = { collectionId: collection.id, itemId: item.id };
          t.dirty = false;
          await saveCollections();
          renderAll();
          c();
          toast("Request saved", "ok");
        },
      },
    ],
  });
}

/* ------------------------------------------------------------------- send */
async function sendActive() {
  const t = activeTab();
  if (!t) return;
  const btn = $("#btn-send");
  btn.disabled = true;
  const previous = btn.textContent;
  btn.textContent = "Sending…";
  try {
    const collectionVariables = t.saved
      ? ((S.collections.find((c) => c.id === t.saved.collectionId) || {}).variables || [])
      : [];
    const res = await api.send({ request: clone(t.request), collectionVariables, sessionVariables: t.sessionVariables || {} });
    t.response = res.response;
    t.testResults = res.testResults || [];
    t.logs = res.logs || [];
    t.sessionVariables = res.sessionVariables || {};
    t.responseSubTab = t.responseSubTab || "body";
    t.responseView = t.responseView || "pretty";
    if (res.environment) {
      const idx = S.environments.findIndex((e) => e.id === res.environment.id);
      if (idx >= 0) S.environments[idx] = res.environment;
    }
    if (res.globals) S.globals = res.globals;
    addHistory(t);
    renderResponse();
    renderRequestPane();
  } catch (e) {
    toast("Send failed: " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = previous || "Send";
  }
}

/* ---------------------------------------------------------------- render all */
function renderTabs() {
  const strip = $("#tabs");
  strip.textContent = "";
  S.tabs.forEach((t) => {
    strip.appendChild(
      h(
        "div",
        { class: "tab" + (t.id === S.activeTabId ? " active" : ""), onclick: () => { S.activeTabId = t.id; renderAll(); } },
        h("span", { class: "tab-name", text: (t.dirty ? "● " : "") + t.name }),
        h("button", { class: "icon close", text: "✕", onclick: (e) => { e.stopPropagation(); closeTab(t.id); } })
      )
    );
  });
  strip.appendChild(h("button", { class: "icon", title: "New tab", text: "＋", onclick: () => newTab() }));
}

function renderAll() {
  renderTabs();
  renderRequestPane();
  renderResponse();
  renderSidebar();
  scheduleSessionSave();
}

/* ---------------------------------------------------------------- shortcuts */
function wireShortcuts() {
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "Enter") { e.preventDefault(); sendActive(); }
    else if (e.key.toLowerCase() === "s") { e.preventDefault(); showSaveModal(); }
    else if (e.key.toLowerCase() === "t") { e.preventDefault(); newTab(); }
    else if (e.key.toLowerCase() === "w") { e.preventDefault(); if (S.activeTabId) closeTab(S.activeTabId); }
  });
}

function wireStaticEvents() {
  $("#btn-send").onclick = sendActive;
  $("#btn-save").onclick = showSaveModal;
  $("#btn-curl").onclick = openCurlModal;
  $("#btn-import").onclick = openImportModal;
  $("#btn-theme").onclick = () => { S.settings.theme = S.settings.theme === "light" ? "dark" : "light"; applyTheme(); saveSettings(); };
  $("#btn-manage-env").onclick = () => { S.activePanel = "environments"; renderSidebar(); };
  $("#env-select").onchange = (e) => { S.settings.activeEnvironmentId = e.target.value || null; saveSettings(); toast("Environment: " + (e.target.selectedOptions[0] || {}).text, "ok"); };
  $("#method").onchange = (e) => { const t = activeTab(); if (t) { t.request.method = e.target.value; e.target.dataset.method = e.target.value; markDirty(t); } };
  $("#url").oninput = (e) => { const t = activeTab(); if (t) { t.request.url = e.target.value; t.request.params = (t.request.params || []).length ? t.request.params : []; markDirty(t); } };
  $("#url").addEventListener("change", () => { const t = activeTab(); if (t) syncParamsFromUrl(t); });
  $$(".sidebar-tabs button").forEach((btn) => {
    btn.onclick = () => { S.activePanel = btn.dataset.panel; renderSidebar(); };
  });
  const divider = $("#resp-divider");
  if (divider) {
    divider.addEventListener("mousedown", (down) => {
      down.preventDefault();
      const startY = down.clientY;
      const pane = $("#request-pane");
      const startH = pane.getBoundingClientRect().height;
      const move = (ev) => {
        const next = Math.max(140, Math.min(window.innerHeight - 220, startH + (ev.clientY - startY)));
        pane.style.height = next + "px";
        pane.style.flex = "0 0 auto";
        S.settings.requestPaneHeight = next;
      };
      const up = () => {
        document.removeEventListener("mousemove", move);
        document.removeEventListener("mouseup", up);
        saveSettings();
      };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  }
}

function syncParamsFromUrl(t) {
  const raw = t.request.url || "";
  const qIdx = raw.indexOf("?");
  if (qIdx < 0) return;
  const query = raw.slice(qIdx + 1);
  const params = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const [k, ...v] = pair.split("=");
    params.push({ key: decodeURIComponent(k || ""), value: decodeURIComponent(v.join("=") || ""), enabled: true });
  }
  t.request.url = raw.slice(0, qIdx);
  t.request.params = params;
  markDirty(t);
  renderRequestPane();
}

function handleMenu(message) {
  const channel = message.channel;
  if (channel === "new-request" || channel === "new-tab") newTab();
  else if (channel === "close-tab") { if (S.activeTabId) closeTab(S.activeTabId); }
  else if (channel === "save-request") showSaveModal();
  else if (channel === "import-curl") importCurlFromClipboard();
  else if (channel === "import-postman") openImportModal();
  else if (channel === "export-curl") openCurlModal();
  else if (channel === "toggle-theme") { S.settings.theme = S.settings.theme === "light" ? "dark" : "light"; applyTheme(); saveSettings(); }
  else if (channel === "reset-layout") { S.settings.requestPaneHeight = null; $("#request-pane").style = ""; renderAll(); }
  else if (channel === "about") {
    openModal({
      title: "About Postman Replicate",
      body: h(
        "div",
        {},
        h("p", { text: "Postman Replicate 0.1.0 - a new, offline desktop API client." }),
        h("p", { class: "hint", text: "No Postman code. No accounts. No telemetry. All data stays in this app's data folder." })
      ),
      actions: [{ label: "Close", primary: true, onClick: (c) => c() }],
    });
  }
}

/* --------------------------------------------------------------------- boot */
async function boot() {
  S.info = await api.info();
  const all = await api.store.loadAll();
  S.collections = (all.collections || []).map((c) => Object.assign(c, { _open: c._open !== false }));
  S.environments = all.environments || [];
  S.globals = all.globals || [];
  S.history = all.history || [];
  S.settings = Object.assign(S.settings, all.settings || {});

  if (all.session && Array.isArray(all.session.tabs) && all.session.tabs.length) {
    S.tabs = all.session.tabs.map((t) => ({
      id: t.id || uid("tab"),
      name: t.name || "Untitled Request",
      request: normalizeRequest(t.request),
      response: null,
      testResults: [],
      logs: [],
      sessionVariables: {},
      saved: t.saved || null,
      dirty: !!t.dirty,
    }));
    S.activeTabId = all.session.activeTabId && S.tabs.some((t) => t.id === all.session.activeTabId) ? all.session.activeTabId : S.tabs[0].id;
  } else {
    S.tabs = [{
      id: uid("tab"),
      name: "Untitled Request",
      request: normalizeRequest(blankRequest()),
      response: null,
      testResults: [],
      logs: [],
      sessionVariables: {},
      saved: null,
      dirty: false,
    }];
    S.activeTabId = S.tabs[0].id;
  }

  applyTheme();
  wireStaticEvents();
  wireShortcuts();
  api.onMenu(handleMenu);
  renderEnvSelect();
  renderAll();
  if (S.settings.requestPaneHeight) {
    $("#request-pane").style.height = S.settings.requestPaneHeight + "px";
    $("#request-pane").style.flex = "0 0 auto";
  }
  document.title = "Postman Replicate";
}

boot().catch((e) => {
  document.body.appendChild(h("div", { class: "banner err", text: "Startup error: " + e.message }));
  toast("Startup error: " + e.message, "error");
});
