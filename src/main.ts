import express, { Request, Response } from 'express';
import cors from 'cors';
import { spawn, ChildProcess } from 'child_process';
import { Actor, log } from 'apify';
import { createInterface } from 'readline';

// Initialize Apify Actor
await Actor.init();

interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface McpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

interface ActorInput {
    // Option 1: Paste the playground command
    playgroundCommand?: string;
    // Option 2: Paste the JSON config
    mcpConfig?: McpConfig;
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

// Parse a command line string into command and arguments
function parseCommandLine(cmdLine: string): { cmd: string; args: string[] } {
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

    // Remove --playground flag since we ARE the remote server
    const filteredParts = parts.filter(p => p !== '--playground');

    return {
        cmd: filteredParts[0] || '',
        args: filteredParts.slice(1),
    };
}

// Extract command and args from input
function getCommandFromInput(input: ActorInput): { cmd: string; args: string[]; env?: Record<string, string> } {
    if (input.playgroundCommand) {
        // Parse the playground command
        const parsed = parseCommandLine(input.playgroundCommand.trim());
        log.info(`Using playground command: ${input.playgroundCommand}`);
        return { cmd: parsed.cmd, args: parsed.args };
    }

    if (input.mcpConfig?.mcpServers) {
        // Get the first server from the config
        const servers = Object.entries(input.mcpConfig.mcpServers);
        if (servers.length === 0) {
            throw new Error('No servers found in mcpConfig');
        }

        const [serverName, config] = servers[0];
        log.info(`Using MCP config for server: ${serverName}`);

        return {
            cmd: config.command,
            args: config.args || [],
            env: config.env,
        };
    }

    throw new Error('Either playgroundCommand or mcpConfig is required');
}

// Spawn MCP server as subprocess
function spawnMcpServer(
    cmd: string,
    args: string[] = [],
    env: Record<string, string> = {}
): ChildProcess {
    log.info(`Spawning MCP server: ${cmd}`, { args });

    const proc = spawn(cmd, args, {
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
app.use(cors({
    origin: '*',
    exposedHeaders: ['Mcp-Session-Id'],
}));

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
        description: 'Host any Smithery MCP server as HTTP/SSE endpoint for ChatGPT',
        status: mcpProcess ? 'running' : 'stopped',
        sseClients: sseClients.size,
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

// Main startup
async function main() {
    const input = await Actor.getInput<ActorInput>();

    if (!input?.playgroundCommand && !input?.mcpConfig) {
        throw new Error('Either playgroundCommand or mcpConfig is required');
    }

    // Get command from input
    const { cmd, args, env } = getCommandFromInput(input);

    // Spawn MCP server
    mcpProcess = spawnMcpServer(cmd, args, env);

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
