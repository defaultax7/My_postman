"use strict";
/* Import/export: Postman Collection v2.1 and cURL. */

/* ------------------------------------------------------------------ helpers */
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

function emptyRequest(name) {
  return {
    id: newId("req"),
    name: name || "Untitled Request",
    description: "",
    method: "GET",
    url: "",
    params: [],
    headers: [],
    body: { mode: "none", raw: { language: "json", text: "" }, urlencoded: [], formdata: [], file: null, graphql: { query: "", variables: "" } },
    auth: { type: "none", basic: { username: "", password: "" }, bearer: { token: "" }, apikey: { key: "", value: "", in: "header" }, oauth2: { token: "", headerPrefix: "Bearer" } },
    scripts: { preRequest: "", tests: "" },
    settings: { followRedirects: true, verifyTls: true, timeoutMs: 30000, sendCookies: true },
  };
}

function kv(list) {
  return (list || [])
    .filter((x) => x && (x.key || x.value))
    .map((x) => ({ key: x.key || "", value: x.value == null ? "" : String(x.value), enabled: x.disabled !== true }));
}

/* ----------------------------------------------------------- postman import */
function normalizeDescription(desc) {
  if (!desc) return "";
  if (typeof desc === "string") return desc;
  if (typeof desc === "object" && typeof desc.content === "string") return desc.content;
  return "";
}

function isV1Collection(data) {
  return !!data && !data.item && !(data.info && data.info.schema) && (Array.isArray(data.requests) || Array.isArray(data.folders) || Array.isArray(data.order));
}

function parseKvLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const i = line.indexOf("=");
      return { key: line.slice(0, i), value: line.slice(i + 1), enabled: true };
    });
}

function splitUrlQuery(request) {
  const idx = String(request.url || "").indexOf("?");
  if (idx < 0) return;
  request.params = String(request.url)
    .slice(idx + 1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const [k, ...v] = pair.split("=");
      return { key: decodeURIComponent(k || ""), value: decodeURIComponent(v.join("=") || ""), enabled: true };
    });
  request.url = String(request.url).slice(0, idx);
}

function importV1Request(r) {
  const request = emptyRequest(r.name);
  request.method = String(r.method || "GET").toUpperCase();
  request.url = typeof r.url === "string" ? r.url : (r.url && r.url.raw) || "";
  if (typeof r.headers === "string") {
    request.headers = r.headers
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const i = line.indexOf(":");
        return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim(), enabled: true };
      });
  } else {
    request.headers = kv(r.headers);
  }
  splitUrlQuery(request);
  const raw = r.rawModeData != null ? r.rawModeData : typeof r.data === "string" ? r.data : "";
  if (r.dataMode === "raw") {
    request.body.mode = "raw";
    request.body.raw.text = raw;
    const lang = r.dataOptions && r.dataOptions.raw && r.dataOptions.raw.language;
    request.body.raw.language = lang || (/^\s*[[{]/.test(raw) ? "json" : "text");
  } else if (r.dataMode === "urlencoded") {
    request.body.mode = "urlencoded";
    request.body.urlencoded = Array.isArray(r.data) ? kv(r.data) : parseKvLines(raw);
  } else if (r.dataMode === "params") {
    request.body.mode = "formdata";
    request.body.formdata = (Array.isArray(r.data) ? r.data : []).map((f) => ({
      key: f.key || "",
      value: f.value == null ? "" : String(f.value),
      type: f.type === "file" ? "file" : "text",
      filename: f.fileName || "",
      dataBase64: null,
      enabled: f.enabled !== false,
    }));
  }
  const helper = r.currentHelper;
  const attrs = r.helperAttributes || {};
  if (helper === "basicAuth") {
    request.auth.type = "basic";
    request.auth.basic.username = attrs.username || "";
    request.auth.basic.password = attrs.password || "";
  } else if (helper === "bearerAuth") {
    request.auth.type = "bearer";
    request.auth.bearer.token = attrs.token || "";
  } else if (helper === "apiKeyAuth") {
    request.auth.type = "apikey";
    request.auth.apikey.key = attrs.key || attrs.apikeyKey || "";
    request.auth.apikey.value = attrs.value || attrs.apikeyValue || "";
    request.auth.apikey.in = attrs.in === "query" ? "query" : "header";
  }
  return request;
}

function importV1Collection(data) {
  const collection = {
    id: newId("col"),
    name: data.name || data.collection_name || "Imported Collection",
    description: normalizeDescription(data.description),
    variables: [],
    items: [],
  };
  const folders = Array.isArray(data.folders) ? data.folders : [];
  const requests = Array.isArray(data.requests) ? data.requests : [];
  const folderById = new Map(folders.map((f) => [String(f.id), f]));
  const requestById = new Map(requests.map((r) => [String(r.id), r]));
  const usedRequests = new Set();
  const usedFolders = new Set();

  const buildRequest = (req) => ({
    id: newId("req"),
    type: "request",
    name: req.name || "Request",
    description: normalizeDescription(req.description),
    request: importV1Request(req),
  });
  const buildFolder = (folder) => {
    usedFolders.add(String(folder.id));
    const node = { id: newId("fld"), type: "folder", name: folder.name || "Folder", description: normalizeDescription(folder.description), items: [] };
    const order = Array.isArray(folder.order) ? folder.order : [];
    for (const id of order) {
      const key = String(id);
      if (folderById.has(key)) node.items.push(buildFolder(folderById.get(key)));
      else if (requestById.has(key)) {
        usedRequests.add(key);
        node.items.push(buildRequest(requestById.get(key)));
      }
    }
    for (const child of folder.folders || []) {
      const key = String(child.id);
      if (folderById.has(key) && !usedFolders.has(key)) node.items.push(buildFolder(folderById.get(key)));
    }
    for (const req of folder.requests || []) {
      const key = String(req.id);
      if (!usedRequests.has(key)) {
        usedRequests.add(key);
        node.items.push(buildRequest(req));
      }
    }
    return node;
  };
  const order = Array.isArray(data.order) ? data.order : [];
  for (const id of order) {
    const key = String(id);
    if (folderById.has(key)) {
      if (!usedFolders.has(key)) collection.items.push(buildFolder(folderById.get(key)));
    } else if (requestById.has(key)) {
      if (!usedRequests.has(key)) {
        usedRequests.add(key);
        collection.items.push(buildRequest(requestById.get(key)));
      }
    }
  }
  for (const folder of folders) if (!usedFolders.has(String(folder.id))) collection.items.push(buildFolder(folder));
  for (const req of requests) {
    const key = String(req.id);
    if (!usedRequests.has(key)) {
      usedRequests.add(key);
      collection.items.push(buildRequest(req));
    }
  }
  return collection;
}

function importEnvironment(env) {
  return {
    id: newId("env"),
    name: env.name || "Imported Environment",
    values: (Array.isArray(env.values) ? env.values : []).map((v) => ({
      key: v.key,
      value: v.value == null ? "" : String(v.value),
      enabled: v.enabled !== false,
      secret: v.type === "secret",
    })),
  };
}

function importAny(json) {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  const out = { collections: [], environments: [], globals: [] };
  if (data && Array.isArray(data.collections)) {
    for (const col of data.collections) out.collections.push(importV1Collection(col));
    for (const env of data.environments || []) out.environments.push(importEnvironment(env));
    const globals = data.globals;
    const values = Array.isArray(globals) ? globals : globals && Array.isArray(globals.values) ? globals.values : [];
    out.globals = values.map((v) => ({ key: v.key, value: v.value == null ? "" : String(v.value), enabled: v.enabled !== false }));
  } else if (isV1Collection(data)) {
    out.collections.push(importV1Collection(data));
  } else if (data && (data.item || (data.info && data.info.schema))) {
    out.collections.push(importV2Collection(data));
  } else {
    throw new Error("Unrecognized Postman JSON (expected v1 or v2 collection/workspace export)");
  }
  return out;
}

function importV2Collection(data) {
  const collection = {
    id: newId("col"),
    name: (data.info && data.info.name) || "Imported Collection",
    description: normalizeDescription(data.info && data.info.description),
    variables: kv(data.variable),
    items: [],
  };
  const walk = (items) => {
    const out = [];
    for (const item of items || []) {
      if (Array.isArray(item.item)) {
        out.push({ id: newId("fld"), type: "folder", name: item.name || "Folder", description: normalizeDescription(item.description), items: walk(item.item) });
      } else if (item.request) {
        const request = importRequest(item.request, item);
        request.description = normalizeDescription(item.request.description) || normalizeDescription(item.description);
        out.push({ id: newId("req"), type: "request", name: item.name || "Request", description: normalizeDescription(item.description) || normalizeDescription(item.request.description), request });
      }
    }
    return out;
  };
  collection.items = walk(data.item);
  return collection;
}

function importRequest(req, item) {
  const request = emptyRequest(item && item.name);
  request.description = "";
  if (typeof req === "string") {
    request.url = req;
  } else {
    request.method = (req.method || "GET").toUpperCase();
    if (typeof req.url === "string") {
      request.url = req.url;
    } else if (req.url) {
      request.url = req.url.raw || "";
      request.params = kv(req.url.query);
      if (!request.params.length && request.url.raw) {
        const q = /\?([^#]*)/.exec(request.url.raw);
        if (q) request.params = q[1].split("&").filter(Boolean).map((pair) => {
          const [k, ...v] = pair.split("=");
          return { key: decodeURIComponent(k || ""), value: decodeURIComponent(v.join("=") || ""), enabled: true };
        });
      }
      if (req.url.raw) request.url = req.url.raw.split("?")[0];
    }
    request.headers = kv(req.header);
    if (req.body) {
      const b = req.body;
      if (b.mode === "raw") {
        request.body.mode = "raw";
        request.body.raw.text = b.raw || "";
        const lang = b.options && b.options.raw && b.options.raw.language;
        request.body.raw.language = lang === "javascript" ? "javascript" : lang || "text";
        if (lang === "json") request.body.raw.language = "json";
      } else if (b.mode === "urlencoded") {
        request.body.mode = "urlencoded";
        request.body.urlencoded = kv(b.urlencoded);
      } else if (b.mode === "formdata") {
        request.body.mode = "formdata";
        request.body.formdata = (b.formdata || []).map((f) => ({
          key: f.key || "",
          value: f.type === "file" ? "" : f.value || "",
          type: f.type === "file" ? "file" : "text",
          filename: f.src ? String(f.src).split(/[\\/]/).pop() : "",
          dataBase64: null,
          enabled: f.disabled !== true,
        }));
      } else if (b.mode === "file") {
        request.body.mode = "file";
        request.body.file = { filename: (b.file && b.file.src) || "file", dataBase64: null, path: (b.file && b.file.src) || "" };
      } else if (b.mode === "graphql") {
        request.body.mode = "graphql";
        request.body.graphql.query = (b.graphql && b.graphql.query) || "";
        request.body.graphql.variables = (b.graphql && b.graphql.variables) || "";
      }
    }
    if (req.auth && req.auth.type) {
      request.auth.type = req.auth.type;
      const get = (key) => {
        const list = req.auth[req.auth.type];
        if (Array.isArray(list)) {
          const found = list.find((x) => x.key === key);
          return found ? found.value : "";
        }
        return (list && list[key]) || "";
      };
      if (req.auth.type === "basic") {
        request.auth.basic.username = get("username");
        request.auth.basic.password = get("password");
      } else if (req.auth.type === "bearer") {
        request.auth.bearer.token = get("token");
      } else if (req.auth.type === "apikey") {
        request.auth.apikey.key = get("key");
        request.auth.apikey.value = get("value");
        request.auth.apikey.in = get("in") || "header";
      }
    }
  }
  for (const event of (item && item.event) || []) {
    const exec = (event.script && event.script.exec ? [].concat(event.script.exec) : []).join("\n");
    if (event.listen === "prerequest") request.scripts.preRequest = exec;
    if (event.listen === "test") request.scripts.tests = exec;
  }
  return request;
}

/* ----------------------------------------------------------- postman export */
function importPostman(json) {
  const any = importAny(json);
  if (!any.collections.length) throw new Error("No collections found in the supplied JSON");
  return any.collections[0];
}

function exportPostman(collection) {
  const convertItems = (items) =>
    (items || []).map((item) => {
      if (item.type === "folder") {
        return { name: item.name, description: item.description || "", item: convertItems(item.items) };
      }
      const request = exportRequest(item.request);
      request.description = item.description || item.request.description || "";
      return {
        name: item.name,
        request,
        event: scriptsToEvents(item.request),
      };
    });

  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      description: collection.description || "",
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    },
    item: convertItems(collection.items),
    variable: (collection.variables || []).map((v) => ({ key: v.key, value: v.value, disabled: v.enabled === false })),
  };
}

function exportRequest(request) {
  const query = (request.params || [])
    .filter((p) => p.key || p.value)
    .map((p) => ({ key: p.key, value: p.value, disabled: p.enabled === false }));
  let raw = request.url || "";
  const enabled = query.filter((p) => p.enabled !== false);
  if (enabled.length) {
    const usp = new URLSearchParams();
    enabled.forEach((p) => usp.append(p.key, p.value));
    raw += (raw.includes("?") ? "&" : "?") + usp.toString();
  }
  const out = {
    method: request.method,
    header: (request.headers || [])
      .filter((h) => h.key || h.value)
      .map((h) => ({ key: h.key, value: h.value, disabled: h.enabled === false })),
    url: { raw, query },
  };
  const b = request.body || {};
  if (b.mode === "raw") {
    out.body = { mode: "raw", raw: (b.raw && b.raw.text) || "", options: { raw: { language: (b.raw && b.raw.language) || "text" } } };
  } else if (b.mode === "urlencoded") {
    out.body = { mode: "urlencoded", urlencoded: (b.urlencoded || []).map((f) => ({ key: f.key, value: f.value, disabled: f.enabled === false })) };
  } else if (b.mode === "formdata") {
    out.body = {
      mode: "formdata",
      formdata: (b.formdata || []).map((f) =>
        f.type === "file"
          ? { key: f.key, type: "file", src: f.path || f.filename || "", disabled: f.enabled === false }
          : { key: f.key, value: f.value, type: "text", disabled: f.enabled === false }
      ),
    };
  } else if (b.mode === "file") {
    out.body = { mode: "file", file: { src: (b.file && (b.file.path || b.file.filename)) || "" } };
  } else if (b.mode === "graphql") {
    out.body = { mode: "graphql", graphql: { query: (b.graphql && b.graphql.query) || "", variables: (b.graphql && b.graphql.variables) || "" } };
  } else {
    out.body = { mode: "none" };
  }
  if (request.auth && request.auth.type && request.auth.type !== "none") {
    if (request.auth.type === "basic") {
      out.auth = { type: "basic", basic: [{ key: "username", value: request.auth.basic.username, type: "string" }, { key: "password", value: request.auth.basic.password, type: "string" }] };
    } else if (request.auth.type === "bearer") {
      out.auth = { type: "bearer", bearer: [{ key: "token", value: request.auth.bearer.token, type: "string" }] };
    } else if (request.auth.type === "apikey") {
      out.auth = { type: "apikey", apikey: [{ key: "key", value: request.auth.apikey.key, type: "string" }, { key: "value", value: request.auth.apikey.value, type: "string" }, { key: "in", value: request.auth.apikey.in, type: "string" }] };
    } else {
      out.auth = { type: request.auth.type };
    }
  }
  return out;
}

function scriptsToEvents(request) {
  const events = [];
  if (request.scripts && request.scripts.preRequest) {
    events.push({ listen: "prerequest", script: { type: "text/javascript", exec: request.scripts.preRequest.split("\n") } });
  }
  if (request.scripts && request.scripts.tests) {
    events.push({ listen: "test", script: { type: "text/javascript", exec: request.scripts.tests.split("\n") } });
  }
  return events;
}

/* -------------------------------------------------------------- curl parser */
function tokenize(text) {
  const tokens = [];
  let cur = "";
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < text.length) { cur += text[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ""; }
    } else if (ch === "\\" && i + 1 < text.length) {
      cur += text[++i];
    } else if (ch === "^" && text[i + 1] === "\n") {
      i++;
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseCurl(text) {
  const tokens = tokenize(String(text || "").replace(/\\\r?\n/g, " "));
  const request = emptyRequest("Imported cURL");
  let method = null;
  let dataParts = [];
  const formParts = [];
  let user = null;
  let url = "";
  const headers = [];
  let urlencode = false;
  let getMode = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = () => tokens[++i];
    if (t === "curl") continue;
    if (t === "-X" || t === "--request") method = (next() || "GET").toUpperCase();
    else if (t === "-H" || t === "--header") headers.push(next() || "");
    else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary" || t === "--data-ascii") dataParts.push(next() || "");
    else if (t === "--data-urlencode") { dataParts.push(next() || ""); urlencode = true; }
    else if (t === "-F" || t === "--form") formParts.push(next() || "");
    else if (t === "-u" || t === "--user") user = next() || "";
    else if (t === "--url") url = next() || "";
    else if (t === "-k" || t === "--insecure") request.settings.verifyTls = false;
    else if (t === "-L" || t === "--location") request.settings.followRedirects = true;
    else if (t === "--max-time") request.settings.timeoutMs = Math.round(parseFloat(next()) * 1000) || 30000;
    else if (t === "-I" || t === "--head") method = "HEAD";
    else if (t === "-G" || t === "--get") { getMode = true; method = "GET"; }
    else if (t === "-s" || t === "-S" || t === "-v" || t === "--compressed" || t === "-o" || t === "--output" || t === "-O") { if (t === "-o" || t === "--output") next(); }
    else if (t.startsWith("-")) { /* ignore unknown flag */ }
    else if (!url) url = t;
  }
  for (const h of headers) {
    const idx = h.indexOf(":");
    if (idx > 0) request.headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true });
  }
  if (url) {
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      request.params = url
        .slice(qIdx + 1)
        .split("&")
        .filter(Boolean)
        .map((pair) => {
          const [k, ...v] = pair.split("=");
          return { key: decodeURIComponent(k || ""), value: decodeURIComponent(v.join("=") || ""), enabled: true };
        });
      url = url.slice(0, qIdx);
    }
    request.url = url;
  }
  if (getMode && dataParts.length) {
    for (const d of dataParts) {
      const eq = d.indexOf("=");
      request.params.push({ key: eq >= 0 ? d.slice(0, eq) : d, value: eq >= 0 ? d.slice(eq + 1) : "", enabled: true });
    }
    dataParts = [];
  }
  if (formParts.length) {
    request.body.mode = "formdata";
    request.body.formdata = formParts.map((f) => {
      const eq = f.indexOf("=");
      const key = eq >= 0 ? f.slice(0, eq) : f;
      let value = eq >= 0 ? f.slice(eq + 1) : "";
      if (value.startsWith("@")) {
        return { key, value: "", type: "file", filename: value.slice(1).split(";")[0], dataBase64: null, enabled: true };
      }
      return { key, value, type: "text", enabled: true };
    });
  } else if (dataParts.length) {
    request.body.mode = "raw";
    request.body.raw.text = dataParts.join("&");
    const hasJsonHeader = request.headers.some((h) => /^content-type$/i.test(h.key) && /json/i.test(h.value));
    request.body.raw.language = hasJsonHeader ? "json" : "text";
    if (!method) method = "POST";
  }
  if (method) request.method = method;
  if (request.method === "GET" && dataParts.length) request.body.mode = "none";
  if (user) {
    const [u, ...p] = user.split(":");
    request.auth.type = "basic";
    request.auth.basic.username = u;
    request.auth.basic.password = p.join(":");
  }
  request.name = request.url ? `${request.method} ${request.url.replace(/^https?:\/\//, "").split("/")[0]}` : "Imported cURL";
  return request;
}

/* -------------------------------------------------------------- curl builder */
function shellQuote(value) {
  const s = String(value == null ? "" : value);
  if (s === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

function buildCurl(request) {
  const parts = ["curl"];
  const method = (request.method || "GET").toUpperCase();
  if (method !== "GET") parts.push("-X", method);
  let url = request.url || "";
  const query = (request.params || []).filter((p) => p.enabled !== false && (p.key || p.value));
  if (query.length) {
    const usp = new URLSearchParams();
    query.forEach((p) => usp.append(p.key, p.value));
    url += (url.includes("?") ? "&" : "?") + usp.toString();
  }
  parts.push(shellQuote(url));
  for (const h of request.headers || []) {
    if (h.enabled === false || !h.key) continue;
    parts.push("-H", shellQuote(`${h.key}: ${h.value}`));
  }
  if (request.auth && request.auth.type === "basic") {
    parts.push("-u", shellQuote(`${request.auth.basic.username}:${request.auth.basic.password}`));
  } else if (request.auth && request.auth.type === "bearer") {
    parts.push("-H", shellQuote(`Authorization: Bearer ${request.auth.bearer.token}`));
  }
  const b = request.body || {};
  if (b.mode === "raw" && b.raw && b.raw.text) parts.push("--data-raw", shellQuote(b.raw.text));
  if (b.mode === "urlencoded") {
    for (const f of b.urlencoded || []) if (f.enabled !== false && f.key) parts.push("--data-urlencode", shellQuote(`${f.key}=${f.value}`));
  }
  if (b.mode === "formdata") {
    for (const f of b.formdata || []) {
      if (f.enabled === false || !f.key) continue;
      parts.push("-F", shellQuote(f.type === "file" ? `${f.key}=@${f.path || f.filename || "file"}` : `${f.key}=${f.value}`));
    }
  }
  if (b.mode === "file" && b.file) parts.push("--data-binary", shellQuote("@" + (b.file.path || b.file.filename || "file")));
  if (request.settings && request.settings.verifyTls === false) parts.push("-k");
  if (request.settings && request.settings.followRedirects === false) parts.push("--no-location");
  return parts.join(" ");
}

module.exports = { importPostman, importAny, importV1Collection, importEnvironment, exportPostman, parseCurl, buildCurl, emptyRequest, newId };
