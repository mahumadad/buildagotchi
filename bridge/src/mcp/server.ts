import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const NOT_PROVISIONED_ERROR = {
  content: [{ type: 'text' as const, text: 'Error: token not provisioned, run bridge init' }],
  isError: true,
};

export function createMcpServer(bridgeUrl: string, token: string | null): McpServer {
  const server = new McpServer({
    name: 'buildagotchi',
    version: '0.1.0',
  });

  const authHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  };

  server.registerTool(
    'notify',
    {
      description: 'Push an event into the buildagotchi pipeline',
      inputSchema: {
        source: z.string().describe('Event source identifier'),
        severity: z.enum(['critical', 'high', 'medium', 'low', 'ambient']),
        category: z.string().describe('Event category'),
        message: z.string().describe('Human-readable message'),
        ttlMs: z.number().optional().describe('Time-to-live in milliseconds'),
      },
    },
    async (input) => {
      if (!token) return NOT_PROVISIONED_ERROR;
      const res = await fetch(`${bridgeUrl}/events`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          source: input.source,
          severity: input.severity,
          category: input.category,
          payload: { message: input.message },
          ...(input.ttlMs !== undefined ? { ttlMs: input.ttlMs } : {}),
        }),
      });
      return { content: [{ type: 'text', text: `Event sent: ${res.status}` }] };
    },
  );

  server.registerTool(
    'set_face',
    {
      description: 'Temporarily override the avatar emotion',
      inputSchema: {
        emotion: z.enum(['NEUTRAL', 'HAPPY', 'SAD', 'ANGRY', 'SLEEPY', 'DOUBTFUL', 'COLD', 'HOT']),
        ttlMs: z.number().default(5000).describe('Duration in ms'),
        balloon: z.string().optional().describe('Speech balloon text'),
      },
    },
    async (input) => {
      if (!token) return NOT_PROVISIONED_ERROR;
      const payload: Record<string, unknown> = { emotion: input.emotion };
      if (input.balloon !== undefined) payload.balloon = input.balloon;
      const res = await fetch(`${bridgeUrl}/events`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          source: 'mcp:set_face',
          category: 'set_face',
          severity: 'high',
          ttlMs: input.ttlMs,
          payload,
        }),
      });
      return { content: [{ type: 'text', text: `Face set: ${input.emotion} (${res.status})` }] };
    },
  );

  server.registerTool(
    'approve_permission',
    {
      description: 'Approve or deny a pending Claude permission',
      inputSchema: {
        sessionId: z.string().describe('Claude session ID'),
        action: z.enum(['approve', 'deny']),
      },
    },
    async (input) => {
      if (!token) return NOT_PROVISIONED_ERROR;
      const res = await fetch(`${bridgeUrl}/approve/${input.sessionId}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ action: input.action }),
      });
      const body = await res.json();
      return { content: [{ type: 'text', text: JSON.stringify(body) }] };
    },
  );

  server.registerResource(
    'state/current',
    'buildagotchi://state/current',
    { mimeType: 'application/json' },
    async (uri) => {
      const res = await fetch(`${bridgeUrl}/state`);
      const data = await res.text();
      return { contents: [{ uri: uri.href, text: data, mimeType: 'application/json' }] };
    },
  );

  server.registerResource(
    'health',
    'buildagotchi://health',
    { mimeType: 'application/json' },
    async (uri) => {
      const res = await fetch(`${bridgeUrl}/health`);
      const data = await res.text();
      return { contents: [{ uri: uri.href, text: data, mimeType: 'application/json' }] };
    },
  );

  return server;
}
