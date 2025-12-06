import express, { Request, Response } from 'express';
import cors from 'cors';
import { spawn, ChildProcess, execSync } from 'child_process';
import { Actor, log } from 'apify';
import { createInterface } from 'readline';

// Initialize Apify Actor
await Actor.init();

interface ActorInput {
    // Option 1: Smithery server (easiest - just paste server ID)
    smitheryServer?: string;  // e.g., "@VapiAI/vapi-mcp-server"
    smitheryApiKey?: string;  // Get from https://smithery.ai/account/api-keys
    // Option 2: Full command line
    commandLine?: string;
    // Option 3: npm package (will be installed globally)
    package?: string;
    version?: string;
    // Option 4: custom command (e.g., npx)
    command?: string;
    // Shared options
    args?: string[];
    env?: Record<string, string>;
}

interface SmitheryServerInfo {
    qualifiedName: string;
    displayName: string;
    description: string;
    remote: boolean;
    deploymentUrl?: string;
    connections: Array<{
        type: string;
        url?: string;
        configSchema?: unknown;
    }>;
    tools?: Array<{
        name: string;
        description?: string;
    }>;
}

interface JsonRpcMessage {
    jsonrpc: '2.0';
    id?: string | number;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

// Global state
let mcpProcess: ChildProcess | null = null;
let requestIdCounter = 1;
const pendingRequests = new Map<string | number, {
    resolve: (value: JsonRpcMessage) => void;
    reject: (error: Error) => void;
}>();
const sseClients = new Set<Response>();

// Fetch server info from Smithery registry
async function fetchSmitheryServer(serverId: string, apiKey: string): Promise<SmitheryServerInfo> {
    const url = `https://registry.smithery.ai/servers/${encodeURIComponent(serverId)}`;
    log.info(`Fetching Smithery server info: ${serverId}`);

    const response = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json',
        },
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Smithery API error (${response.status}): ${text}`);
    }

    const data = await response.json() as SmitheryServerInfo;
    log.info(`Smithery server: ${data.displayName}`, {
        remote: data.remote,
        tools: data.tools?.map(t => t.name),
    });

    return data;
}

// Install npm package at runtime
async function installPackage(packageName: string, version?: string): Promise<string> {
    const packageSpec = version ? `${packageName}@${version}` : packageName;
    log.info(`Installing package: ${packageSpec}`);

    try {
        execSync(`npm install -g ${packageSpec}`, {
            stdio: 'pipe',
            encoding: 'utf-8',
        });
        log.info(`Successfully installed ${packageSpec}`);

        // Find the binary name - try to get it from package.json bin field
        // Most MCP servers use the package name without scope as the bin name
        const binName = packageName.replace(/^@[^/]+\//, '');
        return binName;
    } catch (error) {
        log.error('Failed to install package:', { error });
        throw error;
    }
}

// Spawn MCP server as subprocess
function spawnMcpServer(
    binName: string,
    args: string[] = [],
    env: Record<string, string> = {}
): ChildProcess {
    log.info(`Spawning MCP server: ${binName}`, { args, env: Object.keys(env) });

    const proc = spawn(binName, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
    });

    // Parse stdout line-by-line for JSON-RPC messages
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
        if (!line.trim()) return;

        try {
            const message = JSON.parse(line) as JsonRpcMessage;
            log.debug('MCP stdout:', { message });

            // Broadcast to all SSE clients
            broadcastToSse(message);

            // Resolve pending request if this is a response (has id but no method)
            if (message.id !== undefined && !message.method) {
                const pending = pendingRequests.get(message.id);
                if (pending) {
                    pending.resolve(message);
                    pendingRequests.delete(message.id);
                }
            }
        } catch (e) {
            log.warning('Failed to parse MCP stdout:', { line });
        }
    });

    // Log stderr
    proc.stderr?.on('data', (data) => {
        log.warning('MCP stderr:', { data: data.toString() });
    });

    proc.on('error', (error) => {
        log.error('MCP process error:', { error });
    });

    proc.on('exit', (code) => {
        log.info(`MCP process exited with code ${code}`);
        mcpProcess = null;
    });

    return proc;
}

// Send message to MCP server
function sendToMcp(message: JsonRpcMessage): Promise<JsonRpcMessage> {
    return new Promise((resolve, reject) => {
        if (!mcpProcess || !mcpProcess.stdin) {
            reject(new Error('MCP server not running'));
            return;
        }

        // Track request if it has an ID (it's a request expecting response)
        if (message.id !== undefined) {
            pendingRequests.set(message.id, { resolve, reject });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (pendingRequests.has(message.id!)) {
                    pendingRequests.delete(message.id!);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        }

        const json = JSON.stringify(message);
        log.debug('Sending to MCP:', { message });
        mcpProcess.stdin.write(json + '\n');

        // If no ID (notification), resolve immediately
        if (message.id === undefined) {
            resolve({ jsonrpc: '2.0' });
        }
    });
}

// Broadcast message to all SSE clients
function broadcastToSse(message: JsonRpcMessage) {
    const data = `data: ${JSON.stringify(message)}\n\n`;
    for (const client of sseClients) {
        client.write(data);
    }
}

// Express app setup
const app = express();
app.use(express.json());

// Configure CORS
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
    }),
);

// Readiness probe and status endpoint
app.get('/', (req: Request, res: Response) => {
    if (req.headers['x-apify-container-server-readiness-probe']) {
        log.info('Readiness probe');
        res.end('ok\n');
        return;
    }

    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL || 'http://localhost:3000';

    res.json({
        name: 'MCP Bridge',
        description: 'Host any npm MCP server as HTTP/SSE endpoint for ChatGPT',
        status: mcpProcess ? 'running' : 'stopped',
        sseClients: sseClients.size,
        endpoints: {
            sse: `${webServerUrl}/sse`,
            message: `${webServerUrl}/message`,
            health: `${webServerUrl}/health`,
        },
        chatgpt_url: `${webServerUrl}/sse`,
    });
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
    res.json({
        status: mcpProcess ? 'running' : 'stopped',
        clients: sseClients.size,
        pendingRequests: pendingRequests.size,
    });
});

// SSE endpoint for ChatGPT
app.get('/sse', async (req: Request, res: Response) => {
    log.info('New SSE client connected');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Add client to set
    sseClients.add(res);

    // Send endpoint event with message URL for client to POST to
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL || 'http://localhost:3000';
    res.write(`event: endpoint\ndata: ${webServerUrl}/message\n\n`);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', status: 'ready' })}\n\n`);

    // If MCP server is running, send initialize response
    if (mcpProcess) {
        try {
            // Send initialize request to MCP server
            const initResponse = await sendToMcp({
                jsonrpc: '2.0',
                id: requestIdCounter++,
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: {
                        name: 'chatgpt-mcp-bridge',
                        version: '1.0.0',
                    },
                },
            });
            res.write(`data: ${JSON.stringify(initResponse)}\n\n`);
        } catch (error) {
            log.error('Failed to initialize MCP:', { error });
        }
    }

    req.on('close', () => {
        log.info('SSE client disconnected');
        sseClients.delete(res);
    });
});

// POST endpoint to send messages to MCP server
app.post('/message', async (req: Request, res: Response) => {
    try {
        const message = req.body as JsonRpcMessage;

        if (!message.jsonrpc || message.jsonrpc !== '2.0') {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32600, message: 'Invalid JSON-RPC request' },
                id: null,
            });
            return;
        }

        // Assign ID if not present
        if (message.method && message.id === undefined) {
            message.id = requestIdCounter++;
        }

        const response = await sendToMcp(message);
        res.json(response);
    } catch (error) {
        log.error('Error handling message:', { error });
        res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: (error as Error).message },
            id: null,
        });
    }
});

// Parse a command line string into command and arguments
function parseCommandLine(cmdLine: string): { cmd: string; args: string[] } {
    // Simple parsing - split by spaces, respecting quotes
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const char of cmdLine) {
        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = true;
            quoteChar = char;
        } else if (char === quoteChar && inQuote) {
            inQuote = false;
            quoteChar = '';
        } else if (char === ' ' && !inQuote) {
            if (current) {
                parts.push(current);
                current = '';
            }
        } else {
            current += char;
        }
    }
    if (current) {
        parts.push(current);
    }

    return {
        cmd: parts[0] || '',
        args: parts.slice(1),
    };
}

// Main startup
async function main() {
    const input = await Actor.getInput<ActorInput>();

    if (!input?.smitheryServer && !input?.package && !input?.command && !input?.commandLine) {
        log.error('No smitheryServer, package, command, or commandLine specified in input');
        throw new Error('One of "smitheryServer", "commandLine", "package", or "command" is required');
    }

    let cmd: string;
    let cmdArgs: string[];
    let remoteUrl: string | undefined;

    if (input.smitheryServer) {
        // Smithery mode - fetch server info from registry
        if (!input.smitheryApiKey) {
            throw new Error('smitheryApiKey is required when using smitheryServer. Get one at https://smithery.ai/account/api-keys');
        }

        const serverInfo = await fetchSmitheryServer(input.smitheryServer, input.smitheryApiKey);

        if (serverInfo.remote && serverInfo.deploymentUrl) {
            // Remote server - we'll proxy to their URL
            remoteUrl = serverInfo.deploymentUrl;
            log.info(`Using remote Smithery server: ${remoteUrl}`);
        } else {
            // Stdio server - use smithery CLI to run it with --key
            cmd = 'npx';
            cmdArgs = ['-y', '@smithery/cli@latest', 'run', input.smitheryServer, '--key', input.smitheryApiKey];
            log.info(`Using Smithery CLI to run: ${input.smitheryServer}`);
        }
    } else if (input.commandLine) {
        // Full command line mode - just paste the command
        const parsed = parseCommandLine(input.commandLine.trim());
        cmd = parsed.cmd;
        cmdArgs = parsed.args;
        log.info(`Using command line: ${input.commandLine}`);
    } else if (input.command) {
        // Custom command mode (e.g., npx)
        cmd = input.command;
        cmdArgs = input.args || [];
        log.info(`Using custom command: ${cmd}`, { args: cmdArgs });
    } else {
        // Package mode - install and run
        const binName = await installPackage(input.package!, input.version);
        cmd = binName;
        cmdArgs = input.args || [];
    }

    // If remote server, set up proxy mode instead of spawning
    if (remoteUrl) {
        log.info(`Proxying to remote MCP server: ${remoteUrl}`);
        // TODO: Implement proxy to remote server
        // For now, we'll still need to spawn locally
        throw new Error('Remote server proxying not yet implemented. Use commandLine mode instead.');
    }

    // Spawn MCP server
    mcpProcess = spawnMcpServer(cmd!, cmdArgs!, input.env);

    // Give the process a moment to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Start Express server
    const PORT = process.env.ACTOR_WEB_SERVER_PORT
        ? parseInt(process.env.ACTOR_WEB_SERVER_PORT)
        : 3000;

    app.listen(PORT, () => {
        const webServerUrl = process.env.ACTOR_WEB_SERVER_URL || `http://localhost:${PORT}`;
        log.info(`MCP Bridge listening on port ${PORT}`);
        log.info('='.repeat(80));
        log.info('ChatGPT MCP Server URL:');
        log.info(`${webServerUrl}/sse`);
        log.info('='.repeat(80));
    });
}

main().catch((error) => {
    log.error('Fatal error:', { error });
    process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    log.info('Shutting down...');
    if (mcpProcess) {
        mcpProcess.kill();
    }
    await Actor.exit();
});
