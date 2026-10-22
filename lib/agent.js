"use strict";
/* Shared automation API for the CLI and MCP server.
   This module does not require Electron; it uses the same data files and engine. */
const fs = require("fs");
const path = require("path");
const engine = require("./engine");
const io = require("./io");
const { runScript } = require("./script");
const { Store } = require("./store");

const SRC_ROOT = path.resolve(__dirname, "..");

function defaultDataDir() {
  if (process.env.POSTMAN_REPLICATE_DATA) return path.resolve(process.env.POSTMAN_REPLICATE_DATA);
  if (process.env.REPLICATE_DATA_DIR) return path.resolve(process.env.REPLICATE_DATA_DIR);
  const parent = path.dirname(SRC_ROOT);
  if (path.basename(parent) === "resources") return path.join(path.dirname(parent), "data");
  return path.join(SRC_ROOT, "data");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

function normalizeVariables(list) {
  return asArray(list)
    .filter((row) => row && (row.key || row.value != null))
    .map((row) => ({
      key: stringValue(row.key),
      value: stringValue(row.value),
      enabled: row.enabled !== false,
      ...(row.secret ? { secret: true } : {}),
    }));
}

function normalizeHeaders(list) {
  return asArray(list).map((row) => ({
    key: stringValue(row.key),
    value: stringValue(row.value),
    enabled: row.enabled !== false,
  }));
}

function normalizeParams(list) {
  return normalizeHeaders(list);
}

function normalizeRequest(input, name) {
  const src = input && typeof input === "object" ? input : {};
  const request = io.emptyRequest(name || src.name || "Untitled Request");
  if (src.id) request.id = stringValue(src.id);
  if (src.name) request.name = stringValue(src.name);
  if (src.description != null) request.description = stringValue(src.description);
  request.method = stringValue(src.method || request.method || "GET").toUpperCase();
  if (src.url != null) request.url = stringValue(src.url);
  if (src.params) request.params = normalizeParams(src.params);
  if (src.headers) request.headers = normalizeHeaders(src.headers);
  if (src.body && typeof src.body === "object") {
    request.body = Object.assign(request.body, src.body);
    request.body.raw = Object.assign({ language: "json", text: "" }, request.body.raw || {});
    request.body.graphql = Object.assign({ query: "", variables: "" }, request.body.graphql || {});
    request.body.urlencoded = asArray(request.body.urlencoded);
    request.body.formdata = asArray(request.body.formdata);
  }
  if (src.auth && typeof src.auth === "object") {
    request.auth = Object.assign(request.auth, src.auth);
    for (const key of ["basic", "bearer", "apikey", "oauth2"]) {
      request.auth[key] = Object.assign(request.auth[key] || {}, (src.auth && src.auth[key]) || {});
    }
  }
  if (src.scripts && typeof src.scripts === "object") request.scripts = Object.assign(request.scripts, src.scripts);
  if (src.settings && typeof src.settings === "object") {
    request.settings = Object.assign(request.settings, src.settings);
    request.settings.tls = Object.assign(io.emptyRequest().settings.tls, src.settings.tls || {});
  }
  return request;
}

function mergeRequest(base, patch) {
  const out = normalizeRequest(base, base && base.name);
  if (!patch || typeof patch !== "object") return out;
  for (const key of ["name", "description", "method", "url"]) {
    if (patch[key] !== undefined) out[key] = key === "method" ? stringValue(patch[key]).toUpperCase() : stringValue(patch[key]);
  }
  if (patch.params) out.params = normalizeParams(patch.params);
  if (patch.headers) out.headers = normalizeHeaders(patch.headers);
  if (patch.body && typeof patch.body === "object") {
    out.body = Object.assign({}, out.body, patch.body);
    out.body.raw = Object.assign({ language: "json", text: "" }, out.body.raw || {});
    out.body.graphql = Object.assign({ query: "", variables: "" }, out.body.graphql || {});
    out.body.urlencoded = asArray(out.body.urlencoded);
    out.body.formdata = asArray(out.body.formdata);
  }
  if (patch.auth && typeof patch.auth === "object") {
    out.auth = Object.assign({}, out.auth, patch.auth);
    for (const key of ["basic", "bearer", "apikey", "oauth2"]) {
      out.auth[key] = Object.assign({}, out.auth[key] || {}, (patch.auth && patch.auth[key]) || {});
    }
  }
  if (patch.scripts && typeof patch.scripts === "object") out.scripts = Object.assign({}, out.scripts, patch.scripts);
  if (patch.settings && typeof patch.settings === "object") {
    out.settings = Object.assign({}, out.settings, patch.settings);
    out.settings.tls = Object.assign({}, io.emptyRequest().settings.tls, out.settings.tls || {}, patch.settings.tls || {});
  }
  return out;
}

function findCollection(collections, reference) {
  if (!reference) return null;
  return asArray(collections).find((col) => col.id === reference) || asArray(collections).find((col) => col.name === reference) || null;
}

function walkItems(items, callback, folderPath) {
  for (const item of asArray(items)) {
    const here = folderPath || [];
    const result = callback(item, here);
    if (result !== undefined) return result;
    if (item && Array.isArray(item.items)) {
      const found = walkItems(item.items, callback, here.concat(item.name));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function findRequestEntry(collections, id) {
  for (const collection of asArray(collections)) {
    let found = null;
    walkItems(collection.items, (item, folderPath) => {
      if (item && item.id === id && item.type !== "folder") {
        found = { collection, item, folderPath };
        return found;
      }
      return undefined;
    });
    if (found) return found;
  }
  return null;
}

function findFolder(collection, reference) {
  if (!reference) return null;
  let found = null;
  walkItems(collection.items, (item) => {
    if (item && item.id === reference && item.type === "folder") {
      found = item;
      return found;
    }
    return undefined;
  });
  return found;
}

function listRequestEntries(collection, folder) {
  const out = [];
  const walk = (items, folderPath) => {
    for (const item of asArray(items)) {
      if (item && item.type === "folder") {
        walk(item.items, folderPath.concat(item.name));
      } else if (item && item.request) {
        out.push({ item, folderPath });
      }
    }
  };
  walk(folder ? folder.items : collection.items, folder ? [folder.name] : []);
  return out;
}

function requestSummary(collection, item, folderPath) {
  return {
    id: item.id,
    name: item.name,
    description: item.description || "",
    method: (item.request && item.request.method) || "GET",
    url: (item.request && item.request.url) || "",
    collectionId: collection.id,
    collectionName: collection.name,
    folderPath: folderPath || [],
  };
}

function varsToObject(list, respectDisabled) {
  const out = {};
  for (const row of asArray(list)) {
    if (!row || !row.key) continue;
    if (respectDisabled && row.enabled === false) continue;
    out[row.key] = row.value;
  }
  return out;
}

function upsertVariable(list, key, value, enabled) {
  const row = asArray(list).find((item) => item && item.key === key);
  if (row) {
    row.value = stringValue(value);
    if (enabled !== undefined) row.enabled = enabled !== false;
    else if (Object.prototype.hasOwnProperty.call(row, "enabled")) row.enabled = true;
    return row;
  }
  const next = { key, value: stringValue(value), enabled: enabled !== false };
  list.push(next);
  return next;
}

function truncateBody(body, maxBodyBytes) {
  const limit = Number(maxBodyBytes);
  if (!Number.isFinite(limit) || limit <= 0 || !body) return;
  if (typeof body.text === "string" && body.text.length > limit) {
    body.text = body.text.slice(0, limit) + "\n…[truncated by agent; use maxBodyBytes: 0 for full body]";
    body.truncatedForAgent = true;
  }
  if (typeof body.base64 === "string" && body.base64.length > limit) {
    body.base64 = body.base64.slice(0, limit) + "…[truncated by agent]";
    body.truncatedForAgent = true;
  }
}

function applyMutations(store, env, globals, result) {
  if (env && result.environment) {
    const environments = store.load("environments", []);
    const index = environments.findIndex((item) => item.id === env.id);
    if (index >= 0) {
      const values = asArray(environments[index].values).slice();
      for (const [key, value] of Object.entries(result.environment)) upsertVariable(values, key, value, true);
      environments[index].values = values;
      env.values = values;
      store.save("environments", environments);
    }
  }
  if (result.globals) {
    const values = [];
    for (const [key, value] of Object.entries(result.globals)) values.push({ key, value: stringValue(value), enabled: true });
    store.save("globals", values);
    if (globals) {
      globals.length = 0;
      globals.push(...values);
    }
  }
}

class Agent {
  constructor(options) {
    const opts = options || {};
    this.dataDir = path.resolve(opts.dataDir || defaultDataDir());
  }

  store() {
    return new Store(this.dataDir);
  }

  listCollections() {
    const store = this.store();
    return asArray(store.load("collections", [])).map((collection) => ({
      id: collection.id,
      name: collection.name,
      description: collection.description || "",
      variableCount: asArray(collection.variables).length,
      folderCount: asArray(collection.items).filter((item) => item && item.type === "folder").length,
      requestCount: listRequestEntries(collection, null).length,
    }));
  }

  getCollection(input) {
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, input && (input.collection || input.id || input.name));
    if (!collection) throw new Error("Collection not found");
    return clone(collection);
  }

  listRequests(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const targets = args.collection || args.collectionId
      ? [findCollection(collections, args.collection || args.collectionId)].filter(Boolean)
      : collections;
    const out = [];
    for (const collection of targets) {
      const folder = args.folder || args.folderId ? findFolder(collection, args.folder || args.folderId) : null;
      if ((args.folder || args.folderId) && !folder) continue;
      for (const entry of listRequestEntries(collection, folder)) out.push(requestSummary(collection, entry.item, entry.folderPath));
    }
    return out;
  }

  getRequest(input) {
    const store = this.store();
    const collections = store.load("collections", []);
    const entry = findRequestEntry(collections, input && (input.id || input.requestId));
    if (!entry) throw new Error("Request not found");
    return {
      ...requestSummary(entry.collection, entry.item, entry.folderPath),
      item: clone(entry.item),
      collection: {
        id: entry.collection.id,
        name: entry.collection.name,
        variables: clone(asArray(entry.collection.variables)),
      },
    };
  }

  createCollection(input) {
    const args = input || {};
    const name = stringValue(args.name).trim();
    if (!name) throw new Error("Collection name is required");
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = {
      id: io.newId("col"),
      name,
      description: stringValue(args.description),
      variables: normalizeVariables(args.variables),
      items: [],
    };
    collections.push(collection);
    store.save("collections", collections);
    return { id: collection.id, name: collection.name };
  }

  updateCollection(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.id || args.name);
    if (!collection) throw new Error("Collection not found");
    if (args.name !== undefined) collection.name = stringValue(args.name) || collection.name;
    if (args.description !== undefined) collection.description = stringValue(args.description);
    if (args.variables !== undefined) collection.variables = normalizeVariables(args.variables);
    store.save("collections", collections);
    return { id: collection.id, name: collection.name };
  }

  deleteCollection(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.id || args.name);
    if (!collection) throw new Error("Collection not found");
    store.save("collections", collections.filter((item) => item !== collection));
    return { deleted: collection.id, name: collection.name };
  }

  createFolder(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.collectionId);
    if (!collection) throw new Error("Collection not found");
    const parent = args.folder || args.folderId ? findFolder(collection, args.folder || args.folderId) : null;
    if ((args.folder || args.folderId) && !parent) throw new Error("Parent folder not found");
    const folder = {
      id: io.newId("fld"),
      type: "folder",
      name: stringValue(args.name).trim() || "New Folder",
      description: stringValue(args.description),
      items: [],
    };
    (parent ? parent.items : collection.items).push(folder);
    store.save("collections", collections);
    return { id: folder.id, name: folder.name, collectionId: collection.id, parentId: parent ? parent.id : null };
  }

  createRequest(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.collectionId);
    if (!collection) throw new Error("Collection not found");
    const folder = args.folder || args.folderId ? findFolder(collection, args.folder || args.folderId) : null;
    if ((args.folder || args.folderId) && !folder) throw new Error("Folder not found");
    const name = stringValue(args.name || (args.request && args.request.name)).trim() || "New Request";
    const request = normalizeRequest(args.request || {}, name);
    const item = { id: io.newId("req"), type: "request", name, description: stringValue(args.description), request };
    (folder ? folder.items : collection.items).push(item);
    store.save("collections", collections);
    return { id: item.id, name: item.name, collectionId: collection.id, folderId: folder ? folder.id : null };
  }

  updateRequest(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const entry = findRequestEntry(collections, args.id || args.requestId);
    if (!entry) throw new Error("Request not found");
    if (args.name !== undefined) {
      entry.item.name = stringValue(args.name) || entry.item.name;
      entry.item.request.name = entry.item.name;
    }
    if (args.description !== undefined) entry.item.description = stringValue(args.description);
    if (args.request !== undefined) {
      entry.item.request = mergeRequest(entry.item.request, args.request);
      if (!entry.item.request.name) entry.item.request.name = entry.item.name;
    }
    store.save("collections", collections);
    return { id: entry.item.id, name: entry.item.name, collectionId: entry.collection.id };
  }

  deleteRequest(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const targetId = args.id || args.requestId;
    let removed = null;
    for (const collection of collections) {
      const removeFrom = (items) => {
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          if (item && item.id === targetId && item.type !== "folder") {
            removed = items[index];
            items.splice(index, 1);
            return true;
          }
          if (item && Array.isArray(item.items) && removeFrom(item.items)) return true;
        }
        return false;
      };
      if (removeFrom(collection.items)) break;
    }
    if (!removed) throw new Error("Request not found");
    store.save("collections", collections);
    return { deleted: targetId, name: removed.name };
  }

  importPostman(input) {
    const args = input || {};
    const json = args.json !== undefined ? args.json : args.postman;
    if (!json) throw new Error("Postman JSON is required");
    const imported = io.importAny(json);
    const store = this.store();
    const collections = store.load("collections", []);
    const environments = store.load("environments", []);
    collections.push(...imported.collections);
    environments.push(...imported.environments);
    store.save("collections", collections);
    store.save("environments", environments);
    if (imported.globals && imported.globals.length) store.save("globals", imported.globals);
    return {
      collections: imported.collections.map((item) => ({ id: item.id, name: item.name })),
      environments: imported.environments.map((item) => ({ id: item.id, name: item.name })),
      globals: imported.globals.length,
    };
  }

  exportCollection(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.id || args.name);
    if (!collection) throw new Error("Collection not found");
    return io.exportPostman(collection);
  }

  listEnvironments() {
    const store = this.store();
    const settings = store.load("settings", {});
    return {
      activeEnvironmentId: settings.activeEnvironmentId || null,
      environments: asArray(store.load("environments", [])).map((env) => ({
        id: env.id,
        name: env.name,
        values: clone(asArray(env.values)),
      })),
    };
  }

  createEnvironment(input) {
    const args = input || {};
    const store = this.store();
    const environments = store.load("environments", []);
    const env = { id: io.newId("env"), name: stringValue(args.name).trim() || "New Environment", values: normalizeVariables(args.values) };
    environments.push(env);
    store.save("environments", environments);
    return { id: env.id, name: env.name };
  }

  setEnvironmentVariable(input) {
    const args = input || {};
    const store = this.store();
    const environments = store.load("environments", []);
    const env = environments.find((item) => item.id === (args.environment || args.environmentId)) ||
      environments.find((item) => item.name === (args.environment || args.environmentName));
    if (!env) throw new Error("Environment not found");
    env.values = asArray(env.values);
    upsertVariable(env.values, stringValue(args.key), args.value, args.enabled);
    store.save("environments", environments);
    return { environmentId: env.id, key: args.key, value: stringValue(args.value), enabled: args.enabled !== false };
  }

  setActiveEnvironment(input) {
    const args = input || {};
    const store = this.store();
    const environments = store.load("environments", []);
    let env = null;
    if (args.environment || args.environmentId || args.name) {
      env = environments.find((item) => item.id === (args.environment || args.environmentId || args.name)) ||
        environments.find((item) => item.name === (args.environment || args.name));
      if (!env) throw new Error("Environment not found");
    }
    const settings = store.load("settings", {});
    settings.activeEnvironmentId = env ? env.id : null;
    store.save("settings", settings);
    return { activeEnvironmentId: settings.activeEnvironmentId, name: env ? env.name : null };
  }

  listGlobals() {
    return clone(asArray(this.store().load("globals", [])));
  }

  setGlobalVariable(input) {
    const args = input || {};
    const store = this.store();
    const globals = asArray(store.load("globals", []));
    upsertVariable(globals, stringValue(args.key), args.value, args.enabled);
    store.save("globals", globals);
    return { key: args.key, value: stringValue(args.value), enabled: args.enabled !== false };
  }

  listCookies() {
    const store = this.store();
    return asArray(store.load("cookies", []));
  }

  clearCookies() {
    this.store().save("cookies", []);
    return [];
  }

  listHistory(input) {
    const args = input || {};
    const limit = Math.max(1, Math.min(1000, Number(args.limit) || 20));
    return asArray(this.store().load("history", [])).slice(0, limit).map((entry) => ({
      id: entry.id,
      time: entry.time,
      name: entry.name,
      method: entry.request && entry.request.method,
      url: entry.request && entry.request.url,
      status: entry.response && entry.response.status,
      durationMs: entry.durationMs,
      ok: !!(entry.response && entry.response.ok),
    }));
  }

  async sendRequest(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const settings = store.load("settings", {});
    const globals = asArray(store.load("globals", []));
    const environments = asArray(store.load("environments", []));
    let entry = null;
    let collection = null;
    let request;
    if (args.requestId || args.id) {
      entry = findRequestEntry(collections, args.requestId || args.id);
      if (!entry) throw new Error("Saved request not found");
      collection = entry.collection;
      request = normalizeRequest(entry.item.request, entry.item.name);
    } else {
      request = normalizeRequest(args.request || {
        method: args.method,
        url: args.url,
        headers: args.headers,
        params: args.params,
        body: args.body,
        auth: args.auth,
      }, args.name);
      if (args.collection || args.collectionId) collection = findCollection(collections, args.collection || args.collectionId);
    }
    if (!request.url) throw new Error("Request URL is required");
    const env = args.environment || args.environmentId
      ? environments.find((item) => item.id === (args.environment || args.environmentId)) ||
        environments.find((item) => item.name === (args.environment || args.environmentId)) || null
      : environments.find((item) => item.id === settings.activeEnvironmentId) || null;
    if ((args.environment || args.environmentId) && !env) throw new Error("Environment not found");

    const session = Object.assign({}, args.variables || args.sessionVariables || {});
    let requestForSend = clone(request);
    let logs = [];
    let testResults = [];
    if (request.scripts && request.scripts.preRequest) {
      const pre = runScript(request.scripts.preRequest, "prerequest", {
        environment: env ? varsToObject(env.values, true) : {},
        globals: varsToObject(globals, false),
        collectionVariables: collection ? varsToObject(collection.variables, false) : {},
        sessionVariables: Object.assign({}, session),
        request: requestForSend,
        requestName: request.name,
      });
      logs.push(...pre.logs);
      if (pre.error) logs.push({ level: "error", message: "Pre-request script: " + pre.error });
      applyMutations(store, env, globals, pre);
      if (pre.requestMutations && pre.requestMutations.length) {
        requestForSend.headers = pre.requestMutations.map((header) => ({ key: header.key, value: header.value, enabled: true }));
      }
      Object.assign(session, pre.sessionVariables);
    }

    const jar = new engine.CookieJar(store.load("cookies", []));
    const response = await engine.execute(requestForSend, {
      scopes: [
        session,
        env ? varsToObject(env.values, true) : {},
        collection ? varsToObject(collection.variables, false) : {},
        varsToObject(globals, false),
      ],
      jar,
      settings: settings.bypassTls === true ? { verifyTls: false } : requestForSend.settings,
    });

    if (response.ok && request.scripts && request.scripts.tests) {
      const post = runScript(request.scripts.tests, "tests", {
        environment: env ? varsToObject(env.values, true) : {},
        globals: varsToObject(globals, false),
        collectionVariables: collection ? varsToObject(collection.variables, false) : {},
        sessionVariables: Object.assign({}, session),
        request: requestForSend,
        response,
        requestName: request.name,
      });
      testResults = post.results;
      logs.push(...post.logs);
      if (post.error) logs.push({ level: "error", message: "Test script: " + post.error });
      applyMutations(store, env, globals, post);
      Object.assign(session, post.sessionVariables);
    }

    store.save("cookies", jar.list());
    truncateBody(response.body, args.maxBodyBytes === undefined ? 200000 : args.maxBodyBytes);
    return {
      request: {
        id: entry ? entry.item.id : request.id,
        name: entry ? entry.item.name : request.name,
        method: requestForSend.method,
        url: requestForSend.url,
      },
      response,
      testResults,
      logs,
      sessionVariables: session,
      environment: env ? { id: env.id, name: env.name } : null,
      cookies: jar.list(),
      dataDir: this.dataDir,
    };
  }

  async runCollection(input) {
    const args = input || {};
    const store = this.store();
    const collections = store.load("collections", []);
    const collection = findCollection(collections, args.collection || args.collectionId);
    if (!collection) throw new Error("Collection not found");
    const folder = args.folder || args.folderId ? findFolder(collection, args.folder || args.folderId) : null;
    if ((args.folder || args.folderId) && !folder) throw new Error("Folder not found");
    const entries = listRequestEntries(collection, folder);
    const iterations = Math.max(1, Math.min(100, Number(args.iterations) || 1));
    const delayMs = Math.max(0, Math.min(60000, Number(args.delayMs) || 0));
    const maxRequests = Math.max(1, Math.min(1000, Number(args.maxRequests) || 200));
    let session = {};
    const results = [];
    let stopped = false;
    for (let iteration = 1; iteration <= iterations && !stopped; iteration++) {
      for (const entry of entries) {
        if (results.length >= maxRequests) { stopped = true; break; }
        const sent = await this.sendRequest({
          requestId: entry.item.id,
          environment: args.environment || args.environmentId,
          variables: session,
          maxBodyBytes: 1000,
        });
        session = sent.sessionVariables || {};
        const failedTests = asArray(sent.testResults).filter((test) => !test.passed).length;
        results.push({
          iteration,
          requestId: entry.item.id,
          name: entry.item.name,
          method: entry.item.request && entry.item.request.method,
          url: sent.response && sent.response.url,
          ok: !!(sent.response && sent.response.ok),
          status: sent.response && sent.response.status,
          durationMs: sent.response && sent.response.timings && sent.response.timings.total,
          error: sent.response && sent.response.error && sent.response.error.message,
          tests: asArray(sent.testResults).length,
          failedTests,
        });
        if (delayMs && results.length < maxRequests) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (args.stopOnFailure && ((!sent.response || !sent.response.ok) || failedTests)) { stopped = true; break; }
      }
    }
    return {
      collectionId: collection.id,
      collectionName: collection.name,
      iterations,
      requests: entries.length,
      executed: results.length,
      stopped,
      results,
    };
  }
}

module.exports = {
  Agent,
  defaultDataDir,
  normalizeRequest,
  mergeRequest,
  findCollection,
  findRequestEntry,
};
