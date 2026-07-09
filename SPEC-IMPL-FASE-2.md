# SPEC-IMPL — Fase 2: plan de implementación ejecutable (M6–M11)

Spec de implementación bite-sized de la Fase 2 (MVP — Monitor de Claude Code).
Deriva de [SPEC-FASE-2.md](SPEC-FASE-2.md), [SPEC-FASE-1.md](SPEC-FASE-1.md)
(contratos heredados) y [DECISIONS.md](DECISIONS.md). **Este documento cierra
todas las decisiones de implementación** — el ejecutor no debe decidir nada: si
algo no está cubierto acá ni en SPEC-FASE-2, es un bug de esta spec y se anota
en NOTES.md → sección "Sorpresas" antes de improvisar.

Estado: **borrador aprobable**.

---

## 0. Reglas de ejecución

- **Un milestone = un commit** (`M6: …`, `M7: …`). Mensaje en imperativo,
  cuerpo explica el porqué. Nunca `Co-Authored-By`.
- **Orden TDD por módulo**: escribir el test del comportamiento, verlo fallar,
  implementar, verde. Los tests obligatorios de cada milestone están enumerados —
  son el criterio de done, no una sugerencia.
- **Verificación al cierre de cada milestone**:
  ```bash
  cd bridge && npm run typecheck && npm run lint && npm test
  ```
  Los tres verdes o el milestone no está terminado.
- **Dependencias permitidas** (exactas — las de Fase 1A + estas nuevas):
  - runtime: `pino`, `yaml`, `zod`, `uuid` (existentes) +
    `@modelcontextprotocol/sdk` (M9 — MCP server)
  - dev: `@biomejs/biome`, `@types/node`, `tsx`, `typescript`, `vitest`
    (existentes)
  - **Prohibido agregar**: noble (es 1B), express/fastify (ya tenemos
    `node:http`), React/Vue/Svelte (dashboard es vanilla), chokidar (salvo
    escape hatch ya previsto), `ws` (SSE basta).
- **Fuera de scope de Fase 2** (no escribir ni "dejar preparado"):
  Metabolic State engine (placeholder CALM fijo), TTS/STT, adapters
  Jira/GitHub/Calendar, ChromeAdapter, transport-noble, firmware, token
  tracking via ccusage, `PreToolUse` approve/deny response.
- **Tests con timers**: `vi.useFakeTimers()` — nada de sleeps reales.
- **Estilo**: el que impone Biome. Comentarios solo para invariantes que el
  código no puede expresar.
- **El hardware NO ha llegado**: todo se verifica con `--simulate`. Las
  verificaciones son via curl, SSE, el dashboard web, y logs.

### Decisiones de implementación de esta spec (SA*)

- **SA11 — Hook endpoint sin auth**: `POST /hooks/claude` no requiere Bearer
  token (el hook script corre local y no tiene acceso al token de Keychain).
  Rate limit separado: 120/min (hooks son más frecuentes que eventos externos).
  Mitigación: el endpoint solo acepta payloads del schema de hooks; no es una
  superficie genérica de eventos.
- **SA12 — Dashboard como archivos estáticos**: 3 archivos (`index.html`,
  `dashboard.css`, `dashboard.js`) servidos por el server existente con content
  type por extensión. Sin bundler, sin build step. El JS usa ES modules nativos
  del browser.
- **SA13 — MCP entry point separado**: el MCP server vive en `src/mcp/server.ts`
  con entry point `src/mcp.ts` que se compila a `dist/mcp.js`. Claude Code lo
  levanta como stdio child process. El MCP server se conecta al bridge via HTTP
  interno (localhost:1780) — no comparte proceso con el bridge para evitar que un
  crash del MCP tire el bridge. **Auth (S2.7)**: el MCP obtiene el Bearer token
  del Keychain via `platform.getSecret(TOKEN_SERVICE, TOKEN_ACCOUNT)` al
  arrancar. Si no hay token, corre en modo read-only (solo resources funcionan,
  tools loguean warn "token not provisioned, run bridge init").
- **SA13b — MCP reutiliza endpoints existentes** (C1 del council): NO hay
  `POST /face`. La tool `set_face` postea a `POST /events` con
  `source:'mcp:set_face', category:'set_face', severity:'high'` y payload
  `{emotion, balloon?}`. La tool `approve_permission` postea a
  `POST /approve/:sessionId`. Zero superficie nueva en el server para MCP.
- **SA14 — Personality templates**: interpolación simple con `{variable}`. Sin
  handlebars ni template engine — un `replace()` por variable conocida. Variables
  disponibles: `{project}` (cwd corto), `{command}` (del permiso), `{session}`
  (session_id corto).
- **SA15 — SSE session events**: nuevo event type `session` en el SSE stream con
  payload `{sessions: Map<string, ClaudeSession>}` serializado. Se emite al
  cambiar estado de cualquier sesión.
- **SA16 — Stale session cleanup**: cada 60s, el ClaudeAdapter recorre sesiones
  y marca como `stale` las que no han recibido eventos en
  `staleSessionTimeoutMs`. Las sesiones `stale` se limpian tras 5 min adicionales
  sin actividad.
- **SA17 — Fallback state files**: al arrancar, el ClaudeAdapter lee
  `~/.buildagotchi/claude-state/*.json`, procesa cada uno como si fuera un hook
  event, y borra el archivo. Esto resincroniza sesiones que se perdieron por
  bridge caído.
- **SA18 — Config schema backward-compatible**: las nuevas secciones (`claude`,
  `mcp`, `dashboard`) tienen defaults zod para que configs existentes de Fase 1A
  sigan validando sin cambios.

---

## 1. M6 — ClaudeAdapter

**Objetivo**: hooks de Claude Code → eventos en el bus, tracking de sesiones
multi-instancia, health status, fallback local.

### 1.1 `src/adapters/claude-adapter.ts`

```ts
export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  state: 'working' | 'idle' | 'permission_pending' | 'stale';
  lastEventAt: number;
  pendingPermission?: {
    eventId: string;
    command?: string;
    isCritical: boolean;
  } | undefined;
}

export interface ClaudeAdapterConfig {
  staleSessionTimeoutMs: number;        // default 1_800_000 (30m)
  transcriptReadEnabled: boolean;       // default true
  unknownLineThreshold: number;         // default 5
  unknownLineBrokenThreshold: number;   // default 20
}

interface ClaudeAdapterDeps {
  logger: MinimalLogger;
  metrics: Metrics;
  criticalCommands: string[];
  stateDir: string;                     // ~/.buildagotchi/claude-state
}

export class ClaudeAdapter implements Adapter {
  readonly name = 'claude';

  constructor(cfg: ClaudeAdapterConfig, deps: ClaudeAdapterDeps);

  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string };

  handleHookEvent(payload: Record<string, unknown>): void;
  sessions(): ReadonlyMap<string, ClaudeSession>;
  resolvePermission(sessionId: string, action: 'approved' | 'denied'): boolean;
}
```

**Comportamiento detallado de `handleHookEvent`:**

1. Validar `hook_event_name` y `session_id` presentes; skip si faltan + warn.
2. Crear sesión si no existe (`session_id` nuevo); actualizar `lastEventAt`.
3. Según `hook_event_name`:
   - `UserPromptSubmit`: session.state = `'working'`. Emitir evento
     `{source:'claude', category:'prompt', severity:'ambient',
     payload:{sessionId, cwd}}`.
   - `Stop`: si `transcript_path` presente y `transcriptReadEnabled` →
     `readTranscriptTail()` para enriquecer. session.state = `'idle'`.
     Emitir `{source:'claude', category:'response', severity:'ambient',
     payload:{sessionId, cwd, tokens?, text?}}`.
   - `Notification`: leer `type` del payload. Si `'permission'` →
     session.state = `'permission_pending'`, leer transcript para comando,
     check `criticalCommands` → `isCritical`. Emitir
     `{source:'claude', category:'permission', severity:'critical',
     payload:{sessionId, cwd, command?, isCritical}}`.
     Si otro type → emitir como `{category:'notification', severity:'low'}`.
   - `SubagentStop`: emitir `{category:'subagent', severity:'ambient'}`.
4. Incrementar `claude_hook_events_total{hook_event}`.
5. Broadcast SSE `session`.

**`readTranscriptTail(path, lines=50): TranscriptEnrichment | null`**

```ts
interface TranscriptEnrichment {
  text?: string;           // último mensaje de Claude
  command?: string;        // comando del permiso (si aplica)
  tokens?: number;         // tokens del turno
  unknownLineRatio: number; // para health
}
```

- `readFileSync` de las últimas `lines` líneas (seek al final, leer hacia
  atrás hasta tener suficientes `\n`).
- Parsear cada línea como JSON. Línea no-JSON → skip + count unknown.
- Extraer campos conocidos del schema de transcript de Claude Code.
- Crash → return `null` + warn. Nunca tira.

**Health computation:**

```ts
health(): { status: AdapterHealth; lastEventAt?: number; detail?: string } {
  const hookHealth = this.#computeHookHealth();
  const parseHealth = this.#computeParseHealth();
  // El peor gana
  const status = worst(hookHealth, parseHealth);
  return { status, lastEventAt: this.#lastEventAt, detail: ... };
}
```

### 1.2 `src/adapters/claude-transcript.ts`

Módulo separado para la lectura one-shot del transcript. Aislado para que un
cambio de formato de Claude solo toque este archivo.

```ts
export interface TranscriptEnrichment {
  text?: string;
  command?: string;
  tokens?: number;
  unknownLineRatio: number;
}

export function readTranscriptTail(
  transcriptPath: string,
  maxLines: number,
): TranscriptEnrichment | null;
```

### 1.3 Fallback state files (SA17)

Al `start()`:
1. Leer `stateDir/*.json`.
2. Para cada archivo: parsear, llamar `handleHookEvent()`, borrar archivo.
3. Errores de lectura/parse → warn + skip (no borrar archivo corrupto).

### 1.4 Tests obligatorios (`test/claude-adapter.test.ts`)

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | UserPromptSubmit crea sesión y emite evento | `{hook_event_name:'UserPromptSubmit', session_id:'s1', cwd:'/tmp/p'}` | sesión 's1' en estado 'working', bus recibe evento `category:'prompt'` |
| 2 | Stop cambia sesión a idle | `{hook_event_name:'Stop', session_id:'s1', ...}` | sesión 's1' estado 'idle', evento `category:'response'` |
| 3 | Notification permission → critical event + DOUBTFUL | `{hook_event_name:'Notification', session_id:'s1', type:'permission'}` | sesión 'permission_pending', evento severity 'critical', category 'permission' |
| 4 | Critical command detection | permission con comando "rm -rf /tmp" | `isCritical: true` en payload |
| 5 | Non-critical command | permission con comando "ls" | `isCritical: false` |
| 6 | Multi-session tracking | eventos de s1 y s2 intercalados | dos sesiones independientes |
| 7 | Stale session cleanup | s1 sin eventos por >staleTimeout | s1 marcada 'stale' (fake timer) |
| 8 | Health HEALTHY | eventos recibidos normalmente | status 'HEALTHY' |
| 9 | Health DEGRADED (hooks) | sin eventos por >5 min | status 'DEGRADED' |
| 10 | Health BROKEN (parse) | unknownLineRatio > 20% | status 'BROKEN' |
| 11 | resolvePermission approve | sesión con permission pending | permission resuelta, sesión 'working' |
| 12 | resolvePermission deny | sesión con permission pending | permission resuelta, sesión 'idle' |
| 13 | Fallback state files resync | archivo JSON en stateDir al start | sesión recreada, archivo borrado |
| 14 | Invalid hook payload | payload sin session_id | warn, no crash, no evento |
| 15 | handleHookEvent idempotencia | mismo evento dos veces | dedup por bus (no crea duplicados) |

### 1.5 `test/claude-transcript.test.ts`

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Parse valid transcript lines | fixture JSONL con 10 líneas válidas | enrichment con text, tokens, ratio 0 |
| 2 | Unknown lines counted | fixture con 3/10 líneas desconocidas | ratio 0.3 |
| 3 | Non-existent file | path inexistente | null (no throw) |
| 4 | Empty file | archivo vacío | null |
| 5 | Permission command extraction | línea de transcript con tool_use | command extraído |

### 1.6 Done M6

- `ClaudeAdapter` instanciable, tests verdes.
- NO se wirean al server todavía (eso es M8 con el endpoint `/hooks/claude`).
- Typecheck + lint + tests verdes.

---

## 2. M7 — `bridge init --hooks` + `bridge doctor`

**Objetivo**: instalar hooks de Claude Code en `settings.json`, instalar hook
script, verificar instalación con `bridge doctor`.

### 2.1 `src/cli.ts` — extensiones

```ts
export interface CliOptions {
  command: 'run' | 'replay' | 'init' | 'doctor';
  // ... campos existentes de Fase 1A ...
  hooks?: boolean;           // bridge init --hooks
}
```

Parsing: `bridge init --hooks`, `bridge doctor` como comandos.

### 2.2 `src/hooks/installer.ts`

```ts
export interface HookInstallResult {
  hooksInstalled: boolean;
  mcpInstalled: boolean;
  scriptPath: string;
  diff: string;             // diff legible del cambio a settings.json
}

/** Lee settings.json, calcula diff, escribe si confirmado. */
export async function installHooks(opts: {
  settingsPath?: string;    // default ~/.claude/settings.json
  scriptDir?: string;       // default ~/.buildagotchi/hooks
  bridgePath?: string;      // default: detectar desde process.argv
  dryRun?: boolean;         // solo mostrar diff
  confirm?: (diff: string) => Promise<boolean>;  // inyectable para tests
}): Promise<HookInstallResult>;

/** Genera el contenido del hook script. */
export function generateHookScript(bridgeUrl: string): string;
```

**Comportamiento:**

1. Leer `~/.claude/settings.json` (crear si no existe con `{}`).
2. Parsear JSON. Si tiene `hooks`, merge con los nuevos (no pisar hooks
   existentes de otras tools). Si no tiene `hooks`, agregar sección completa.
3. Agregar `mcpServers.buildagotchi` si no existe.
4. Calcular diff legible (líneas +/-).
5. Si `dryRun` → devolver diff sin escribir.
6. Si `confirm` → llamar con diff; si `false` → no escribir.
7. Escribir `settings.json` con formato (2 spaces indent).
8. Crear directorio de hooks, escribir script, `chmod +x`.

**Hook script generado** (`~/.buildagotchi/hooks/buildagotchi-hook.sh`):

```bash
#!/usr/bin/env bash
# buildagotchi hook — fire-and-forget, never blocks Claude Code
# Generated by `bridge init --hooks`. Do not edit manually.
set -euo pipefail

BRIDGE_URL="${BUILDAGOTCHI_BRIDGE_URL:-http://127.0.0.1:1780}"
STATE_DIR="${HOME}/.buildagotchi/claude-state"

PAYLOAD=$(cat)

if ! curl -s -m 2 -X POST "${BRIDGE_URL}/hooks/claude" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1; then
  SESSION_ID=$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$STATE_DIR"
    echo "$PAYLOAD" > "${STATE_DIR}/${SESSION_ID}.json"
  fi
fi

exit 0
```

### 2.3 `src/hooks/doctor.ts`

```ts
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(opts: {
  configPath?: string;
  bridgeUrl?: string;
}): Promise<DoctorCheck[]>;
```

Checks:
1. Config file exists and validates.
2. Bridge server reachable (`GET /health` — catch if not running).
3. Claude hooks present in `~/.claude/settings.json`.
4. Hook script exists and is executable.
5. MCP server entry in settings.json.
6. BLE transport status (from `/health`).

### 2.4 Tests obligatorios

**`test/hooks-installer.test.ts`:**

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Fresh install (no settings.json) | archivo inexistente | crea archivo con hooks + MCP, script creado |
| 2 | Merge with existing hooks | settings con hooks de otra tool | hooks de buildagotchi agregados, otros intactos |
| 3 | Already installed (idempotent) | settings con hooks de buildagotchi | no-op, diff vacío |
| 4 | Script generated is valid bash | — | script contiene shebang, curl, exit 0 |
| 5 | Dry run no escribe | dryRun: true | diff devuelto, archivo no modificado |
| 6 | Confirm rejected no escribe | confirm → false | archivo no modificado |
| 7 | MCP server entry added | settings sin mcpServers | mcpServers.buildagotchi agregado |

**`test/doctor.test.ts`:**

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Everything installed | mocks de todo OK | todas las checks 'ok' |
| 2 | Missing hooks | settings sin hooks | check hooks 'fail' |
| 3 | Bridge not running | fetch falla | check bridge 'fail', otros checks siguen |
| 4 | Missing script | script no existe | check script 'fail' |

### 2.5 Done M7

- `bridge init --hooks` instala hooks y MCP en un directorio temporal de test.
- `bridge doctor` reporta estado.
- Typecheck + lint + tests verdes.

---

## 3. M8 — Dashboard UI + server extensions

**Objetivo**: dashboard web funcional en `localhost:1780`, nuevos endpoints
del server para hooks y approve, wiring del ClaudeAdapter.

### 3.1 Server extensions (`src/server/server.ts`)

**Nuevas rutas:**

```ts
// Routing additions en #handle():
if (method === 'POST' && path === '/hooks/claude') return this.#handleHookClaude(req, res);
if (method === 'POST' && path.startsWith('/approve/')) return this.#handleApprove(req, res, path);
if (method === 'GET' && this.#isStaticFile(path)) return this.#serveStatic(path, res);
if (method === 'GET' && path === '/') return this.#serveStatic('/index.html', res);
```

**`POST /hooks/claude` (SA11):**

- Sin auth (hook corre local).
- Rate limit separado: `TokenBucket(120)`.
- Body: JSON del payload del hook (tolerante — `z.record(z.unknown())` + campos
  requeridos `hook_event_name`, `session_id`).
- Delega a `claudeAdapter.handleHookEvent(body)`.
- Responde 202 `{ok: true}` siempre (fire-and-forget para el hook).
- Body inválido → 400 + warn (no crash).

**`POST /approve/:sessionId`:**

- Auth: misma verificación que `POST /events` (Bearer token). En `--simulate`:
  sin auth (para facilitar testing con curl).
- Body: `{action: 'approve' | 'deny'}`.
- Delega a `claudeAdapter.resolvePermission(sessionId, action)`.
- Responde 200 `{resolved: true}` o 404 `{error: 'no pending permission'}`.

**Archivos estáticos (SA12):**

```ts
#serveStatic(path: string, res: ServerResponse): void {
  // Resolver path contra src/server/public/ (o dist/server/public/)
  // Content types: .html → text/html, .css → text/css, .js → text/javascript
  // 404 si no existe
  // Cache: no-cache en dev
}
```

**`BridgeServerOptions` — campos nuevos:**

```ts
export interface BridgeServerOptions {
  // ... campos existentes ...
  claudeAdapter?: ClaudeAdapter;   // undefined si adapter no activo
  publicDir: string;                // path a public/
}
```

**Nuevo broadcast:**

```ts
notifySession(sessions: unknown): void {
  this.#broadcast('session', sessions);
}
```

### 3.2 Dashboard files

**`src/server/public/index.html` (~150 líneas):**

- Estructura semántica: `<header>`, `<main>` con grid de 2 columnas
  (sidebar + content), `<footer>`.
- Sidebar: face panel, metabolic placeholder, health panel.
- Content: sessions panel, events panel, replay panel.
- Links a `dashboard.css` y `dashboard.js`.
- No frameworks, no CDN imports.

**`src/server/public/dashboard.css` (~200 líneas):**

- CSS custom properties para theming (light/dark via `prefers-color-scheme`).
- Grid layout responsive (1 columna en mobile, 2 en desktop).
- Severity color-coding: critical=red, high=orange, medium=amber, low=gray,
  ambient=blue-gray.
- Health status badges: green/yellow/red.
- Emotion emoji mapping en CSS via `data-emotion` attribute.
- Animación sutil en face panel (pulse para permission pending).

**`src/server/public/dashboard.js` (~200 líneas):**

```js
// ES module — no build step
const SSE_URL = '/stream';
const STATE_URL = '/state';
const EVENTS_URL = '/events?limit=50';
const HEALTH_URL = '/health';

// State
let currentState = null;
let sessions = new Map();
let events = [];

// SSE connection with auto-reconnect
function connectSSE() {
  const es = new EventSource(SSE_URL);
  es.addEventListener('state', (e) => updateFace(JSON.parse(e.data)));
  es.addEventListener('event', (e) => addEvent(JSON.parse(e.data)));
  es.addEventListener('health', (e) => updateHealth(JSON.parse(e.data)));
  es.addEventListener('session', (e) => updateSessions(JSON.parse(e.data)));
  es.onerror = () => setTimeout(connectSSE, 3000);
}

// DOM updates
function updateFace(state) { /* actualizar emotion emoji + decorators */ }
function addEvent(event) { /* prepend al panel de eventos */ }
function updateHealth(health) { /* actualizar badges */ }
function updateSessions(data) { /* actualizar lista de sesiones + botones */ }

// Approve/deny buttons
async function approvePermission(sessionId, action) {
  await fetch(`/approve/${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

// Replay buttons
async function replay(type) {
  // POST al endpoint de replay existente o trigger via query params
}

// Init
async function init() {
  const [state, eventsData, health] = await Promise.all([
    fetch(STATE_URL).then(r => r.json()),
    fetch(EVENTS_URL).then(r => r.json()),
    fetch(HEALTH_URL).then(r => r.json()),
  ]);
  updateFace(state.resolvedState);
  events = eventsData;
  renderEvents();
  updateHealth(health);
  connectSSE();
}

init();
```

**Emotion → emoji mapping:**

| Emotion | Emoji |
|---|---|
| NEUTRAL | 😐 |
| HAPPY | 😊 |
| SAD | 😢 |
| ANGRY | 😠 |
| SLEEPY | 😴 |
| DOUBTFUL | 🤔 |
| COLD | 🥶 |
| HOT | 🥵 |

### 3.3 Tests obligatorios

**`test/server-dashboard.test.ts`:**

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | GET / returns index.html | `curl /` | 200, content-type text/html, contiene `<title>` |
| 2 | GET /dashboard.css | `curl /dashboard.css` | 200, content-type text/css |
| 3 | GET /dashboard.js | `curl /dashboard.js` | 200, content-type text/javascript |
| 4 | GET /nonexistent.txt | `curl /nonexistent.txt` | 404 |
| 5 | POST /hooks/claude valid | payload con hook_event_name + session_id | 202 |
| 6 | POST /hooks/claude invalid | payload sin session_id | 400 |
| 7 | POST /hooks/claude rate limit | 121 requests rápidos | último 429 |
| 8 | POST /approve/:id valid | sesión con permission pending | 200 {resolved: true} |
| 9 | POST /approve/:id no permission | sesión sin permission pending | 404 |
| 10 | SSE session event | trigger hook → SSE recibe session update | event type 'session' |

### 3.4 Wiring en `src/index.ts`

- Instanciar `ClaudeAdapter` con config de `config.claude`.
- Pasar `claudeAdapter` al `BridgeServer`.
- Agregar al array `adapters`.
- Shutdown step para adapter.

### 3.5 Done M8

- Dashboard servido y funcional con curl.
- `POST /hooks/claude` acepta payloads y dispara cambios visibles en `/state`.
- `POST /approve/:sessionId` resuelve permisos.
- SSE push de sesiones funcional.
- Demo manual: abrir browser en `localhost:1780`, curl un hook payload,
  ver el dashboard actualizarse en vivo.
- Typecheck + lint + tests verdes.

---

## 4. M9 — MCP server

**Objetivo**: MCP server stdio con tools `notify()`, `set_face()`,
`approve_permission()` y resources `state/current`, `health`.

### 4.1 `src/mcp/server.ts`

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export function createMcpServer(bridgeUrl: string, token: string | null): McpServer;
```

El MCP server se conecta al bridge via HTTP (SA13). Cada tool/resource hace
fetch a `localhost:1780`. El `token` (obtenido del Keychain via `security(1)`
en el entry point) se inyecta como `Authorization: Bearer ...` en las tools
que hacen POST. Si `token === null`, las tools loguean warn y devuelven error
al caller MCP — las resources siguen funcionando (GET /state y /health son
públicos).

**Tools:**

```ts
// notify — empuja evento al pipeline
server.tool('notify', {
  source: z.string().describe('Event source identifier'),
  severity: z.enum(['critical', 'high', 'medium', 'low', 'ambient']),
  category: z.string().describe('Event category'),
  message: z.string().describe('Human-readable message'),
  ttlMs: z.number().optional().describe('Time-to-live in milliseconds'),
}, async (input) => {
  const res = await fetch(`${bridgeUrl}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      source: input.source,
      severity: input.severity,
      category: input.category,
      payload: { message: input.message },
      ttlMs: input.ttlMs,
    }),
  });
  return { content: [{ type: 'text', text: `Event sent: ${res.status}` }] };
});

// set_face — cara temporal via POST /events (SA13b, S2.6)
// NO endpoint /face — reutiliza /events con source:'mcp:set_face'.
server.tool('set_face', {
  emotion: z.enum(['NEUTRAL','HAPPY','SAD','ANGRY','SLEEPY','DOUBTFUL','COLD','HOT']),
  ttlMs: z.number().default(5000).describe('Duration in ms'),
  balloon: z.string().optional().describe('Speech balloon text'),
}, async (input) => {
  const res = await fetch(`${bridgeUrl}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      source: 'mcp:set_face',
      category: 'set_face',
      severity: 'high',
      ttlMs: input.ttlMs,
      payload: { emotion: input.emotion, balloon: input.balloon },
    }),
  });
  return { content: [{ type: 'text', text: `Face set: ${input.emotion} (${res.status})` }] };
});

// approve_permission — aprobar/denegar permiso
server.tool('approve_permission', {
  sessionId: z.string().describe('Claude session ID'),
  action: z.enum(['approve', 'deny']),
}, async (input) => {
  const res = await fetch(`${bridgeUrl}/approve/${input.sessionId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ action: input.action }),
  });
  const body = await res.json();
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
});
```

**Resources:**

```ts
server.resource('state/current', 'buildagotchi://state/current', async () => {
  const res = await fetch(`${bridgeUrl}/state`);
  const data = await res.json();
  return { contents: [{ uri: 'buildagotchi://state/current', text: JSON.stringify(data) }] };
});

server.resource('health', 'buildagotchi://health', async () => {
  const res = await fetch(`${bridgeUrl}/health`);
  const data = await res.json();
  return { contents: [{ uri: 'buildagotchi://health', text: JSON.stringify(data) }] };
});
```

### 4.2 `src/mcp.ts` — entry point

```ts
import pino from 'pino';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MacosPlatform } from './platform/macos.js';
import { TOKEN_ACCOUNT, TOKEN_SERVICE } from './platform/platform.js';
import { createMcpServer } from './mcp/server.js';

const logger = pino({ name: 'mcp' });
const BRIDGE_URL = process.env.BUILDAGOTCHI_BRIDGE_URL ?? 'http://127.0.0.1:1780';

// S2.7: leer el Bearer token del Keychain al arrancar. Sin token, las tools
// devuelven error al caller MCP; las resources (GET) siguen funcionando.
const platform = new MacosPlatform();
const token = await platform.getSecret(TOKEN_SERVICE, TOKEN_ACCOUNT);
if (token === null) {
  logger.warn({}, 'no bridge token in Keychain — MCP tools disabled (run bridge init). Resources still work.');
}

const server = createMcpServer(BRIDGE_URL, token);
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 4.3 Server extension — stateRule para `mcp:set_face`

**No hay nuevo endpoint** (SA13b, C1 del council). La tool `set_face` postea a
`POST /events` existente con `source:'mcp:set_face', category:'set_face'`. El
`StateMachine.#resolve()` tiene un caso especial: si el evento tiene
`source === 'mcp:set_face'` y `payload.emotion` está presente, se sobrescribe
`resolvedState.emotion` con `payload.emotion`. Análogamente, `payload.balloon`
sobrescribe `resolvedState.balloon`.

Cambio mínimo en `state-machine.ts`:

```ts
// En #resolve(), después del rule match y antes del direction handling:
if (e.source === 'mcp:set_face' && typeof e.payload.emotion === 'string') {
  state = { ...state, emotion: e.payload.emotion as Emotion };
  if (typeof e.payload.balloon === 'string') {
    state = { ...state, balloon: e.payload.balloon };
  }
}
```

Zero rutas nuevas, zero cambios en server.ts.

### 4.4 Tests obligatorios (`test/mcp-server.test.ts`)

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | notify tool sends event | `{source:'test', severity:'high', category:'alert', message:'hi'}` | fetch POST /events con Bearer si token, body correcto |
| 2 | set_face tool posts to /events | `{emotion:'HAPPY', ttlMs:3000}` | fetch POST /events con `source:'mcp:set_face'`, payload.emotion='HAPPY' |
| 3 | approve_permission tool | `{sessionId:'s1', action:'approve'}` | fetch POST /approve/s1 con Bearer si token |
| 4 | state/current resource | — | fetch GET /state, retorna JSON |
| 5 | health resource | — | fetch GET /health, retorna JSON |
| 6 | MCP server connects via stdio | — | server instanciable sin crash |
| 7 | Tool sin token loguea warn | token=null | tool devuelve error, no fetch |
| 8 | set_face con balloon | `{emotion:'SAD', balloon:'oops'}` | payload contiene balloon='oops' |

**Nota**: tests mockean `fetch` — no levantan el bridge real. Integration test
manual en M11.

### 4.5 Done M9

- `npm run build` genera `dist/mcp.js`.
- MCP server arrancable con `node dist/mcp.js`.
- Tests verdes.
- Config de MCP verificable con `bridge doctor`.

---

## 5. M10 — Personality presets

**Objetivo**: carga de presets desde YAML, interpolación de templates, wiring
con state machine.

### 5.1 `src/personality/personality.ts`

```ts
import type { Emotion, Severity } from '../core/events.js';

export interface PersonalityPreset {
  name: string;
  idleEmotion: Emotion;
  decoratorsBySeverity: Partial<Record<Severity, string[]>>;
  templates: Record<string, string>;
}

export class PersonalityManager {
  #preset: PersonalityPreset;
  #customTemplates: Record<string, string>;

  constructor(presetName: string, customTemplates?: Record<string, string>);

  balloon(category: string, context?: Record<string, string>): string | null;
  decorators(severity: Severity): string[];
  idleEmotion(): Emotion;
  reload(presetName: string, customTemplates?: Record<string, string>): void;
  presetName(): string;
}
```

**Interpolación (SA14):**

```ts
function interpolate(template: string, context: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => context[key] ?? `{${key}}`);
}
```

Variables: `{project}` (cwd corto — último segmento del path), `{command}`
(del permiso), `{session}` (session_id primeros 8 chars).

### 5.2 `src/personality/loader.ts`

```ts
export function loadPreset(name: string): PersonalityPreset;
```

- Lee `presets/personalities/<name>.yaml` relativo al bridge root.
- Valida con zod schema.
- Fallback: si el archivo no existe, log warn y usar preset hardcoded mínimo
  (NEUTRAL idle, sin templates). Nunca crash.

### 5.3 `presets/personalities/companion.yaml`

```yaml
name: companion
idleEmotion: NEUTRAL
decoratorsBySeverity:
  critical:
    - angry_mark
  high: []
  medium: []
  low: []
  ambient: []
templates:
  permission.pending: "{project}: permiso pendiente"
  permission.critical: "{project}: ⚠ {command}"
  error: "algo salió mal"
  session.new: "nueva sesión"
  session.idle: "{project}: idle"
```

### 5.4 Otros presets (archivos mínimos)

`presets/personalities/supervisor.yaml`:
```yaml
name: supervisor
idleEmotion: NEUTRAL
decoratorsBySeverity:
  critical:
    - angry_mark
templates:
  permission.pending: "Autorización requerida"
  permission.critical: "⚠ {command}"
```

`presets/personalities/mascot.yaml`:
```yaml
name: mascot
idleEmotion: HAPPY
decoratorsBySeverity:
  critical:
    - sweat
templates: {}
```

`presets/personalities/critic.yaml`:
```yaml
name: critic
idleEmotion: DOUBTFUL
decoratorsBySeverity:
  critical:
    - angry_mark
    - sweat
templates:
  permission.pending: "¿Estás seguro?"
  permission.critical: "Eso parece peligroso: {command}"
```

### 5.5 Wiring con StateMachine

La state machine recibe el `PersonalityManager` como dependencia. Al resolver
estado:

1. Si hay balloon de personality para el `category` del evento →
   `resolvedState.balloon = personality.balloon(category, context)`.
2. Decorators del personality se mergeean con los de la regla (sin duplicar).
3. Background mood usa `personality.idleEmotion()` en vez de NEUTRAL hardcoded.

```ts
// En StateMachine constructor:
constructor(rules, deps, personality?: PersonalityManager);

// En #resolve:
if (this.#personality) {
  const balloon = this.#personality.balloon(e.category, {
    project: shortPath(e.payload.cwd as string),
    command: e.payload.command as string ?? '',
    session: (e.payload.sessionId as string ?? '').slice(0, 8),
  });
  if (balloon) resolved.balloon = balloon;

  const extraDecorators = this.#personality.decorators(e.severity);
  resolved.decorators = [...new Set([...resolved.decorators, ...extraDecorators])];
}
```

### 5.6 Tests obligatorios (`test/personality.test.ts`)

| # | Test | Input | Expected |
|---|------|-------|----------|
| 1 | Load companion preset | name='companion' | preset cargado con templates |
| 2 | Balloon interpolation | `balloon('permission.pending', {project:'myapp'})` | `"myapp: permiso pendiente"` |
| 3 | Missing variable | `balloon('permission.pending', {})` | `"{project}: permiso pendiente"` (no crash) |
| 4 | Unknown category | `balloon('unknown.category')` | null |
| 5 | Decorators by severity | `decorators('critical')` | `['angry_mark']` |
| 6 | Idle emotion | companion | NEUTRAL |
| 7 | Idle emotion critic | critic | DOUBTFUL |
| 8 | Custom templates override | `presetName='companion', custom={'permission.pending':'custom'}` | custom template used |
| 9 | Reload changes preset | reload de companion a supervisor | idleEmotion mismo, templates distintas |
| 10 | Missing preset file | name='nonexistent' | fallback mínimo, warn logged |

### 5.7 Done M10

- 4 preset files creados.
- PersonalityManager wired al StateMachine.
- Balloons visibles en `/state` y dashboard.
- Hot-reload de `config.personality.preset` cambia preset en vivo.
- Typecheck + lint + tests verdes.

---

## 6. M11 — Integration + bridge doctor + config update

**Objetivo**: integración end-to-end de todos los componentes, actualización de
config.example.yaml, bridge doctor funcional, y verificación de los 5 criterios
de done de la Fase 2.

### 6.1 Config schema update (`src/config/schema.ts`)

Agregar las nuevas secciones con defaults (SA18):

```ts
// Nuevos campos en ConfigSchema:
claude: z.object({
  staleSessionTimeout: DurationSchema.default('30m'),
  transcriptReadEnabled: z.boolean().default(true),
  unknownLineThreshold: z.number().default(5),
  unknownLineBrokenThreshold: z.number().default(20),
}).default({}),

mcp: z.object({
  enabled: z.boolean().default(true),
}).default({}),

dashboard: z.object({
  enabled: z.boolean().default(true),
}).default({}),
```

### 6.2 `config.example.yaml` update

Agregar al final del archivo existente:

```yaml
# ClaudeAdapter config (D19, D21). Hooks installed via `bridge init --hooks`.
claude:
  staleSessionTimeout: 30m          # session without events → stale
  transcriptReadEnabled: true        # one-shot transcript reads for enrichment
  unknownLineThreshold: 5            # % unknown lines → DEGRADED
  unknownLineBrokenThreshold: 20     # % unknown lines → BROKEN

# MCP server (D26). Exposed as stdio server for Claude Code.
mcp:
  enabled: true

# Dashboard UI served at localhost:1780.
dashboard:
  enabled: true
```

### 6.3 `src/index.ts` — composición completa

Actualizar el composition root:

```ts
// Después del StateMachine existente:
const personality = new PersonalityManager(
  config.personality.preset,
  config.personality.preset === 'custom' ? config.personality.templates : undefined,
);
// Pasar personality al StateMachine (nuevo parámetro)

const claudeAdapter = new ClaudeAdapter(config.claude, {
  logger,
  metrics,
  criticalCommands: config.criticalCommands,
  stateDir: path.join(platform.dataDir(), 'claude-state'),
});
adapters.push(claudeAdapter);

// BridgeServer con nuevas opciones:
const server = new BridgeServer({
  // ... campos existentes ...
  claudeAdapter,
  publicDir: path.join(import.meta.dirname, 'server', 'public'),
});

// Hot-reload de personality:
configLoader.watch((next) => {
  // ... reloads existentes ...
  personality.reload(
    next.personality.preset,
    next.personality.preset === 'custom' ? next.personality.templates : undefined,
  );
});

// Adapter start:
await claudeAdapter.start(bus);
```

### 6.4 Bridge doctor wiring

```ts
// En cli.ts, comando 'doctor':
case 'doctor':
  const checks = await runDoctor({ configPath: options.configPath });
  for (const check of checks) {
    const icon = check.status === 'ok' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
    console.log(`${icon} ${check.name}: ${check.detail}`);
  }
  process.exit(checks.some(c => c.status === 'fail') ? 1 : 0);
```

### 6.5 Tests de integración (`test/integration-fase2.test.ts`)

| # | Test | Escenario | Verificación |
|---|------|-----------|--------------|
| 1 | Hook → state change | POST /hooks/claude con UserPromptSubmit | GET /state muestra sesión working |
| 2 | Permission flow e2e | Notification permission → approve | estado pasa de DOUBTFUL a NEUTRAL |
| 3 | Critical permission | permission con "rm -rf" | payload.isCritical true |
| 4 | Dashboard serves | GET / | 200 con HTML |
| 5 | SSE updates on hook | POST hook → escuchar SSE | event 'session' recibido |
| 6 | Multi-session | hooks de 2 sesiones | /state muestra 2 sesiones |
| 7 | Stale session | hook s1 → wait staleTimeout → /state | s1 marcada stale |
| 8 | Config backward compat | config de Fase 1A sin secciones nuevas | valida OK con defaults |
| 9 | Personality balloon | permission event con companion preset | balloon incluye template |
| 10 | Hot-reload personality | cambiar preset en config.yaml | balloon cambia sin restart |

### 6.6 Verificación manual end-to-end (documentar en commit)

```bash
# 1. Arrancar bridge
cd bridge && npm run dev -- --simulate

# 2. Verificar dashboard
open http://localhost:1780

# 3. Simular hook de UserPromptSubmit
curl -s -X POST http://localhost:1780/hooks/claude \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"UserPromptSubmit","session_id":"test-123","cwd":"/tmp/myproject"}'

# 4. Verificar estado
curl -s http://localhost:1780/state | python3 -m json.tool

# 5. Simular permission
curl -s -X POST http://localhost:1780/hooks/claude \
  -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Notification","session_id":"test-123","cwd":"/tmp/myproject","type":"permission"}'

# 6. Verificar DOUBTFUL
curl -s http://localhost:1780/state | python3 -m json.tool
# → emotion: "DOUBTFUL"

# 7. Approve
curl -s -X POST http://localhost:1780/approve/test-123 \
  -H 'Content-Type: application/json' \
  -d '{"action":"approve"}'

# 8. Verificar volvió a NEUTRAL
curl -s http://localhost:1780/state | python3 -m json.tool

# 9. Bridge doctor
npx tsx src/cli.ts doctor

# 10. MCP server (en otra terminal)
node dist/mcp.js
# → Verificar que arranca sin crash
```

### 6.7 Done M11 = cierre de Fase 2

- Los 5 criterios de §1 de SPEC-FASE-2.md verificados.
- `config.example.yaml` actualizado con secciones nuevas.
- `bridge doctor` funcional.
- Suite completa verde + typecheck + lint.
- Dashboard funcional con SSE live updates.
- MCP server arrancable y funcional.
- Actualizar NOTES.md → "Fase 2 cerrada" con fecha y sorpresas.

---

## 7. Resumen de dependencias entre milestones

```
M6 (ClaudeAdapter) ─────→ M8 (Dashboard + server wiring)
                               │
M7 (init --hooks + doctor) ────┤
                               │
                               ▼
                          M9 (MCP server) ──→ M11 (Integration)
                               │
M10 (Personality presets) ─────┘
```

**Camino crítico**: M6 → M8 → M11. M7, M9, M10 son paralelizables una vez
que M6 esté completo (comparten solo interfaces ya congeladas en Fase 1A y
M6).

**Detalle de paralelización:**
- M7 (hooks installer) no toca el runtime del bridge — solo CLI + filesystem.
- M9 (MCP server) es un proceso separado que habla HTTP al bridge.
- M10 (personality) toca StateMachine pero con un parámetro opcional nuevo que
  no rompe la interfaz existente.
- M8 (dashboard) es el integrador: wirear ClaudeAdapter + server + dashboard.
  Requiere M6 completo.
- M11 cierra todo: integration tests, config update, doctor wiring.

---

## 8. Archivos por milestone

| Milestone | Archivos nuevos | Archivos modificados |
|---|---|---|
| M6 | `src/adapters/claude-adapter.ts`, `src/adapters/claude-transcript.ts`, `test/claude-adapter.test.ts`, `test/claude-transcript.test.ts` | — |
| M7 | `src/hooks/installer.ts`, `src/hooks/doctor.ts`, `test/hooks-installer.test.ts`, `test/doctor.test.ts` | `src/cli.ts` |
| M8 | `src/server/public/index.html`, `src/server/public/dashboard.css`, `src/server/public/dashboard.js`, `test/server-dashboard.test.ts` | `src/server/server.ts`, `src/index.ts` |
| M9 | `src/mcp/server.ts`, `src/mcp.ts`, `test/mcp-server.test.ts` | `package.json` (add @modelcontextprotocol/sdk), `src/core/state-machine.ts` (mcp:set_face override) |
| M10 | `src/personality/personality.ts`, `src/personality/loader.ts`, `presets/personalities/companion.yaml`, `presets/personalities/supervisor.yaml`, `presets/personalities/mascot.yaml`, `presets/personalities/critic.yaml`, `test/personality.test.ts` | `src/core/state-machine.ts` |
| M11 | `test/integration-fase2.test.ts` | `src/config/schema.ts`, `src/index.ts`, `src/cli.ts`, `config.example.yaml` |
