import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import pino from 'pino';
import { createMcpServer } from './mcp/server.js';
import { MacosPlatform } from './platform/macos.js';
import { TOKEN_ACCOUNT, TOKEN_SERVICE } from './platform/platform.js';

const logger = pino({ name: 'mcp' });
const BRIDGE_URL = process.env.BUILDAGOTCHI_BRIDGE_URL ?? 'http://127.0.0.1:1780';

const platform = new MacosPlatform();
const token = await platform.getSecret(TOKEN_SERVICE, TOKEN_ACCOUNT);
if (token === null) {
  logger.warn(
    {},
    'no bridge token in Keychain — MCP tools disabled (run bridge init). Resources still work.',
  );
}

const server = createMcpServer(BRIDGE_URL, token);
const transport = new StdioServerTransport();
await server.connect(transport);
