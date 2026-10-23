"use strict";
/* Request engine: variable resolution, cookies, HTTP execution with timings. */
const http = require("http");
const https = require("https");
const tls = require("tls");
const zlib = require("zlib");
const crypto = require("crypto");
const fs = require("fs");
const { URL, URLSearchParams } = require("url");

const MAX_BODY = 64 * 1024 * 1024;
const MAX_REDIRECTS = 10;

/* ---------------------------------------------------------------- variables */
function dynamicVars(key) {
  switch (key) {
    case "$guid": return crypto.randomUUID();
    case "$timestamp": return String(Date.now());
    case "$randomInt": return String(Math.floor(Math.random() * 1000));
    case "$isoTimestamp": return new Date().toISOString();
    default: return undefined;
  }
}

function lookupVar(name, scopes) {
  for (const scope of scopes) {
    if (!scope) continue;
    if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
  }
  const dyn = dynamicVars(name);
  return dyn;
}

function resolve(str, scopes) {
  if (typeof str !== "string" || str.indexOf("{{") === -1) {
    return { value: str, missing: [] };
  }
  const missing = [];
  const value = str.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (all, name) => {
    const v = lookupVar(name, scopes);
    if (v === undefined || v === null) {
      missing.push(name);
      return all;
    }
    return String(v);
  });
  return { value, missing };
}

/* ------------------------------------------------------------------ cookies */
class CookieJar {
  constructor(initial) {
    this.cookies = Array.isArray(initial) ? initial : [];
  }
  list() {
    const now = Date.now();
    this.cookies = this.cookies.filter((c) => !c.expires || c.expires > now);
    return this.cookies;
  }
  clear() {
    this.cookies = [];
  }
  remove(name, domain, path) {
    this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === path));
    return this.list();
  }
  addFromResponse(setCookieHeaders, url) {
    const u = new URL(url);
    for (const raw of setCookieHeaders || []) {
      const parts = String(raw).split(";");
      const [name, ...rest] = parts[0].split("=");
      if (!name) continue;
      const c = {
        name: name.trim(),
        value: rest.join("=").trim(),
        domain: u.hostname,
        hostOnly: true,
        path: "/",
        expires: null,
        httpOnly: false,
        secure: false,
        sameSite: null,
      };
      for (const attr of parts.slice(1)) {
        const [k, v] = attr.split("=").map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === "domain" && v) { c.domain = v.replace(/^\./, ""); c.hostOnly = false; }
        else if (key === "path" && v) c.path = v;
        else if (key === "expires" && v) { const t = Date.parse(v); if (!isNaN(t)) c.expires = t; }
        else if (key === "max-age" && v) { const s = parseInt(v, 10); if (!isNaN(s)) c.expires = Date.now() + s * 1000; }
        else if (key === "httponly") c.httpOnly = true;
        else if (key === "secure") c.secure = true;
        else if (key === "samesite" && v) c.sameSite = v;
      }
      this.cookies = this.cookies.filter(
        (x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path)
      );
      this.cookies.push(c);
    }
    return this.list();
  }
  headerFor(url) {
    const u = new URL(url);
    const now = Date.now();
    const matches = this.list().filter((c) => {
      if (c.expires && c.expires <= now) return false;
      if (c.secure && u.protocol !== "https:") return false;
      const domainOk = c.hostOnly
        ? u.hostname === c.domain
        : u.hostname === c.domain || u.hostname.endsWith("." + c.domain);
      return domainOk && u.pathname.startsWith(c.path || "/");
    });
    if (!matches.length) return null;
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

/* --------------------------------------------------------------- url/params */
function buildUrl(request, scopes) {
  const r = resolve(request.url || "", scopes);
  let raw = r.value.trim();
  if (!raw) return { url: "", missing: r.missing };
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) raw = "http://" + raw;
  const u = new URL(raw);
  for (const p of request.params || []) {
    if (p.enabled === false || !p.key) continue;
    const key = resolve(p.key, scopes).value;
    const val = resolve(p.value == null ? "" : p.value, scopes).value;
    u.searchParams.append(key, val);
  }
  return { url: u.toString(), missing: r.missing, urlObject: u };
}

function parseQueryIntoParams(url) {
  try {
    const u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : "http://" + url);
    const out = [];
    u.searchParams.forEach((value, key) => out.push({ key, value, enabled: true }));
    return out;
  } catch (_) {
    return [];
  }
}

/* -------------------------------------------------------------------- body */
function buildBody(request, scopes) {
  const body = request.body || { mode: "none" };
  const headers = [];
  let buffer = Buffer.alloc(0);
  const mode = body.mode || "none";
  if (mode === "none") return { buffer, headers };

  if (mode === "raw") {
    const text = resolve((body.raw && body.raw.text) || "", scopes).value;
    buffer = Buffer.from(text, "utf8");
    const lang = (body.raw && body.raw.language) || "text";
    const defaults = {
      json: "application/json",
      javascript: "application/javascript",
      xml: "application/xml",
      html: "text/html",
      text: "text/plain",
    };
    headers.push({ key: "Content-Type", value: defaults[lang] || "text/plain" });
  } else if (mode === "urlencoded") {
    const usp = new URLSearchParams();
    for (const f of body.urlencoded || []) {
      if (f.enabled === false || !f.key) continue;
      usp.append(resolve(f.key, scopes).value, resolve(f.value == null ? "" : f.value, scopes).value);
    }
    buffer = Buffer.from(usp.toString(), "utf8");
    headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
  } else if (mode === "formdata") {
    const boundary = "----ReplicateBoundary" + crypto.randomBytes(12).toString("hex");
    const chunks = [];
    for (const f of body.formdata || []) {
      if (f.enabled === false || !f.key) continue;
      const key = resolve(f.key, scopes).value;
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      if (f.type === "file") {
        const filename = f.filename || "file";
        const contentType = f.contentType || "application/octet-stream";
        chunks.push(
          Buffer.from(`Content-Disposition: form-data; name="${key}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`)
        );
        chunks.push(f.dataBase64 ? Buffer.from(f.dataBase64, "base64") : Buffer.alloc(0));
        chunks.push(Buffer.from("\r\n"));
      } else {
        const value = resolve(f.value == null ? "" : f.value, scopes).value;
        chunks.push(Buffer.from(`Content-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
      }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    buffer = Buffer.concat(chunks);
    headers.push({ key: "Content-Type", value: `multipart/form-data; boundary=${boundary}` });
  } else if (mode === "file") {
    buffer = body.file && body.file.dataBase64 ? Buffer.from(body.file.dataBase64, "base64") : Buffer.alloc(0);
    const name = (body.file && body.file.filename) || "file";
    headers.push({ key: "Content-Type", value: "application/octet-stream" });
    headers.push({ key: "Content-Disposition", value: `attachment; filename="${name}"` });
  } else if (mode === "graphql") {
    const query = resolve((body.graphql && body.graphql.query) || "", scopes).value;
    let variables = (body.graphql && body.graphql.variables) || "";
    if (typeof variables === "string" && variables.trim()) {
      try { variables = JSON.parse(variables); } catch (_) { variables = undefined; }
    }
    buffer = Buffer.from(JSON.stringify({ query, variables }), "utf8");
    headers.push({ key: "Content-Type", value: "application/json" });
  }
  return { buffer, headers };
}

/* -------------------------------------------------------------------- auth */
function applyAuth(request, scopes, headers, urlObject) {
  const auth = request.auth || { type: "none" };
  const H = (key) => headers.find((h) => h.key.toLowerCase() === key.toLowerCase());
  if (auth.type === "basic") {
    const user = resolve((auth.basic && auth.basic.username) || "", scopes).value;
    const pass = resolve((auth.basic && auth.basic.password) || "", scopes).value;
    const token = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    headers.push({ key: "Authorization", value: `Basic ${token}` });
  } else if (auth.type === "bearer") {
    const token = resolve((auth.bearer && auth.bearer.token) || "", scopes).value;
    headers.push({ key: "Authorization", value: `Bearer ${token}` });
  } else if (auth.type === "oauth2") {
    const token = resolve((auth.oauth2 && auth.oauth2.token) || "", scopes).value;
    const prefix = (auth.oauth2 && auth.oauth2.headerPrefix) || "Bearer";
    headers.push({ key: "Authorization", value: `${prefix} ${token}`.trim() });
  } else if (auth.type === "apikey") {
    const key = resolve((auth.apikey && auth.apikey.key) || "", scopes).value;
    const value = resolve((auth.apikey && auth.apikey.value) || "", scopes).value;
    if (auth.apikey && auth.apikey.in === "query") urlObject.searchParams.append(key, value);
    else headers.push({ key, value });
  }
  if (!H("user-agent")) headers.push({ key: "User-Agent", value: "PostmanReplicate/0.1.0" });
  if (!H("accept")) headers.push({ key: "Accept", value: "*/*" });
  if (!H("accept-encoding")) headers.push({ key: "Accept-Encoding", value: "gzip, deflate, br" });
}

function decompress(buffer, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc.includes("gzip")) return { buffer: zlib.gunzipSync(buffer), encoding: "gzip" };
    if (enc.includes("deflate")) return { buffer: zlib.inflateSync(buffer), encoding: "deflate" };
    if (enc.includes("br")) return { buffer: zlib.brotliDecompressSync(buffer), encoding: "br" };
  } catch (_) {}
  return { buffer, encoding: null };
}

function decodeText(buffer, contentType) {
  const m = /charset=([^;]+)/i.exec(contentType || "");
  let charset = (m && m[1] || "utf-8").trim().replace(/^["']|["']$/g, "").toLowerCase();
  try {
    if (charset === "utf-8" || charset === "utf8" || charset === "us-ascii") return { text: buffer.toString("utf8"), charset };
    if (charset === "latin1" || charset === "iso-8859-1") return { text: buffer.toString("latin1"), charset };
    if (charset === "utf-16le" || charset === "utf-16") return { text: buffer.toString("utf16le"), charset };
    return { text: buffer.toString("utf8"), charset };
  } catch (_) {
    return { text: buffer.toString("utf8"), charset: "utf-8" };
  }
}

function isTextual(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (!ct) return true;
  if (/^(text\/|application\/(json|xml|javascript|xhtml\+xml|graphql|x-www-form-urlencoded|ld\+json|soap\+xml|yaml|x-yaml))/.test(ct)) return true;
  if (ct.startsWith("image/svg")) return true;
  return false;
}

/* ------------------------------------------------------------------- TLS */
function readTlsOptions(settings) {
  const tls = settings && settings.tls;
  const out = {};
  if (!tls) return out;
  const read = (label, filePath) => {
    if (!filePath) return undefined;
    try {
      return fs.readFileSync(filePath);
    } catch (e) {
      throw new Error(`${label} not readable (${filePath}): ${e.message}`);
    }
  };
  if (tls.caPath) out.ca = read("Custom CA", tls.caPath);
  if (tls.clientCert) {
    if (tls.type === "pfx") {
      out.pfx = read("PKCS#12 file", tls.pfxPath);
      if (tls.passphrase) out.passphrase = tls.passphrase;
    } else {
      out.cert = read("Client certificate", tls.certPath);
      out.key = read("Client key", tls.keyPath || tls.certPath);
      if (tls.passphrase) out.passphrase = tls.passphrase;
    }
  }
  return out;
}

function readProxyConfig(value) {
  if (!value || value.enabled !== true) return null;
  let raw = String(value.url || "").trim();
  if (!raw) throw new Error("Proxy is enabled but no proxy URL is configured");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new Error("Invalid proxy URL: " + e.message);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Proxy must use http:// or https://");
  const username = url.username ? decodeURIComponent(url.username) : "";
  const password = url.password ? decodeURIComponent(url.password) : "";
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
    auth: username || password ? "Basic " + Buffer.from(username + ":" + password, "utf8").toString("base64") : null,
    bypass: String(value.bypass || value.noProxy || ""),
  };
}

function proxyForTarget(proxy, target) {
  if (!proxy) return null;
  const host = target.hostname.toLowerCase();
  const tokens = proxy.bypass.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const token of tokens) {
    if (token === "*") return null;
    if (token === "<local>" && (host === "localhost" || !host.includes("."))) return null;
    const domain = token.replace(/^\./, "");
    if (host === domain || host.endsWith("." + domain)) return null;
  }
  return proxy;
}

/* ----------------------------------------------------------------- execute */
function execute(request, options) {
  const opts = options || {};
  const scopes = opts.scopes || [];
  const jar = opts.jar;
  const settings = Object.assign(
    { followRedirects: true, verifyTls: true, timeoutMs: 30000, maxRedirects: MAX_REDIRECTS },
    request.settings || {},
    opts.settings || {}
  );

  return new Promise((resolvePromise) => {
    const missing = new Set();
    const built = buildUrl(request, scopes);
    missingAdd(missing, built.missing);
    if (!built.url) {
      return resolvePromise({ ok: false, error: { message: "Missing or invalid request URL" } });
    }

    const headers = [];
    for (const h of request.headers || []) {
      if (h.enabled === false || !h.key) continue;
      headers.push({ key: resolve(h.key, scopes).value, value: resolve(h.value == null ? "" : h.value, scopes).value });
    }
    const body = buildBody(request, scopes);
    for (const h of body.headers) {
      if (!headers.some((x) => x.key.toLowerCase() === h.key.toLowerCase())) headers.push(h);
    }
    applyAuth(request, scopes, headers, built.urlObject);

    const method = String(request.method || "GET").toUpperCase();
    const redirects = [];
    const startAll = process.hrtime.bigint();
    const timeoutMs = settings.timeoutMs || 30000;
    let tlsOptions = {};
    let proxyConfig = null;
    try {
      tlsOptions = readTlsOptions(settings);
    } catch (e) {
      return resolvePromise({ ok: false, error: { message: e.message, code: "TLS_MATERIAL" } });
    }
    try {
      proxyConfig = readProxyConfig(settings.proxy);
    } catch (e) {
      return resolvePromise({ ok: false, error: { message: e.message, code: "PROXY_CONFIG" } });
    }
    let activeJar = jar;

    const hop = (urlString, hopMethod, hopBody, depth) => {
      let target;
      try {
        target = new URL(urlString);
      } catch (e) {
        return resolvePromise({ ok: false, error: { message: "Invalid URL: " + urlString } });
      }
      const lib = target.protocol === "https:" ? https : http;
      const isHttps = target.protocol === "https:";
      const headerObj = {};
      for (const h of headers) {
        if (h.key) headerObj[h.key] = h.value;
      }
      if (activeJar && settings.sendCookies !== false && !Object.keys(headerObj).some((key) => key.toLowerCase() === "cookie")) {
        const cookieHeader = activeJar.headerFor(target.toString());
        if (cookieHeader) headerObj.Cookie = cookieHeader;
      }
      if (hopBody && hopBody.length && !("Content-Length" in headerObj || "content-length" in headerObj)) {
        headerObj["Content-Length"] = String(hopBody.length);
      } else if (hopBody && !hopBody.length) {
        delete headerObj["Content-Length"];
      }

      const timing = { start: process.hrtime.bigint() };
      let settled = false;
      const done = (payload) => {
        if (settled) return;
        settled = true;
        resolvePromise(payload);
      };
      const finishError = (err) => {
        const endTime = process.hrtime.bigint();
        done({
          ok: false,
          url: target.toString(),
          error: { message: err.message, code: err.code || null },
          timings: { total: Number(endTime - timing.start) / 1e6 },
          missingVariables: Array.from(missing),
        });
      };

      const onResponse = (res) => {
        timing.response = process.hrtime.bigint();
        const setCookies = res.headers["set-cookie"] || [];
        if (activeJar) activeJar.addFromResponse(setCookies, target.toString());

        const chunks = [];
        let received = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          if (!timing.firstData) timing.firstData = process.hrtime.bigint();
          received += chunk.length;
          if (received <= MAX_BODY) chunks.push(chunk);
          else truncated = true;
        });
        res.on("end", () => {
          const endTime = process.hrtime.bigint();
          const rawBuffer = Buffer.concat(chunks);
          const contentEncoding = res.headers["content-encoding"];
          const dec = decompress(rawBuffer, contentEncoding);
          const contentType = res.headers["content-type"] || "";
          const textual = isTextual(contentType) || dec.buffer.indexOf(0) === -1;
          const decoded = decodeText(dec.buffer, contentType);
          const headerList = [];
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) value.forEach((v) => headerList.push({ key, value: v }));
            else headerList.push({ key, value: String(value) });
          }
          const ms = (a, b) => (b && a ? Number(b - a) / 1e6 : null);
          const payload = {
            ok: true,
            status: res.statusCode,
            statusText: res.statusMessage || "",
            httpVersion: res.httpVersion,
            headers: headerList,
            cookies: (setCookies || []).map((c) => c),
            body: {
              size: dec.buffer.length,
              received,
              truncated,
              mime: contentType,
              charset: decoded.charset,
              encoding: dec.encoding,
              isText: textual,
              text: textual ? decoded.text : null,
              base64: textual ? null : dec.buffer.toString("base64"),
            },
            url: target.toString(),
            redirects,
            timings: {
              total: ms(timing.start, endTime),
              dns: ms(timing.start, timing.lookup),
              tcp: ms(timing.lookup || timing.start, timing.connect),
              tls: ms(timing.connect, timing.secureConnect),
              firstByte: ms(timing.start, timing.firstData),
              download: ms(timing.firstData, endTime),
            },
            missingVariables: Array.from(missing),
          };

          const status = res.statusCode;
          const location = res.headers.location;
          const canRedirect =
            settings.followRedirects !== false &&
            location &&
            [301, 302, 303, 307, 308].includes(status) &&
            depth < settings.maxRedirects;
          if (canRedirect) {
            const nextUrl = new URL(location, target).toString();
            redirects.push({ status, from: target.toString(), to: nextUrl });
            let nextMethod = hopMethod;
            let nextBody = hopBody;
            if (status === 303 || ((status === 301 || status === 302) && hopMethod === "POST")) {
              nextMethod = "GET";
              nextBody = Buffer.alloc(0);
            }
            return hop(nextUrl, nextMethod, nextBody, depth + 1);
          }
          if (status >= 300 && status < 400 && location) {
            payload.notFollowedRedirect = new URL(location, target).toString();
          }
          done(payload);
        });
        res.on("error", (err) => finishError(err));
      };

      const attachRequest = (req) => {
        req.on("socket", (socket) => {
          socket.on("lookup", () => { timing.lookup = process.hrtime.bigint(); });
          socket.on("connect", () => { timing.connect = process.hrtime.bigint(); });
          socket.on("secureConnect", () => { timing.secureConnect = process.hrtime.bigint(); });
        });
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error("Request timed out after " + timeoutMs + "ms"));
        });
        req.on("error", finishError);
      };

      const proxy = proxyConfig ? proxyForTarget(proxyConfig, target) : null;
      if (!proxy) {
        const req = lib.request(
          Object.assign(
            {
              method: hopMethod,
              protocol: target.protocol,
              hostname: target.hostname,
              port: target.port || (isHttps ? 443 : 80),
              path: target.pathname + target.search,
              headers: headerObj,
              rejectUnauthorized: settings.verifyTls !== false,
              servername: target.hostname,
            },
            isHttps ? tlsOptions : {}
          ),
          onResponse
        );
        attachRequest(req);
        if (hopBody && hopBody.length) req.write(hopBody);
        req.end();
        return;
      }

      const proxyLib = proxy.protocol === "https:" ? https : http;
      const proxyTls = proxy.protocol === "https:" ? { rejectUnauthorized: settings.verifyTls !== false, servername: proxy.hostname } : {};
      const proxyHeaders = Object.assign({}, headerObj);
      if (!Object.keys(proxyHeaders).some((key) => key.toLowerCase() === "host")) proxyHeaders.Host = target.host;
      if (proxy.auth) proxyHeaders["Proxy-Authorization"] = proxy.auth;

      if (!isHttps) {
        const req = proxyLib.request(
          Object.assign(
            {
              method: hopMethod,
              hostname: proxy.hostname,
              port: proxy.port,
              path: target.protocol + "//" + target.host + target.pathname + target.search,
              headers: proxyHeaders,
              rejectUnauthorized: settings.verifyTls !== false,
              servername: proxy.hostname,
            },
            proxyTls
          ),
          onResponse
        );
        attachRequest(req);
        if (hopBody && hopBody.length) req.write(hopBody);
        req.end();
        return;
      }

      const connectHeaders = { Host: target.host };
      if (proxy.auth) connectHeaders["Proxy-Authorization"] = proxy.auth;
      const connectReq = proxyLib.request(
        Object.assign(
          {
            method: "CONNECT",
            hostname: proxy.hostname,
            port: proxy.port,
            path: target.hostname + ":" + (target.port || 443),
            headers: connectHeaders,
            rejectUnauthorized: settings.verifyTls !== false,
            servername: proxy.hostname,
          },
          proxyTls
        )
      );
      connectReq.setTimeout(timeoutMs, () => {
        connectReq.destroy(new Error("Proxy CONNECT timed out after " + timeoutMs + "ms"));
      });
      connectReq.on("error", finishError);
      connectReq.on("connect", (res, socket, head) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          finishError(new Error("Proxy CONNECT failed: " + res.statusCode + " " + (res.statusMessage || "")));
          return;
        }
        timing.connect = timing.connect || process.hrtime.bigint();
        if (head && head.length) socket.unshift(head);
        const tlsSocket = tls.connect(
          Object.assign(
            {
              socket,
              servername: target.hostname,
              rejectUnauthorized: settings.verifyTls !== false,
            },
            tlsOptions
          ),
          () => {
            timing.secureConnect = process.hrtime.bigint();
            const finalReq = https.request(
              {
                method: hopMethod,
                hostname: target.hostname,
                port: target.port || 443,
                path: target.pathname + target.search,
                headers: headerObj,
                createConnection: () => tlsSocket,
                agent: false,
                rejectUnauthorized: settings.verifyTls !== false,
                servername: target.hostname,
              },
              onResponse
            );
            attachRequest(finalReq);
            if (hopBody && hopBody.length) finalReq.write(hopBody);
            finalReq.end();
          }
        );
        tlsSocket.on("error", finishError);
      });
      connectReq.end();
    };

    hop(built.url, method, body.buffer, 0);
  });
}

function missingAdd(set, list) {
  for (const x of list || []) set.add(x);
}

module.exports = {
  resolve,
  lookupVar,
  buildUrl,
  parseQueryIntoParams,
  execute,
  CookieJar,
};
