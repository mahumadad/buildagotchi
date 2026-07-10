import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpServer } from '../src/mcp/server.js';

describe('MCP server', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  const BRIDGE_URL = 'http://127.0.0.1:1780';

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function connectServer(token: string | null) {
    const server = createMcpServer(BRIDGE_URL, token);
    const client = new Client({ name: 'test', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { server, client };
  }

  it('creates without crash', () => {
    const server = createMcpServer(BRIDGE_URL, 'test-token');
    expect(server).toBeDefined();
  });

  it('notify tool sends event via fetch', async () => {
    mockFetch.mockResolvedValue({ status: 202, json: async () => ({ ok: true }) });
    const { client } = await connectServer('test-token');
    const result = await client.callTool({
      name: 'notify',
      arguments: { source: 'test', severity: 'high', category: 'alert', message: 'hi' },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BRIDGE_URL}/events`,
      expect.objectContaining({ method: 'POST' }),
    );
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('fetch was never called');
    const body = JSON.parse(call[1].body);
    expect(body.source).toBe('test');
    expect(body.severity).toBe('high');
    expect((result.content as { text: string }[])[0]?.text).toContain('202');
  });

  it('set_face tool posts to /events with mcp:set_face source', async () => {
    mockFetch.mockResolvedValue({ status: 202, json: async () => ({ ok: true }) });
    const { client } = await connectServer('test-token');
    await client.callTool({
      name: 'set_face',
      arguments: { emotion: 'HAPPY', ttlMs: 3000 },
    });
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('fetch was never called');
    const body = JSON.parse(call[1].body);
    expect(body.source).toBe('mcp:set_face');
    expect(body.payload.emotion).toBe('HAPPY');
  });

  it('set_face with balloon includes it in payload', async () => {
    mockFetch.mockResolvedValue({ status: 202, json: async () => ({ ok: true }) });
    const { client } = await connectServer('test-token');
    await client.callTool({
      name: 'set_face',
      arguments: { emotion: 'SAD', ttlMs: 5000, balloon: 'oops' },
    });
    const call = mockFetch.mock.calls[0];
    if (!call) throw new Error('fetch was never called');
    const body = JSON.parse(call[1].body);
    expect(body.payload.balloon).toBe('oops');
  });

  it('approve_permission tool calls /approve/:sessionId', async () => {
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({ resolved: true }) });
    const { client } = await connectServer('test-token');
    await client.callTool({
      name: 'approve_permission',
      arguments: { sessionId: 's1', action: 'approve' },
    });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BRIDGE_URL}/approve/s1`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('state/current resource fetches /state', async () => {
    mockFetch.mockResolvedValue({ status: 200, text: async () => '{"emotion":"NEUTRAL"}' });
    const { client } = await connectServer('test-token');
    const result = await client.readResource({ uri: 'buildagotchi://state/current' });
    expect(mockFetch).toHaveBeenCalledWith(`${BRIDGE_URL}/state`);
    expect((result.contents as { text: string }[])[0]?.text).toContain('NEUTRAL');
  });

  it('health resource fetches /health', async () => {
    mockFetch.mockResolvedValue({ status: 200, text: async () => '{"bridge":"ok"}' });
    const { client } = await connectServer('test-token');
    await client.readResource({ uri: 'buildagotchi://health' });
    expect(mockFetch).toHaveBeenCalledWith(`${BRIDGE_URL}/health`);
  });

  it('tools return error when token is null', async () => {
    const { client } = await connectServer(null);
    const result = await client.callTool({
      name: 'notify',
      arguments: { source: 'test', severity: 'high', category: 'alert', message: 'hi' },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain('token not provisioned');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
