# MCP Bridge for ChatGPT

Host any npm-based MCP server as an HTTP/SSE endpoint for ChatGPT.

## What It Does

This Actor takes any MCP server published on npm, installs it at runtime, and exposes it as an SSE endpoint that ChatGPT can connect to.

## How to Use

### 1. Configure the MCP Server

Provide the npm package name of the MCP server you want to host:

| Input | Description | Example |
|-------|-------------|---------|
| **package** | npm package name (required) | `@modelcontextprotocol/server-everything` |
| **version** | Package version (optional) | `1.0.0` |
| **args** | CLI arguments (optional) | `["--verbose"]` |
| **env** | Environment variables (optional) | `{"API_KEY": "xxx"}` |

### 2. Run in Standby Mode

Start the Actor in Standby mode for a stable URL.

### 3. Add to ChatGPT

1. Go to ChatGPT Settings → Custom Tools → Add Tool
2. Enter the SSE URL from the Actor output:
   ```
   https://wuyuwen0--mcp-bridge.apify.actor/sse
   ```
3. Set Authentication to OAuth (or None for demo)

## Example Configurations

### Everything Server (Demo)
```json
{
  "package": "@modelcontextprotocol/server-everything"
}
```

### Filesystem Server
```json
{
  "package": "@modelcontextprotocol/server-filesystem",
  "args": ["/data"]
}
```

### Server with API Key
```json
{
  "package": "some-mcp-server",
  "env": {
    "API_KEY": "your-api-key"
  }
}
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sse` | GET | SSE stream - ChatGPT connects here |
| `/message` | POST | Send JSON-RPC messages to MCP server |
| `/health` | GET | Health check |
| `/` | GET | Server info and URLs |
