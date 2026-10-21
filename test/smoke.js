"use strict";
/* Smoke test for the engine/libs (no Electron needed). Run: node test/smoke.js */
const http = require("http");
const engine = require("../lib/engine");
const io = require("../lib/io");
const { runScript } = require("../lib/script");

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log("  PASS", name);
  else { failures++; console.log("  FAIL", name, extra == null ? "" : JSON.stringify(extra).slice(0, 300)); }
}

function localServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url.startsWith("/redirect")) {
          res.writeHead(302, { Location: "/hello" });
          return res.end();
        }
        if (req.url.startsWith("/headers")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ headers: req.headers, method: req.method }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, body, header: req.headers["x-test"] || null }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  const { server, port } = await localServer();
  const base = `http://127.0.0.1:${port}`;

  console.log("variables + execute");
  const scopes = [{ host: base }, { token: "abc123" }, {}, {}];
  const r1 = await engine.execute(
    { method: "GET", url: "{{host}}/hello?existing=1", params: [{ key: "q", value: "x y", enabled: true }], headers: [{ key: "X-Test", value: "{{token}}", enabled: true }], body: { mode: "none" } },
    { scopes }
  );
  check("GET status 200", r1.ok && r1.status === 200, r1);
  check("GET query + variable header", r1.ok && JSON.parse(r1.body.text).header === "abc123", r1.body && r1.body.text);
  check("GET missing variables empty", r1.missingVariables.length === 0);
  check("timings present", typeof r1.timings.total === "number");

  console.log("body modes");
  const r2 = await engine.execute(
    { method: "POST", url: base + "/echo", headers: [], params: [], body: { mode: "raw", raw: { language: "json", text: JSON.stringify({ a: 1 }) } } },
    { scopes }
  );
  check("POST raw json", r2.ok && JSON.parse(r2.body.text).body === JSON.stringify({ a: 1 }), r2.body && r2.body.text);

  const r3 = await engine.execute(
    { method: "POST", url: base + "/echo", headers: [], params: [], body: { mode: "urlencoded", urlencoded: [{ key: "a", value: "1 2", enabled: true }] } },
    { scopes }
  );
  check("POST urlencoded", r3.ok && JSON.parse(r3.body.text).body === "a=1+2", r3.body && r3.body.text);

  const r4 = await engine.execute(
    { method: "POST", url: base + "/echo", headers: [], params: [], body: { mode: "formdata", formdata: [{ key: "field", value: "v", type: "text", enabled: true }] } },
    { scopes }
  );
  check("POST multipart", r4.ok && /name="field"/.test(JSON.parse(r4.body.text).body), r4.body && r4.body.text);

  console.log("auth + redirect + cookies");
  const r5 = await engine.execute(
    { method: "GET", url: base + "/headers", headers: [], params: [], body: { mode: "none" }, auth: { type: "basic", basic: { username: "u", password: "p" } } },
    { scopes }
  );
  check("basic auth header", r5.ok && /^Basic /.test(JSON.parse(r5.body.text).headers.authorization), r5.body && r5.body.text);

  const r6 = await engine.execute({ method: "GET", url: base + "/redirect", headers: [], params: [], body: { mode: "none" } }, { scopes });
  check("follows redirect", r6.ok && r6.status === 200 && r6.redirects.length === 1, r6.redirects);

  const r7 = await engine.execute({ method: "GET", url: base + "/redirect", headers: [], params: [], body: { mode: "none" }, settings: { followRedirects: false } }, { scopes });
  check("no-follow returns 302", r7.ok && r7.status === 302 && r7.notFollowedRedirect, r7.status);

  const jar = new engine.CookieJar([]);
  jar.addFromResponse(["sid=42; Path=/; HttpOnly"], base + "/");
  check("cookie jar match", jar.headerFor(base + "/x") === "sid=42", jar.headerFor(base + "/x"));

  console.log("script runner");
  const pre = runScript("pm.environment.set('token', 'from-script'); pm.variables.set('v', 1);", "prerequest", { environment: {}, globals: {}, request: { method: "GET", url: base, headers: [] } });
  check("pre-request sets env", pre.environment.token === "from-script" && !pre.error, pre);
  const post = runScript(
    "pm.test('status is 200', () => pm.response.to.have.status(200));" +
      "pm.test('json ok', () => pm.expect(pm.response.json().ok).to.be.true);" +
      "pm.test('failing example', () => pm.expect(1).to.equal(2));",
    "tests",
    { environment: {}, globals: {}, request: { method: "GET", url: base, headers: [] }, response: r1 }
  );
  check("tests run", post.results.length === 3 && post.results[0].passed && post.results[1].passed && !post.results[2].passed, post.results);

  console.log("curl io");
  const parsed = io.parseCurl(
    "curl 'https://api.example.com/v1/items?x=1' -X POST -H 'Content-Type: application/json' --data-raw '{\"a\":1}' -k -u user:pass"
  );
  check("curl method/url", parsed.method === "POST" && parsed.url === "https://api.example.com/v1/items?x=1".split("?")[0], { m: parsed.method, u: parsed.url });
  check("curl body + auth", parsed.body.raw.text === '{"a":1}' && parsed.auth.basic.username === "user", parsed);
  check("curl insecure", parsed.settings.verifyTls === false);
  const rebuilt = io.buildCurl(parsed);
  check("curl round trip", rebuilt.includes("--data-raw") && rebuilt.includes("-u") && rebuilt.includes("-k"), rebuilt);

  console.log("postman io");
  const collection = {
    id: "col-1",
    name: "Demo",
    items: [
      { id: "f1", type: "folder", name: "Folder", items: [{ id: "r1", type: "request", name: "Get thing", request: { method: "GET", url: "https://example.com/thing", params: [{ key: "a", value: "1", enabled: true }], headers: [{ key: "Accept", value: "application/json", enabled: true }], body: { mode: "none" }, scripts: { preRequest: "pm.test('x',()=>{})", tests: "" }, settings: {} } }] },
    ],
    variables: [{ key: "base", value: "https://example.com", enabled: true }],
  };
  const exported = io.exportPostman(collection);
  const imported = io.importPostman(JSON.stringify(exported));
  check("postman schema", exported.info.schema.includes("v2.1.0"));
  check("postman import name", imported.name === "Demo");
  check("postman folder/request", imported.items[0].items[0].name === "Get thing");
  check("postman params", imported.items[0].items[0].request.params[0].key === "a");
  check("postman script", imported.items[0].items[0].request.scripts.preRequest.includes("pm.test"));
  check("postman import TLS defaults", !!(imported.items[0].items[0].request.settings.tls && typeof imported.items[0].items[0].request.settings.tls === "object"));

  console.log("postman v1/v2.0 + workspace import");
  const v1 = {
    id: "c1", name: "V1 Collection", description: "legacy desc",
    order: ["f1", "r1", "r2"],
    folders: [{ id: "f1", name: "Folder A", description: "folder desc", order: ["r3"] }],
    requests: [
      { id: "r1", name: "Get one", method: "GET", url: "https://example.com/a?x=1", headers: "X-Test: 1\nAccept: */*", description: "first" },
      { id: "r2", name: "Post one", method: "POST", url: "https://example.com/b", dataMode: "raw", rawModeData: '{"a":1}', headers: [{ key: "Content-Type", value: "application/json" }] },
      { id: "r3", name: "Basic auth", method: "GET", url: "https://example.com/c", currentHelper: "basicAuth", helperAttributes: { username: "u", password: "p" } },
    ],
  };
  const v1col = io.importPostman(JSON.stringify(v1));
  check("v1: name/description", v1col.name === "V1 Collection" && v1col.description === "legacy desc", v1col.name);
  check("v1: order folder first", v1col.items[0].type === "folder" && v1col.items[0].items[0].name === "Basic auth", v1col.items.map((i) => i.name));
  check("v1: query split", v1col.items[1].request.url === "https://example.com/a" && v1col.items[1].request.params[0].key === "x", v1col.items[1].request);
  check("v1: headers parsed", v1col.items[1].request.headers.length === 2, v1col.items[1].request.headers);
  check("v1: raw body", v1col.items[2].request.body.mode === "raw" && v1col.items[2].request.body.raw.text === '{"a":1}', v1col.items[2].request.body);
  check("v1: basic auth", v1col.items[0].items[0].request.auth.type === "basic" && v1col.items[0].items[0].request.auth.basic.username === "u", v1col.items[0].items[0].request.auth);

  const v20 = {
    info: { name: "V2.0", schema: "https://schema.getpostman.com/json/collection/v2.0.0/collection.json" },
    item: [{ name: "Req", request: { method: "POST", header: [{ key: "X-A", value: "1" }], url: { raw: "https://example.com/x?a=1", query: [{ key: "a", value: "1" }] }, body: { mode: "raw", raw: "{}" }, description: "v2 desc" } }],
    variable: [],
  };
  const v20col = io.importPostman(JSON.stringify(v20));
  check("v2.0: imported", v20col.name === "V2.0" && v20col.items[0].name === "Req", v20col.name);
  check("v2.0: description on item+request", v20col.items[0].description === "v2 desc" && v20col.items[0].request.description === "v2 desc", v20col.items[0]);
  const exported20 = io.exportPostman(v20col);
  check("export: request description kept", exported20.item[0].request.description === "v2 desc", exported20.item[0].request);
  check("export: folder description kept", io.exportPostman(io.importPostman(JSON.stringify(v1))).item[0].description === "folder desc");

  const ws = { collections: [v1], environments: [{ name: "Env1", values: [{ key: "k", value: "v", enabled: true }, { key: "s", value: "x", type: "secret" }] }], globals: [{ key: "g", value: "1", enabled: true }] };
  const any = io.importAny(JSON.stringify(ws));
  check("workspace: collections", any.collections.length === 1);
  check("workspace: environments", any.environments.length === 1 && any.environments[0].values[1].secret === true, any.environments);
  check("workspace: globals", any.globals.length === 1 && any.globals[0].key === "g", any.globals);

  console.log("client certificates + custom CA (mTLS)");
  const os = require("os");
  const fs = require("fs");
  const https = require("https");
  const { execFileSync } = require("child_process");
  let tlsOk = false;
  try {
    const dir = fs.mkdtempSync(require("path").join(os.tmpdir(), "repl-certs-"));
    const run = (args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=Replicate Test CA"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost"]);
    fs.writeFileSync(`${dir}/san.cnf`, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    run(["x509", "-req", "-in", "server.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "2", "-extfile", "san.cnf"]);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", "/CN=replicate-client"]);
    fs.writeFileSync(`${dir}/client.cnf`, "extendedKeyUsage=clientAuth\n");
    run(["x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "2", "-extfile", "client.cnf"]);
    run(["pkcs12", "-export", "-out", "client.pfx", "-inkey", "client.key", "-in", "client.crt", "-certfile", "ca.crt", "-passout", "pass:testpass"]);
    const tlsServer = https.createServer(
      { key: fs.readFileSync(`${dir}/server.key`), cert: fs.readFileSync(`${dir}/server.crt`), ca: fs.readFileSync(`${dir}/ca.crt`), requestCert: true, rejectUnauthorized: true },
      (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, client: req.socket.getPeerCertificate().subject.CN }));
      }
    );
    await new Promise((r) => tlsServer.listen(0, "127.0.0.1", r));
    const tlsPort = tlsServer.address().port;
    const url = `https://localhost:${tlsPort}/hello`;

    const mtlsPem = await engine.execute(
      { method: "GET", url, headers: [], params: [], body: { mode: "none" }, settings: { tls: { clientCert: true, type: "pem", certPath: `${dir}/client.crt`, keyPath: `${dir}/client.key`, caPath: `${dir}/ca.crt` } } },
      { scopes: [] }
    );
    check("mTLS with PEM client cert + custom CA", mtlsPem.ok && mtlsPem.status === 200 && JSON.parse(mtlsPem.body.text).client === "replicate-client", mtlsPem.ok ? mtlsPem.body.text : mtlsPem.error);

    const mtlsPfx = await engine.execute(
      { method: "GET", url, headers: [], params: [], body: { mode: "none" }, settings: { tls: { clientCert: true, type: "pfx", pfxPath: `${dir}/client.pfx`, passphrase: "testpass", caPath: `${dir}/ca.crt` } } },
      { scopes: [] }
    );
    check("mTLS with PKCS#12 client cert", mtlsPfx.ok && mtlsPfx.status === 200, mtlsPfx.ok ? mtlsPfx.body.text : mtlsPfx.error);

    const noCert = await engine.execute(
      { method: "GET", url, headers: [], params: [], body: { mode: "none" }, settings: { tls: { caPath: `${dir}/ca.crt` } } },
      { scopes: [] }
    );
    check("server rejects request without client cert", !noCert.ok, noCert.status || noCert.error);

    const badPath = await engine.execute(
      { method: "GET", url, headers: [], params: [], body: { mode: "none" }, settings: { tls: { clientCert: true, type: "pem", certPath: `${dir}/missing.crt`, keyPath: `${dir}/missing.key` } } },
      { scopes: [] }
    );
    check("missing cert file reports TLS_MATERIAL", !badPath.ok && badPath.error.code === "TLS_MATERIAL", badPath.error);

    const untrustedServer = https.createServer(
      { key: fs.readFileSync(`${dir}/server.key`), cert: fs.readFileSync(`${dir}/server.crt`) },
      (req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, bypassed: true })); }
    );
    await new Promise((r) => untrustedServer.listen(0, "127.0.0.1", r));
    const untrustedUrl = `https://localhost:${untrustedServer.address().port}/hello`;
    const strictTls = await engine.execute(
      { method: "GET", url: untrustedUrl, headers: [], params: [], body: { mode: "none" }, settings: { verifyTls: true } },
      { scopes: [] }
    );
    check("untrusted certificate rejected by default", !strictTls.ok && /SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO/.test(strictTls.error.code || ""), strictTls.error);
    const bypassTls = await engine.execute(
      { method: "GET", url: untrustedUrl, headers: [], params: [], body: { mode: "none" }, settings: { verifyTls: false } },
      { scopes: [] }
    );
    check("verifyTls:false bypasses untrusted certificate", bypassTls.ok && bypassTls.status === 200, bypassTls.ok ? bypassTls.body.text : bypassTls.error);
    untrustedServer.close();
    tlsServer.close();
    tlsOk = true;
  } catch (e) {
    console.log("  SKIP mTLS tests (openssl unavailable or failed):", e.message.slice(0, 160));
  }

  server.close();
  console.log(failures ? `\n${failures} failure(s)` : "\nAll smoke tests passed");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(2);
});
