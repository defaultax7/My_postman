#!/usr/bin/env node
"use strict";
/* Postman Replicate CLI for automation and AI agents.
   All commands print JSON. Run `node cli.js --help` for usage. */
const fs = require("fs");
const path = require("path");
const { Agent, defaultDataDir } = require("./lib/agent");

function fail(message) {
  console.error("Error: " + message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { _: [] };
  const multi = new Set(["header", "param"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    let value = true;
    if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i++;
    }
    if (multi.has(key)) {
      if (!Array.isArray(args[key])) args[key] = [];
      args[key].push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function readJson(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail("Invalid JSON: " + error.message);
  }
}

function readRequest(args) {
  if (args["request-json"]) return readJson(args["request-json"]);
  if (args["request-file"]) {
    const text = args["request-file"] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args["request-file"], "utf8");
    return readJson(text);
  }
  return {};
}

function splitPair(value) {
  const index = String(value).indexOf(":");
  if (index < 0) return { key: String(value), value: "" };
  return { key: String(value).slice(0, index).trim(), value: String(value).slice(index + 1).trim() };
}

function pairs(values) {
  return (Array.isArray(values) ? values : values ? [values] : []).map(splitPair);
}

function buildAdHocRequest(args) {
  const request = readRequest(args);
  if (request && Object.keys(request).length) return request;
  const headers = pairs(args.header).map((header) => ({ ...header, enabled: true }));
  const params = pairs(args.param).map((param) => ({ ...param, enabled: true }));
  const bodyText = args["body-file"]
    ? (args["body-file"] === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args["body-file"], "utf8"))
    : args.body;
  const requestBody = {
    method: String(args.method || "GET").toUpperCase(),
    url: args.url || "",
    headers,
    params,
  };
  if (bodyText !== undefined) {
    requestBody.body = {
      mode: "raw",
      raw: {
        text: bodyText,
        language: /json/i.test(String(args["content-type"] || "")) ? "json" : "text",
      },
    };
  }
  if (args["content-type"]) headers.push({ key: "Content-Type", value: args["content-type"], enabled: true });
  return requestBody;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function help() {
  const lines = [
    "Postman Replicate CLI",
    "",
    "Usage: node cli.js <command> [options]",
    "",
    "Global:",
    "  --data <dir>                 Data directory (default: app data)",
    "",
    "Collections:",
    "  list-collections",
    "  get-collection --collection <id|name>",
    "  create-collection --name <name> [--description <text>] [--variables <json>]",
    "  update-collection --collection <id|name> [--name <name>] [--description <text>] [--variables <json>]",
    "  delete-collection --collection <id|name>",
    "",
    "Requests/folders:",
    "  list-requests [--collection <id|name>] [--folder <id>]",
    "  get-request --id <request-id>",
    "  create-request --collection <id|name> --name <name> [--folder <id>] [--request-json <json>|--request-file <file>]",
    "  update-request --id <request-id> [--name <name>] [--description <text>] [--request-json <json>|--request-file <file>]",
    "  delete-request --id <request-id>",
    "  create-folder --collection <id|name> --name <name> [--folder <parent-id>] [--description <text>]",
    "",
    "Sending:",
    "  send --url <url> [--method GET] [--header 'Key: Value']... [--param 'k=v']...",
    "       [--body <text>|--body-file <file>] [--environment <id|name>] [--collection <id|name>]",
    "       [--max-body-bytes <n>] [--request-json <json>|--request-file <file>]",
    "  send-request --id <request-id> [--environment <id|name>] [--max-body-bytes <n>]",
    "  run-collection --collection <id|name> [--folder <id>] [--environment <id|name>]",
    "       [--iterations <n>] [--delay <ms>] [--stop-on-failure] [--max-requests <n>]",
    "",
    "Import/export:",
    "  import --file <postman.json|->",
    "  export --collection <id|name> [--out <file>]",
    "",
    "Environments/globals/cookies/history:",
    "  env-list",
    "  env-create --name <name> [--values <json>]",
    "  env-set --environment <id|name> --key <key> --value <value> [--disabled]",
    "  env-activate --environment <id|name>       (omit --environment to clear)",
    "  global-list",
    "  global-set --key <key> --value <value> [--disabled]",
    "  cookies",
    "  cookies-clear",
    "  history [--limit <n>]",
    "",
    "Data directory defaults to the app's data folder. Set POSTMAN_REPLICATE_DATA",
    "or pass --data to use another workspace.",
  ];
  console.log(lines.join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || command === "help" || args.help) {
    help();
    return;
  }
  const agent = new Agent({ dataDir: args.data || process.env.POSTMAN_REPLICATE_DATA || defaultDataDir() });

  switch (command) {
    case "list-collections":
      return print(agent.listCollections());
    case "get-collection":
      return print(agent.getCollection({ collection: args.collection || args.id }));
    case "create-collection":
      return print(agent.createCollection({ name: args.name, description: args.description, variables: readJson(args.variables) }));
    case "update-collection":
      return print(agent.updateCollection({
        collection: args.collection || args.id,
        name: args.name,
        description: args.description,
        variables: readJson(args.variables),
      }));
    case "delete-collection":
      return print(agent.deleteCollection({ collection: args.collection || args.id }));
    case "list-requests":
      return print(agent.listRequests({ collection: args.collection, folder: args.folder }));
    case "get-request":
      return print(agent.getRequest({ id: args.id }));
    case "create-folder":
      return print(agent.createFolder({
        collection: args.collection,
        folder: args.folder,
        name: args.name,
        description: args.description,
      }));
    case "create-request":
      return print(agent.createRequest({
        collection: args.collection,
        folder: args.folder,
        name: args.name,
        description: args.description,
        request: readRequest(args),
      }));
    case "update-request":
      return print(agent.updateRequest({
        id: args.id,
        name: args.name,
        description: args.description,
        request: args["request-json"] || args["request-file"] ? readRequest(args) : undefined,
      }));
    case "delete-request":
      return print(agent.deleteRequest({ id: args.id }));
    case "send":
      return print(await agent.sendRequest({
        request: buildAdHocRequest(args),
        environment: args.environment,
        collection: args.collection,
        variables: readJson(args.variables),
        maxBodyBytes: args["max-body-bytes"] === undefined ? undefined : Number(args["max-body-bytes"]),
      }));
    case "send-request":
      return print(await agent.sendRequest({
        requestId: args.id,
        environment: args.environment,
        variables: readJson(args.variables),
        maxBodyBytes: args["max-body-bytes"] === undefined ? undefined : Number(args["max-body-bytes"]),
      }));
    case "run-collection":
      return print(await agent.runCollection({
        collection: args.collection,
        folder: args.folder,
        environment: args.environment,
        iterations: args.iterations === undefined ? undefined : Number(args.iterations),
        delayMs: args.delay === undefined ? undefined : Number(args.delay),
        stopOnFailure: !!args["stop-on-failure"],
        maxRequests: args["max-requests"] === undefined ? undefined : Number(args["max-requests"]),
      }));
    case "import": {
      if (!args.file) fail("--file is required (use - for stdin)");
      const text = args.file === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(args.file, "utf8");
      return print(agent.importPostman({ json: text }));
    }
    case "export": {
      const exported = agent.exportCollection({ collection: args.collection });
      const text = JSON.stringify(exported, null, 2);
      if (args.out) {
        fs.writeFileSync(path.resolve(args.out), text + "\n", "utf8");
        return print({ ok: true, path: path.resolve(args.out) });
      }
      process.stdout.write(text + "\n");
      return;
    }
    case "env-list":
      return print(agent.listEnvironments());
    case "env-create":
      return print(agent.createEnvironment({ name: args.name, values: readJson(args.values) }));
    case "env-set":
      return print(agent.setEnvironmentVariable({
        environment: args.environment,
        key: args.key,
        value: args.value,
        enabled: args.disabled ? false : true,
      }));
    case "env-activate":
      return print(agent.setActiveEnvironment({ environment: args.environment || null }));
    case "global-list":
      return print(agent.listGlobals());
    case "global-set":
      return print(agent.setGlobalVariable({ key: args.key, value: args.value, enabled: args.disabled ? false : true }));
    case "cookies":
      return print(agent.listCookies());
    case "cookies-clear":
      return print(agent.clearCookies());
    case "history":
      return print(agent.listHistory({ limit: args.limit === undefined ? undefined : Number(args.limit) }));
    default:
      fail("Unknown command: " + command + " (run: node cli.js --help)");
  }
}

main().catch((error) => fail(error && error.message ? error.message : String(error)));
