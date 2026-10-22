#!/usr/bin/env node
"use strict";
/* Minimal MCP server over stdio for Postman Replicate.

   Usage:
     node mcp-server.js [--data <data-dir>]

   The server exposes the same operations as the CLI through MCP tools.
   It uses newline-delimited JSON-RPC 2.0 on stdin/stdout. */
const readline = require("readline");
const { Agent, defaultDataDir } = require("./lib/agent");

const args = process.argv.slice(2);
const dataIndex = args.indexOf("--data");
const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : process.env.POSTMAN_REPLICATE_DATA || defaultDataDir();
if (dataIndex >= 0 && !dataDir) {
  console.error("mcp-server: --data requires a directory");
  process.exit(1);
}
const agent = new Agent({ dataDir });

const obj = (properties, required) => ({
  type: "object",
  properties: properties || {},
  ...(required ? { required } : {}),
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const anyObj = (description) => ({ type: "object", description, additionalProperties: true });
const requestSchema = {
  type: "object",
  description: "Request object using the app's saved-request shape.",
  properties: {
    name: str("Request name"),
    description: str("Request description"),
    method: str("HTTP method"),
    url: str("Request URL; {{variables}} are resolved when sending"),
    params: { type: "array", description: "Query parameters [{key,value,enabled}]" },
    headers: { type: "array", description: "Request headers [{key,value,enabled}]" },
    body: anyObj("Body: {mode:'none'|'raw'|'urlencoded'|'formdata'|'file'|'graphql', raw:{language,text}, urlencoded:[], formdata:[], file, graphql:{query,variables}}"),
    auth: anyObj("Auth: {type:'none'|'basic'|'bearer'|'apikey'|'oauth2', ...}"),
    scripts: anyObj("Scripts: {preRequest, tests}"),
    settings: anyObj("Request settings: verifyTls, followRedirects, timeoutMs, sendCookies, tls"),
  },
  additionalProperties: true,
};

const tools = [
  {
    name: "get_agent_info",
    description: "Return the Postman Replicate automation version and the data directory being used.",
    inputSchema: obj({}),
    run: () => ({ name: "postman-replicate", version: "0.1.0", dataDir: agent.dataDir }),
  },
  {
    name: "list_collections",
    description: "List collections with IDs, names, variable counts, and request counts.",
    inputSchema: obj({}),
    run: () => agent.listCollections(),
  },
  {
    name: "get_collection",
    description: "Get a collection including its folders, requests, and variables.",
    inputSchema: obj({ collection: str("Collection ID or exact name") }, ["collection"]),
    run: (a) => agent.getCollection(a),
  },
  {
    name: "list_requests",
    description: "List saved requests, optionally filtered by collection or folder.",
    inputSchema: obj({ collection: str("Optional collection ID or name"), folder: str("Optional folder ID") }),
    run: (a) => agent.listRequests(a),
  },
  {
    name: "get_request",
    description: "Get a saved request by ID, including its full request body, headers, scripts, and collection variables.",
    inputSchema: obj({ id: str("Request ID") }, ["id"]),
    run: (a) => agent.getRequest(a),
  },
  {
    name: "create_collection",
    description: "Create a new collection.",
    inputSchema: obj({
      name: str("Collection name"),
      description: str("Optional description"),
      variables: { type: "array", description: "Optional variables [{key,value,enabled}]" },
    }, ["name"]),
    run: (a) => agent.createCollection(a),
  },
  {
    name: "update_collection",
    description: "Rename or update a collection's description or variables.",
    inputSchema: obj({
      collection: str("Collection ID or name"),
      name: str("New name"),
      description: str("New description"),
      variables: { type: "array", description: "Replacement variables [{key,value,enabled}]" },
    }, ["collection"]),
    run: (a) => agent.updateCollection(a),
  },
  {
    name: "delete_collection",
    description: "Delete a collection and everything inside it.",
    inputSchema: obj({ collection: str("Collection ID or name") }, ["collection"]),
    run: (a) => agent.deleteCollection(a),
  },
  {
    name: "create_folder",
    description: "Create a folder in a collection or inside another folder.",
    inputSchema: obj({
      collection: str("Collection ID or name"),
      folder: str("Optional parent folder ID"),
      name: str("Folder name"),
      description: str("Optional description"),
    }, ["collection", "name"]),
    run: (a) => agent.createFolder(a),
  },
  {
    name: "create_request",
    description: "Create a saved request in a collection or folder. Returns the new request ID.",
    inputSchema: obj({
      collection: str("Collection ID or name"),
      folder: str("Optional folder ID"),
      name: str("Request name"),
      description: str("Optional description"),
      request: requestSchema,
    }, ["collection", "name"]),
    run: (a) => agent.createRequest(a),
  },
  {
    name: "update_request",
    description: "Update a saved request. The request object is merged into the existing request.",
    inputSchema: obj({
      id: str("Request ID"),
      name: str("New name"),
      description: str("New description"),
      request: requestSchema,
    }, ["id"]),
    run: (a) => agent.updateRequest(a),
  },
  {
    name: "delete_request",
    description: "Delete a saved request by ID.",
    inputSchema: obj({ id: str("Request ID") }, ["id"]),
    run: (a) => agent.deleteRequest(a),
  },
  {
    name: "send_request",
    description: "Send an ad-hoc HTTP request or a full request object. Returns status, headers, body, timings, tests, and cookies. Body text is limited by maxBodyBytes (default 200000).",
    inputSchema: obj({
      request: requestSchema,
      method: str("HTTP method when request is omitted"),
      url: str("Request URL when request is omitted"),
      headers: { type: "array", description: "Headers [{key,value,enabled}]" },
      params: { type: "array", description: "Query params [{key,value,enabled}]" },
      body: anyObj("Body object"),
      auth: anyObj("Auth object"),
      collection: str("Optional collection ID/name for collection variables"),
      environment: str("Optional environment ID/name; defaults to the active environment"),
      variables: anyObj("Optional session variables"),
      maxBodyBytes: num("Maximum body characters returned; 0 means unlimited"),
    }),
    run: (a) => agent.sendRequest(a),
  },
  {
    name: "send_saved_request",
    description: "Send a saved request by ID using its collection variables and the active or specified environment.",
    inputSchema: obj({
      requestId: str("Saved request ID"),
      environment: str("Optional environment ID/name"),
      variables: anyObj("Optional session variables"),
      maxBodyBytes: num("Maximum body characters returned; 0 means unlimited"),
    }, ["requestId"]),
    run: (a) => agent.sendRequest(a),
  },
  {
    name: "run_collection",
    description: "Run all requests in a collection or folder, with optional iterations, delay, and stop-on-failure.",
    inputSchema: obj({
      collection: str("Collection ID or name"),
      folder: str("Optional folder ID"),
      environment: str("Optional environment ID/name"),
      iterations: num("Iterations, 1-100"),
      delayMs: num("Delay between requests in ms"),
      stopOnFailure: bool("Stop after a failed request or test"),
      maxRequests: num("Maximum requests to execute, default 200"),
    }, ["collection"]),
    run: (a) => agent.runCollection(a),
  },
  {
    name: "import_postman",
    description: "Import Postman Collection v2.1/v2.0/v1 JSON or a v1 workspace export.",
    inputSchema: obj({ json: str("Postman JSON text") }, ["json"]),
    run: (a) => agent.importPostman(a),
  },
  {
    name: "export_collection",
    description: "Export a collection as Postman Collection v2.1 JSON.",
    inputSchema: obj({ collection: str("Collection ID or name") }, ["collection"]),
    run: (a) => agent.exportCollection(a),
  },
  {
    name: "list_environments",
    description: "List environments, their variables, and the active environment ID.",
    inputSchema: obj({}),
    run: () => agent.listEnvironments(),
  },
  {
    name: "create_environment",
    description: "Create a new environment.",
    inputSchema: obj({ name: str("Environment name"), values: { type: "array", description: "Variables [{key,value,enabled}]" } }, ["name"]),
    run: (a) => agent.createEnvironment(a),
  },
  {
    name: "set_environment_variable",
    description: "Create or update an environment variable.",
    inputSchema: obj({
      environment: str("Environment ID or name"),
      key: str("Variable name"),
      value: str("Variable value"),
      enabled: bool("Whether the variable is enabled"),
    }, ["environment", "key", "value"]),
    run: (a) => agent.setEnvironmentVariable(a),
  },
  {
    name: "set_active_environment",
    description: "Set the active environment, or pass null to clear it.",
    inputSchema: obj({ environment: { type: ["string", "null"], description: "Environment ID or name, or null" } }),
    run: (a) => agent.setActiveEnvironment(a),
  },
  {
    name: "list_globals",
    description: "List global variables.",
    inputSchema: obj({}),
    run: () => agent.listGlobals(),
  },
  {
    name: "set_global_variable",
    description: "Create or update a global variable.",
    inputSchema: obj({ key: str("Variable name"), value: str("Variable value"), enabled: bool("Whether the variable is enabled") }, ["key", "value"]),
    run: (a) => agent.setGlobalVariable(a),
  },
  {
    name: "list_cookies",
    description: "List cookies currently stored in the cookie jar.",
    inputSchema: obj({}),
    run: () => agent.listCookies(),
  },
  {
    name: "clear_cookies",
    description: "Clear the cookie jar.",
    inputSchema: obj({}),
    run: () => agent.clearCookies(),
  },
  {
    name: "list_history",
    description: "List recent request history summaries.",
    inputSchema: obj({ limit: num("Maximum entries, default 20") }),
    run: (a) => agent.listHistory(a),
  },
];

function sendMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message && message.id !== undefined) sendError(message.id, -32600, "Invalid Request");
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: (params && params.protocolVersion) || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "postman-replicate", version: "0.1.0" },
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method && method.startsWith("notifications/")) return;
  if (method === "tools/list") {
    sendResult(id, {
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
    return;
  }
  if (method === "tools/call") {
    const name = params && params.name;
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      sendError(id, -32602, "Unknown tool: " + name);
      return;
    }
    try {
      const result = await tool.run((params && params.arguments) || {});
      const text = JSON.stringify(result, null, 2);
      sendResult(id, {
        content: [{ type: "text", text }],
        isError: false,
      });
    } catch (error) {
      sendResult(id, {
        content: [{ type: "text", text: "Error: " + (error && error.message ? error.message : String(error)) }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, "Method not found: " + method);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    sendError(null, -32700, "Parse error");
    return;
  }
  Promise.resolve(handle(message)).catch((error) => {
    if (message && message.id !== undefined) sendError(message.id, -32603, error.message || String(error));
    else console.error("mcp-server:", error);
  });
});
rl.on("close", () => process.exit(0));
