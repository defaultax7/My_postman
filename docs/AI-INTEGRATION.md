# AI / Automation Integration

Postman Replicate exposes the same collections, environments, cookie jar and HTTP engine to external tools through:

- a **JSON command-line interface** (`cli.js`)
- an **MCP stdio server** (`mcp-server.js`)

Neither requires Electron. Node.js 18+ is required.

> These interfaces can read and modify app data and send HTTP requests with your credentials. Only connect trusted AI clients and protect access to the data directory.

## Data directory

By default the tools use the app data folder:

- Development checkout: `replicate\data`
- Packaged build: the `data` folder next to `Postman Replicate.exe`

Override it with either:

```cmd
node cli.js list-collections --data "C:\path\to\data"
```

or:

```cmd
set POSTMAN_REPLICATE_DATA=C:\path\to\data
```

The MCP server accepts the same override:

```cmd
node mcp-server.js --data "C:\path\to\data"
```

If the desktop app is open, it keeps its own in-memory copy of collections and environments. Close and reopen the app after external edits, and avoid editing from both at the same time.

Global Settings from the desktop app are honored by CLI and MCP sends, including the **SSL verification bypass** and **HTTP/HTTPS proxy** configuration.

## CLI

All commands print JSON to stdout. Errors go to stderr and return a non-zero exit code.

```cmd
cd G:\Postman\replicate

node cli.js list-collections
node cli.js list-requests --collection "My API"
node cli.js get-request --id req-abc123
```

### Create and update

```cmd
node cli.js create-collection --name "AI Tests"

node cli.js create-request ^
  --collection "AI Tests" ^
  --name "List users" ^
  --request-json "{\"method\":\"GET\",\"url\":\"https://api.example.com/users\",\"headers\":[{\"key\":\"Accept\",\"value\":\"application/json\",\"enabled\":true}]}"

node cli.js update-request --id req-abc123 --name "List active users"
node cli.js delete-request --id req-abc123
```

For larger request bodies, use a request JSON file:

```cmd
node cli.js create-request --collection "AI Tests" --name "Create user" --request-file request.json
```

### Send requests

Ad-hoc request:

```cmd
node cli.js send --url "https://httpbin.org/get" --header "Accept: application/json"

node cli.js send ^
  --method POST ^
  --url "https://httpbin.org/post" ^
  --header "Content-Type: application/json" ^
  --body "{\"name\":\"Ada\"}"
```

Use an environment or collection for `{{variables}}`:

```cmd
node cli.js send --url "{{baseUrl}}/users" --environment "Local" --collection "My API"
```

Send a saved request:

```cmd
node cli.js send-request --id req-abc123 --environment "Local"
```

Run a collection:

```cmd
node cli.js run-collection --collection "My API" --iterations 2 --delay 500
node cli.js run-collection --collection "My API" --stop-on-failure --max-requests 20
```

Response bodies are limited to 200,000 characters by default so an AI does not receive an enormous payload. Use `--max-body-bytes 0` for the full body.

### Import and export

```cmd
node cli.js import --file collection.postman_collection.json
node cli.js import --file -                 REM read JSON from stdin

node cli.js export --collection "My API"
node cli.js export --collection "My API" --out exported.postman_collection.json
```

### Environments, globals, cookies, history

```cmd
node cli.js env-list
node cli.js env-create --name "Local"
node cli.js env-set --environment "Local" --key baseUrl --value "https://localhost:8080"
node cli.js env-activate --environment "Local"

node cli.js global-list
node cli.js global-set --key token --value "abc123"

node cli.js cookies
node cli.js cookies-clear

node cli.js history --limit 10
```

### Request object shape

The `request` object follows the same shape stored by the app:

```json
{
  "method": "POST",
  "url": "https://api.example.com/users",
  "params": [
    { "key": "page", "value": "1", "enabled": true }
  ],
  "headers": [
    { "key": "Content-Type", "value": "application/json", "enabled": true }
  ],
  "body": {
    "mode": "raw",
    "raw": { "language": "json", "text": "{\"name\":\"Ada\"}" }
  },
  "auth": {
    "type": "bearer",
    "bearer": { "token": "{{token}}" }
  },
  "scripts": {
    "preRequest": "",
    "tests": ""
  },
  "settings": {
    "verifyTls": true,
    "followRedirects": true,
    "timeoutMs": 30000
  }
}
```

Supported body modes: `none`, `raw`, `urlencoded`, `formdata`, `file`, `graphql`.

## MCP server

Start the server manually:

```cmd
node mcp-server.js
node mcp-server.js --data "C:\path\to\data"
```

It communicates over **stdin/stdout** using newline-delimited JSON-RPC 2.0. Diagnostics go to stderr. Leave the process running for the MCP client.

### Claude Desktop example

Add this to the Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "postman-replicate": {
      "command": "node",
      "args": [
        "G:\\Postman\\replicate\\mcp-server.js",
        "--data",
        "G:\\Postman\\replicate\\data"
      ]
    }
  }
}
```

For the packaged build, use the server inside the app folder:

```json
{
  "mcpServers": {
    "postman-replicate": {
      "command": "node",
      "args": [
        "G:\\Postman\\replicate\\dist\\Postman-Replicate-0.1.0-win64\\resources\\app\\mcp-server.js",
        "--data",
        "G:\\Postman\\replicate\\dist\\Postman-Replicate-0.1.0-win64\\data"
      ]
    }
  }
}
```

If `node` is not on the client's PATH, use the full path to `node.exe` in `command`.

### MCP tools

| Tool | Purpose |
|---|---|
| `get_agent_info` | Show server version and active data directory |
| `list_collections` | List collections and counts |
| `get_collection` | Get folders, requests and collection variables |
| `list_requests` | List saved requests, optionally by collection/folder |
| `get_request` | Get a full saved request by ID |
| `create_collection` | Create a collection |
| `update_collection` | Rename/update a collection |
| `delete_collection` | Delete a collection |
| `create_folder` | Create a folder |
| `create_request` | Create a saved request |
| `update_request` | Merge changes into a saved request |
| `delete_request` | Delete a saved request |
| `send_request` | Send an ad-hoc request or full request object |
| `send_saved_request` | Send a saved request by ID |
| `run_collection` | Run a collection or folder |
| `import_postman` | Import Postman JSON |
| `export_collection` | Export Postman Collection v2.1 JSON |
| `list_environments` | List environments and active environment |
| `create_environment` | Create an environment |
| `set_environment_variable` | Create/update an environment variable |
| `set_active_environment` | Select or clear the active environment |
| `list_globals` | List global variables |
| `set_global_variable` | Create/update a global variable |
| `list_cookies` | List cookie-jar contents |
| `clear_cookies` | Clear the cookie jar |
| `list_history` | List recent request-history summaries |

Example prompts once connected:

> List my Postman Replicate collections and find requests whose URL contains `/users`.

> Send the saved request named "List users" using the Local environment and summarize the response.

> Create a folder `AI Tests` in `My API`, add a GET request for `https://httpbin.org/get`, and run it.

### Protocol notes

- Transport: stdio, one JSON-RPC message per line
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`
- Tool responses include a text content block containing formatted JSON
- Supported protocol version fallback: `2024-11-05`

## Tests

```cmd
node test/agent.js
```

This covers CRUD, variable resolution, sending, cookies, import/export, collection runs, CLI output, and MCP initialization/tool calls.
