"use strict";
/* Sandboxed pre-request / test script runner with a compact pm.* shim. */
const vm = require("vm");

function makeExpect() {
  function fail(msg) {
    throw new Error(msg);
  }
  function deepEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null) return false;
    if (typeof a !== "object") return Number.isNaN(a) && Number.isNaN(b) ? true : false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  const assertion = (actual, negated) => {
    const ok = (cond, msg) => {
      const pass = negated ? !cond : cond;
      if (!pass) fail(negated ? "expected not to " + msg : "expected to " + msg);
      return api;
    };
    const api = {
      get not() { return assertion(actual, !negated); },
      equal(v) { return ok(actual === v, `equal ${JSON.stringify(v)} (got ${JSON.stringify(actual)})`); },
      eql(v) { return ok(deepEqual(actual, v), `deep-equal ${JSON.stringify(v)} (got ${JSON.stringify(actual)})`); },
      be: null,
      have: null,
      a(type) {
        const t = Array.isArray(actual) ? "array" : actual === null ? "null" : typeof actual;
        return ok(t === type, `be a ${type} (got ${t})`);
      },
      an(type) { return this.a(type); },
      ok() { return ok(Boolean(actual), "be truthy"); },
      true() { return ok(actual === true, "be true"); },
      false() { return ok(actual === false, "be false"); },
      null() { return ok(actual === null, "be null"); },
      undefined() { return ok(actual === undefined, "be undefined"); },
      exist() { return ok(actual !== null && actual !== undefined, "exist"); },
      above(v) { return ok(actual > v, `be above ${v}`); },
      least(v) { return ok(actual >= v, `be at least ${v}`); },
      below(v) { return ok(actual < v, `be below ${v}`); },
      most(v) { return ok(actual <= v, `be at most ${v}`); },
      within(a, b) { return ok(actual >= a && actual <= b, `be within ${a}..${b}`); },
      include(v) {
        const cond = Array.isArray(actual) || typeof actual === "string" ? actual.includes(v) : false;
        return ok(cond, `include ${JSON.stringify(v)}`);
      },
      match(re) { return ok(re.test(String(actual)), `match ${re}`); },
      property(name, value) {
        const has = actual != null && name in Object(actual);
        if (arguments.length === 1) return ok(has, `have property ${name}`);
        return ok(has && deepEqual(actual[name], value), `have property ${name}=${JSON.stringify(value)}`);
      },
      length(n) { return ok(actual != null && actual.length === n, `have length ${n}`); },
      keys(...names) {
        const ks = actual && typeof actual === "object" ? Object.keys(actual) : [];
        const flat = names.flat();
        return ok(flat.every((n) => ks.includes(n)), `have keys ${flat.join(",")}`);
      },
    };
    api.be = api;
    api.have = api;
    api.to = api;
    return api;
  };
  return assertion;
}

function makeStore(initial) {
  const data = Object.assign({}, initial || {});
  return {
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; return value; },
    unset(key) { delete data[key]; },
    clear() { for (const k of Object.keys(data)) delete data[k]; },
    toObject() { return Object.assign({}, data); },
    has(key) { return Object.prototype.hasOwnProperty.call(data, key); },
  };
}

function headerBag(list) {
  const items = (list || []).map((h) => ({ key: h.key, value: h.value }));
  return {
    all() { return items.slice(); },
    get(key) {
      const found = items.find((h) => h.key.toLowerCase() === String(key).toLowerCase());
      return found ? found.value : undefined;
    },
    has(key) { return this.get(key) !== undefined; },
    add(h) { items.push({ key: h.key, value: String(h.value) }); },
    upsert(h) {
      const i = items.findIndex((x) => x.key.toLowerCase() === String(h.key).toLowerCase());
      if (i >= 0) items[i].value = String(h.value);
      else items.push({ key: h.key, value: String(h.value) });
    },
    remove(key) {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].key.toLowerCase() === String(key).toLowerCase()) items.splice(i, 1);
      }
    },
    toObject() {
      const o = {};
      for (const h of items) o[h.key] = h.value;
      return o;
    },
    _items: items,
  };
}

function runScript(code, kind, ctx) {
  const results = [];
  const logs = [];
  const environment = makeStore(ctx.environment);
  const globals = makeStore(ctx.globals);
  const collectionVariables = makeStore(ctx.collectionVariables);
  const sessionVars = makeStore(ctx.sessionVariables);
  const expect = makeExpect();

  const responseHeaders = headerBag(ctx.response ? ctx.response.headers : []);
  const responseBodyText = ctx.response && ctx.response.body ? ctx.response.body.text : null;
  let responseJson;
  const getJson = () => {
    if (responseJson === undefined) {
      try { responseJson = JSON.parse(responseBodyText || "null"); } catch (_) { responseJson = null; }
    }
    return responseJson;
  };

  const requestHeaders = headerBag(ctx.request ? ctx.request.headers : []);
  const pmRequest = ctx.request
    ? {
        method: ctx.request.method,
        url: {
          toString: () => ctx.request.url,
          get value() { return ctx.request.url; },
        },
        headers: requestHeaders,
        body: {
          get mode() { return (ctx.request.body && ctx.request.body.mode) || "none"; },
          get raw() { return (ctx.request.body && ctx.request.body.raw && ctx.request.body.raw.text) || ""; },
          set raw(v) { if (ctx.request.body && ctx.request.body.raw) ctx.request.body.raw.text = v; },
        },
        _mutable: ctx.request,
      }
    : undefined;

  const responseTime = ctx.response && ctx.response.timings ? ctx.response.timings.total : null;
  const pmResponse = ctx.response
    ? {
        code: ctx.response.status,
        status: ctx.response.statusText,
        responseTime,
        responseSize: ctx.response.body ? ctx.response.body.size : null,
        headers: responseHeaders,
        text() { return responseBodyText; },
        json() { return getJson(); },
        to: {
          have: {
            status(code) {
              if (ctx.response.status !== code) throw new Error(`expected response to have status ${code} (got ${ctx.response.status})`);
              return true;
            },
            header(key) {
              if (!responseHeaders.has(key)) throw new Error(`expected response to have header ${key}`);
              return true;
            },
            jsonBody(path, value) {
              let cur = getJson();
              for (const part of String(path).split(".")) cur = cur == null ? undefined : cur[part];
              if (arguments.length === 1) {
                if (cur === undefined) throw new Error(`expected response JSON to have ${path}`);
              } else if (JSON.stringify(cur) !== JSON.stringify(value)) {
                throw new Error(`expected ${path} to be ${JSON.stringify(value)} (got ${JSON.stringify(cur)})`);
              }
              return true;
            },
          },
        },
      }
    : undefined;

  const pm = {
    test(name, fn) {
      try {
        fn();
        results.push({ name, passed: true, error: null });
      } catch (e) {
        results.push({ name, passed: false, error: e && e.message ? e.message : String(e) });
      }
    },
    expect,
    environment: {
      get: (k) => environment.get(k),
      set: (k, v) => environment.set(k, v),
      unset: (k) => environment.unset(k),
      clear: () => environment.clear(),
      has: (k) => environment.has(k),
      toObject: () => environment.toObject(),
    },
    globals: {
      get: (k) => globals.get(k),
      set: (k, v) => globals.set(k, v),
      unset: (k) => globals.unset(k),
      clear: () => globals.clear(),
      has: (k) => globals.has(k),
      toObject: () => globals.toObject(),
    },
    collectionVariables: {
      get: (k) => collectionVariables.get(k),
      set: (k, v) => collectionVariables.set(k, v),
      unset: (k) => collectionVariables.unset(k),
      toObject: () => collectionVariables.toObject(),
    },
    variables: {
      get: (k) => {
        const v = sessionVars.get(k);
        if (v !== undefined) return v;
        for (const s of [environment, collectionVariables, globals]) {
          if (s.has(k)) return s.get(k);
        }
        return undefined;
      },
      set: (k, v) => sessionVars.set(k, v),
      unset: (k) => sessionVars.unset(k),
      toObject: () => sessionVars.toObject(),
    },
    request: pmRequest,
    response: pmResponse,
    info: { eventName: kind === "tests" ? "test" : "prerequest", requestName: ctx.requestName || "" },
    iteration: undefined,
  };

  const sandbox = {
    pm,
    console: {
      log: (...a) => logs.push({ level: "log", message: a.map(String).join(" ") }),
      info: (...a) => logs.push({ level: "info", message: a.map(String).join(" ") }),
      warn: (...a) => logs.push({ level: "warn", message: a.map(String).join(" ") }),
      error: (...a) => logs.push({ level: "error", message: a.map(String).join(" ") }),
    },
    btoa: (s) => Buffer.from(String(s), "binary").toString("base64"),
    atob: (s) => Buffer.from(String(s), "base64").toString("binary"),
  };
  sandbox.window = undefined;
  sandbox.globalThis = sandbox;

  let error = null;
  try {
    vm.createContext(sandbox);
    vm.runInContext(String(code || ""), sandbox, { timeout: 5000, filename: (kind || "script") + ".js" });
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }

  return {
    results,
    logs,
    error,
    environment: environment.toObject(),
    globals: globals.toObject(),
    collectionVariables: collectionVariables.toObject(),
    sessionVariables: sessionVars.toObject(),
    requestMutations: requestHeaders._items,
  };
}

module.exports = { runScript };
