"use strict";
/* Automation API, CLI, and MCP server tests. Run: node test/agent.js */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const { Agent } = require("../lib/agent");

let failures = 0;
function check(name, condition, extra) {
  if (condition) console.log("  PASS", name);
  else {
    failures++;
    console.log("  FAIL", name, extra === undefined ? "" : JSON.stringify(extra).slice(0, 500));
  }
}

function server() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        if (req.url === "/cookie-set") {
          res.writeHead(200, { "Set-Cookie": ["agent=ok; Path=/; HttpOnly"], "Content-Type": "application/json" });
          return res.end(JSON.stringify({ ok: true }));
        }
        if (req.url === "/cookie-echo") {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ cookie: req.headers.cookie || null }));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, path: req.url, method: req.method, body, header: req.headers["x-test"] || null }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

function runCli(cliPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath].concat(args), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function mcpClient(serverPath, dataDir) {
  const child = spawn(process.execPath, [serverPath, "--data", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let nextId = 0;
  const waiters = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { continue; }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      }
    }
  });
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error("MCP timeout; stderr: " + stderr.slice(0, 300)));
        }, 5000);
        waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    close() { child.kill(); },
  };
}

(async () => {
  const { srv, base } = await server();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replicate-agent-"));
  const agent = new Agent({ dataDir: dir });

  console.log("collection/request CRUD");
  const collection = agent.createCollection({ name: "Agent API", variables: [{ key: "svc", value: "agent", enabled: true }] });
  check("collection created", !!collection.id && collection.name === "Agent API", collection);
  const folder = agent.createFolder({ collection: collection.id, name: "Users" });
  check("folder created", !!folder.id, folder);
  const created = agent.createRequest({
    collection: collection.id,
    folder: folder.id,
    name: "Create user",
    request: {
      method: "POST",
      url: base + "/echo?from=saved",
      headers: [{ key: "X-Test", value: "{{token}}", enabled: true }],
      body: { mode: "raw", raw: { language: "json", text: "{\"a\":1}" } },
      scripts: { tests: "pm.test('status 200', () => pm.response.to.have.status(200));" },
    },
  });
  check("request created", !!created.id, created);
  const listed = agent.listRequests({ collection: collection.id });
  check("request listed with folder path", listed.length === 1 && listed[0].folderPath[0] === "Users", listed);
  const got = agent.getRequest({ id: created.id });
  check("request fetched with full data", got.item.request.headers[0].key === "X-Test" && got.collection.variables[0].key === "svc", got);
  agent.updateRequest({ id: created.id, name: "Create user v2", request: { headers: [{ key: "X-Test", value: "{{token}}", enabled: true }, { key: "X-New", value: "1", enabled: true }] } });
  const updated = agent.getRequest({ id: created.id });
  check("request updated", updated.name === "Create user v2" && updated.item.request.headers.length === 2, updated.name);

  console.log("environments/globals");
  const env = agent.createEnvironment({ name: "Local", values: [{ key: "token", value: "from-env", enabled: true }] });
  agent.setActiveEnvironment({ environment: env.id });
  agent.setEnvironmentVariable({ environment: env.id, key: "extra", value: "yes" });
  agent.setGlobalVariable({ key: "globalOne", value: "g1" });
  const envState = agent.listEnvironments();
  check("environment variable set", envState.activeEnvironmentId === env.id && envState.environments[0].values.some((v) => v.key === "extra" && v.value === "yes"), envState);
  check("global variable set", agent.listGlobals().some((v) => v.key === "globalOne" && v.value === "g1"));

  console.log("send saved request");
  const sent = await agent.sendRequest({ requestId: created.id, maxBodyBytes: 0 });
  const sentBody = sent.response.ok ? JSON.parse(sent.response.body.text) : null;
  check("saved request sent with env variable", sent.response.ok && sentBody.header === "from-env", sent.response.ok ? sentBody : sent.response.error);
  check("pre/post test results returned", sent.testResults.length === 1 && sent.testResults[0].passed, sent.testResults);
  check("response body was not truncated when maxBodyBytes=0", sent.response.body.text.length > 0 && !sent.response.body.truncatedForAgent);

  console.log("cookies");
  const setCookie = await agent.sendRequest({ request: { method: "GET", url: base + "/cookie-set" } });
  check("cookie stored", setCookie.response.ok && agent.listCookies().some((c) => c.name === "agent" && c.value === "ok"), agent.listCookies());
  const echoCookie = await agent.sendRequest({ request: { method: "GET", url: base + "/cookie-echo" } });
  check("cookie sent automatically", echoCookie.response.ok && /agent=ok/.test(JSON.parse(echoCookie.response.body.text).cookie || ""), echoCookie.response.ok ? echoCookie.response.body.text : echoCookie.response.error);

  console.log("import/export");
  const exported = agent.exportCollection({ collection: collection.id });
  check("collection exports Postman v2.1", /v2\.1\.0/.test(exported.info.schema) && exported.item[0].item[0].name === "Create user v2", exported.info);
  const imported = agent.importPostman({ json: JSON.stringify(exported) });
  check("collection imports", imported.collections.length === 1 && agent.listCollections().length === 2, imported);

  console.log("collection runner");
  const run = await agent.runCollection({ collection: collection.id, iterations: 2, maxRequests: 10 });
  check("collection runner executes requests", run.executed === 2 && run.results.every((r) => r.ok), run);

  console.log("CLI");
  const cliPath = path.join(__dirname, "..", "cli.js");
  const cli = await runCli(cliPath, ["list-collections", "--data", dir]);
  let cliJson = null;
  try { cliJson = JSON.parse(cli.stdout); } catch (_) {}
  check("CLI outputs JSON", cli.status === 0 && Array.isArray(cliJson) && cliJson.length === 2, { status: cli.status, stderr: cli.stderr, stdout: cli.stdout.slice(0, 300) });
  const cliSend = await runCli(cliPath, ["send", "--data", dir, "--url", base + "/echo", "--header", "X-CLI: 1"]);
  let cliSent = null;
  try { cliSent = JSON.parse(cliSend.stdout); } catch (_) {}
  check("CLI sends requests", cliSend.status === 0 && cliSent.response && cliSent.response.ok, { status: cliSend.status, stderr: cliSend.stderr, stdout: cliSend.stdout.slice(0, 300) });

  console.log("MCP server");
  const mcp = mcpClient(path.join(__dirname, "..", "mcp-server.js"), dir);
  const init = await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  check("MCP initialize", init.result && init.result.serverInfo.name === "postman-replicate", init);
  const tools = await mcp.request("tools/list", {});
  check("MCP tools listed", tools.result && tools.result.tools.some((tool) => tool.name === "send_request") && tools.result.tools.some((tool) => tool.name === "list_collections"), tools.result && tools.result.tools.map((tool) => tool.name));
  const mcpList = await mcp.request("tools/call", { name: "list_collections", arguments: {} });
  let mcpCollections = null;
  try { mcpCollections = JSON.parse(mcpList.result.content[0].text); } catch (_) {}
  check("MCP tool call returns JSON content", Array.isArray(mcpCollections) && mcpCollections.length === 2, mcpList);
  mcp.close();

  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : "\nAll agent tests passed");
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.error("Agent tests crashed:", error);
  process.exit(2);
});
