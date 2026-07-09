# SPEC — Fase 2: Monitor de Claude Code (MVP)

Spec arquitectónica de la Fase 2 del [ROADMAP](ROADMAP.md). Las decisiones
grandes viven en [DECISIONS.md](DECISIONS.md) (referenciadas como D*n*); las
decisiones nuevas de esta spec se numeran **S2.*n*** y se promueven a
DECISIONS.md si crecen en importancia.

La Fase 1A está implementada (M0–M5). El hardware NO ha llegado — todo se
verifica con `--simulate` (BLE simulado, reacciones visibles en `/state`,
`/stream` SSE, `/events`, logs, y el dashboard web que se construye en esta
fase).

Estado: **borrador aprobable**.

---

## 1. Objetivo y criterio de done

El StackChan refleja el estado real de mi trabajo con Claude Code. Este es el
MVP (D20). Si no lo uso tres semanas (con burn-in de 3 días, D22), no sigo.

**Done** = los 5 criterios siguientes pasan:

| # | Criterio | Verificación |
|---|----------|--------------|
| 1 | ClaudeAdapter recibe hooks y refleja estado en `/state` | `bridge init --hooks` instala; lanzar Claude Code → `/state` muestra sesión activa |
| 2 | Dashboard muestra estado actual, eventos recientes, health | `open http://localhost:1780` — UI funcional con SSE live |
| 3 | MCP server expone tools y resources | Claude Code con MCP configurado puede llamar `notify()` y leer `state/current` |
| 4 | Permission pending → cara DOUBTFUL + LED ámbar; approve/deny via POST o MCP | `curl POST /approve/:id` o MCP tool `approve_permission()` |
| 5 | Personalidad `companion` cargada desde config, aplicando templates | Balloon y decorators reflejan el preset activo |

## 2. Alcance y no-alcance

### En scope

- **ClaudeAdapter** basado en hooks oficiales (D19), multi-instancia por
  `session_id`, lectura one-shot del transcript, health HEALTHY/DEGRADED/BROKEN
  (D21), `bridge init --hooks` para instalar.
- **Dashboard UI** web en `localhost:1780`: estado actual, Metabolic Score
  placeholder, eventos recientes, health de adapters/BLE, replay controls.
- **MCP server mínimo**: tools `notify()` y `set_face()`, resources
  `state/current` y `health`.
- **Personalidad activa** (D28): preset `companion` default, cara + decorators
  (sin TTS).
- **Permission flow** (D6): cara DOUBTFUL + LED ámbar al pedir permiso. Sin
  hardware: approve/deny via `POST /approve/:id` y MCP tool
  `approve_permission(id)`.
- **bridge doctor**: verificación de salud de hooks, config, y conectividad.

### Fuera de scope

- Metabolic State engine (Fase 4) — solo placeholder visual "CALM" fijo.
- TTS / STT (Fase 5).
- Adapters de trabajo: Jira, GitHub, Calendar (Fase 3).
- ChromeAdapter (Fase 6).
- Transport BLE real (Fase 1B).
- Touch físico para approve/deny (requiere hardware).
- Token tracking via ccusage/API (se evalúa post-MVP con hardware).
- `PreToolUse` hook para approve/deny desde la cabeza (investigación futura).

## 3. Componentes nuevos

### 3.1 ClaudeAdapter (`src/adapters/claude-adapter.ts`)

Adapter para Claude Code basado en hooks oficiales (D19). Los hooks son scripts
shell que postean al bridge; el bridge NO lee `settings.json` ni tailea
archivos.

**Eventos de hook consumidos:**

| Hook event | Lo que el adapter hace |
|---|---|
| `UserPromptSubmit` | Crear/actualizar sesión → estado `working` |
| `Stop` | Lectura one-shot del transcript → extraer respuesta, tokens. Estado `idle` |
| `Notification` | Clasificar: si `type === 'permission'` → evento `permission` critical; si `type === 'progress'` → evento `progress` ambient |
| `SubagentStop` | Actualizar tracking de sesión (subagente terminó) |

**Nota**: `SessionStart` y `SessionEnd` no son hooks de Claude Code — el
adapter infiere inicio de sesión del primer evento de cada `session_id`, y fin
por inactividad configurable o por un `Stop` final.

```ts
interface ClaudeSession {
  sessionId: string;
  cwd: string;
  state: 'working' | 'idle' | 'permission_pending' | 'stale';
  lastEventAt: number;
  pendingPermission?: {
    eventId: string;      // id del Event en el bus
    command?: string;     // comando que pide permiso (del transcript)
    isCritical: boolean;  // matchea criticalCommands (D6)
  };
}

interface ClaudeAdapterConfig {
  staleSessionTimeoutMs: number;     // default 30m — sesión sin eventos
  transcriptReadEnabled: boolean;    // default true — lectura one-shot
  unknownLineThreshold: number;      // D21: % líneas desconocidas para DEGRADED
  unknownLineBrokenThreshold: number; // D21: % para BROKEN
}
```

**Contratos:**

```ts
export class ClaudeAdapter implements Adapter {
  readonly name = 'claude';

  constructor(cfg: ClaudeAdapterConfig, deps: {
    logger: MinimalLogger;
    metrics: Metrics;
    criticalCommands: string[];
  });

  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string };

  /** Llamado por el server al recibir POST /events con source 'claude'. */
  handleHookEvent(hookPayload: ClaudeHookPayload): void;

  /** Sesiones activas — para el dashboard y MCP resources. */
  sessions(): ReadonlyMap<string, ClaudeSession>;

  /** Resolver permission pending de una sesión. */
  resolvePermission(sessionId: string, action: 'approved' | 'denied'): boolean;
}
```

**Payload del hook (lo que llega por stdin al script):**

```ts
interface ClaudeHookPayload {
  hook_event_name: string;     // 'UserPromptSubmit' | 'Stop' | 'Notification' | 'SubagentStop'
  session_id: string;
  cwd: string;
  transcript_path?: string;    // ruta al JSONL del transcript
  // campos adicionales según el hook event
  [key: string]: unknown;
}
```

**Health (D21) — doble señal:**

1. **Canal de hooks**: HEALTHY si hooks instalados y al menos un evento recibido
   desde el último session tracking. DEGRADED si hay procesos `claude` corriendo
   pero cero hooks en >5 min. BROKEN si hooks desinstalados o script falla
   repetidamente.
2. **Parsing one-shot**: % de líneas desconocidas en las últimas 20 lecturas.
   <5% HEALTHY, 5-20% DEGRADED (decorator "?"), >20% BROKEN (cara DOUBTFUL +
   balloon "Claude cambió").

El peor de las dos señales gana.

**Lectura one-shot del transcript (S2.1):**

Al recibir `Stop` o `Notification` con `transcript_path`, el adapter lee las
últimas N líneas del JSONL (configurable, default 50) para extraer:

- Texto de la respuesta de Claude (para balloon/logs).
- Comando del permiso (para clasificar critical vs non-critical, D6).
- Tokens del turno (para métricas).

Parsing tolerante: campo desconocido → skip + conteo para health. Crash de
lectura → warn + funciona sin enriquecimiento (los hooks ya dan estado básico).

**Fallback local (D19):**

Si el bridge no responde al POST (timeout 2s del hook script), el script
escribe estado en `~/.buildagotchi/claude-state/<session_id>.json`. Al arrancar,
el ClaudeAdapter lee estos archivos para resync.

### 3.2 Hook script (`scripts/buildagotchi-hook.sh`)

Script shell instalado por `bridge init --hooks`. Reglas no negociables (D19):

```bash
#!/usr/bin/env bash
# buildagotchi hook — fire-and-forget, never blocks Claude Code
set -euo pipefail

BRIDGE_URL="${BUILDAGOTCHI_BRIDGE_URL:-http://127.0.0.1:1780}"
STATE_DIR="${HOME}/.buildagotchi/claude-state"

# Read hook payload from stdin
PAYLOAD=$(cat)

# Fire-and-forget POST to bridge
if ! curl -s -m 2 -X POST "${BRIDGE_URL}/hooks/claude" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" >/dev/null 2>&1; then
  # Fallback: write state file for resync
  SESSION_ID=$(echo "$PAYLOAD" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$STATE_DIR"
    echo "$PAYLOAD" > "${STATE_DIR}/${SESSION_ID}.json"
  fi
fi

exit 0  # NEVER block Claude Code
```

**`bridge init --hooks` (S2.2):**

- Lee `~/.claude/settings.json` (o `settings.local.json`).
- Agrega/actualiza la sección `hooks` con el script para cada evento.
- Muestra diff antes de escribir, pide confirmación (patrón ccboard).
- Si los hooks ya están instalados y son idénticos: no-op con mensaje.
- Escribe el script en `~/.buildagotchi/hooks/buildagotchi-hook.sh` con `+x`.

**Estructura de hooks en settings.json:**

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "~/.buildagotchi/hooks/buildagotchi-hook.sh"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "~/.buildagotchi/hooks/buildagotchi-hook.sh"
      }
    ],
    "Notification": [
      {
        "type": "command",
        "command": "~/.buildagotchi/hooks/buildagotchi-hook.sh"
      }
    ],
    "SubagentStop": [
      {
        "type": "command",
        "command": "~/.buildagotchi/hooks/buildagotchi-hook.sh"
      }
    ]
  }
}
```

### 3.3 Dashboard UI (`src/server/public/`)

HTML/CSS/JS vanilla servido por el bridge. Sin framework frontend. SSE para
actualizaciones en tiempo real.

**Layout:**

```
┌──────────────────────────────────────────────────┐
│  buildagotchi dashboard          [NORMAL] [●]    │
├──────────┬───────────────────────────────────────┤
│          │                                       │
│  FACE    │  Claude Sessions                      │
│  [emoji] │  ├─ session-abc (~/Dev/proj) working  │
│          │  └─ session-def (~/Dev/api)  idle     │
│  CALM    │                                       │
│  ──────  │  Recent Events                        │
│          │  ├─ 14:23 permission critical claude   │
│  Health  │  ├─ 14:21 prompt     ambient  claude   │
│  claude  │  └─ 14:20 error      high     external │
│  ● OK    │                                       │
│  BLE     │  Replay                               │
│  ○ sim   │  [30min] [today] [file...]            │
│          │                                       │
└──────────┴───────────────────────────────────────┘
```

**Componentes:**

- **Face panel**: emoji que refleja `emotion` actual + decorators como texto.
  Metabolic Score placeholder: siempre muestra "CALM" (Fase 4 lo reemplaza).
- **Sessions panel**: lista de sesiones Claude activas con estado, cwd corto,
  y botones approve/deny si hay permission pending.
- **Events panel**: últimos 50 eventos con timestamp, category, severity,
  source. Scroll automático. Nuevos eventos llegan por SSE.
- **Health panel**: estado de cada adapter + transport BLE. Color-coded:
  verde/amarillo/rojo.
- **Replay panel**: botones que disparan replay de los últimos 30 min, del día,
  o de un archivo seleccionado (usando la API de replay existente).

**SSE events consumidos:**

| SSE event type | Actualiza |
|---|---|
| `state` | Face panel (emotion + decorators) |
| `event` | Events panel (prepend) |
| `health` | Health panel |
| `session` | Sessions panel (nuevo tipo de SSE) |

**Servido desde el bridge:**

- `GET /` → `public/index.html`
- `GET /dashboard.css` → `public/dashboard.css`
- `GET /dashboard.js` → `public/dashboard.js`
- Archivos estáticos resueltos por path bajo `public/`.

### 3.4 MCP server (`src/mcp/server.ts`)

MCP server usando `@modelcontextprotocol/sdk`. Se registra como stdio server
que el bridge levanta, o como server HTTP en un puerto dedicado.

**S2.3 — Transporte MCP**: stdio (el bridge lo levanta como child process
cuando Claude Code lo necesita). Claude Code se configura para usar el MCP
server del bridge.

**Tools:**

```ts
// notify: empuja un evento al pipeline (mismo efecto que POST /events,
// sin auth — confiamos en MCP localhost)
tool('notify', {
  description: 'Send a notification event to buildagotchi',
  inputSchema: {
    source: z.string(),
    severity: SeveritySchema,
    category: z.string(),
    message: z.string(),
    ttlMs: z.number().optional(),
  },
  handler: async (input) => { /* → bus.publish(newEvent(...)) */ },
});

// set_face: cara temporal via evento sintético con source:'mcp'.
// NO endpoint dedicado — reutiliza POST /events. Una stateRule con
// match {source:'mcp', category:'set_face'} usa la emoción del payload.
tool('set_face', {
  description: 'Set a temporary face expression on buildagotchi',
  inputSchema: {
    emotion: EmotionSchema,
    ttlMs: z.number().default(5000),
    balloon: z.string().optional(),
  },
  handler: async (input) => {
    // POST /events con source:'mcp:set_face', severity:'high', ttlMs del input
    // payload:{emotion, balloon} — el stateRule aplica emotion directamente
  },
});

// approve_permission: aprobar/denegar un permiso pendiente
tool('approve_permission', {
  description: 'Approve or deny a pending Claude Code permission',
  inputSchema: {
    sessionId: z.string(),
    action: z.enum(['approve', 'deny']),
  },
  handler: async (input) => { /* → claudeAdapter.resolvePermission(...) */ },
});
```

**Resources (read-only, D26):**

```ts
resource('state/current', {
  description: 'Current buildagotchi state',
  handler: async () => ({
    emotion: stateMachine.current().emotion,
    decorators: stateMachine.current().decorators,
    metabolicScore: null,  // placeholder Fase 4
    mode: attentionManager.getMode(),
    activeEvent: attentionManager.snapshot().active,
    queueDepth: attentionManager.snapshot().queue.length,
    sessions: claudeAdapter.sessions(),
  }),
});

resource('health', {
  description: 'Health status of buildagotchi adapters and transport',
  handler: async () => getHealth(),
});
```

### 3.5 Personalidad (`src/personality/personality.ts`)

Carga de presets desde `presets/personalities/<name>.yaml` y aplicación de
templates. Capa de expresión encima del pipeline (D28).

```ts
interface PersonalityPreset {
  name: string;
  idleEmotion: Emotion;
  decoratorsBySeverity: Record<Severity, string[]>;
  templates: Record<string, string>;  // 'permission.pending' → '...'
}

export class PersonalityManager {
  constructor(presetName: string, customTemplates?: Record<string, string>);

  /** Dado un category.subcategory, devuelve el template renderizado o null. */
  balloon(category: string, context?: Record<string, string>): string | null;

  /** Decorators default para una severidad. */
  decorators(severity: Severity): string[];

  /** Emoción idle (para background mood). */
  idleEmotion(): Emotion;

  /** Recarga el preset (hot-reload). */
  reload(presetName: string, customTemplates?: Record<string, string>): void;
}
```

**Preset `companion` (`presets/personalities/companion.yaml`):**

```yaml
name: companion
idleEmotion: NEUTRAL
decoratorsBySeverity:
  critical: ['angry_mark']
  high: []
  medium: []
  low: []
  ambient: []
templates:
  permission.pending: "{project}: permiso pendiente"
  permission.critical: "{project}: ⚠ {command}"
  error.claude: "algo salió mal"
  session.new: "nueva sesión"
```

## 4. Componentes existentes que se extienden

### 4.1 BridgeServer (`src/server/server.ts`)

**Cambios:**

- Nueva ruta `POST /hooks/claude` — endpoint dedicado para el hook script.
  Sin auth (el hook corre local y no tiene acceso al token). Rate limit
  separado: 120/min (hooks disparan más frecuente que eventos externos).
  Body: `ClaudeHookPayload`. Delega al ClaudeAdapter.
- Nueva ruta `POST /approve/:id` — approve/deny de permisos. Body:
  `{action: 'approve' | 'deny'}`. Delega al ClaudeAdapter.
- Nueva ruta `GET /` y archivos estáticos bajo `public/` — sirve el dashboard.
- Nuevo SSE event type `session` — push de cambios en sesiones Claude.
- Método `notifySession(session)` para broadcasting.

### 4.2 Config schema (`src/config/schema.ts`)

**Nuevas secciones:**

```yaml
claude:                               # ClaudeAdapter config
  staleSessionTimeout: 30m
  transcriptReadEnabled: true
  unknownLineThreshold: 5             # % para DEGRADED
  unknownLineBrokenThreshold: 20      # % para BROKEN

mcp:                                  # MCP server config
  enabled: true
  # S2.3: stdio transport — no port needed

dashboard:
  enabled: true                       # servir archivos estáticos
```

### 4.3 CLI (`src/cli.ts`)

**Nuevos comandos:**

```ts
export interface CliOptions {
  command: 'run' | 'replay' | 'init' | 'doctor';
  // ... campos existentes ...
  hooks?: boolean;  // bridge init --hooks
}
```

- `bridge init --hooks` — instala hooks de Claude Code.
- `bridge doctor` — verifica salud de hooks, config, conectividad.

### 4.4 EventRecorder (`src/recorder/recorder.ts`)

**Sin cambios de interfaz**. El ClaudeAdapter usa el recorder existente via el
bus hook `onAccepted`. Nuevo `line_type` de facto: los eventos con
`source: 'claude'` ya se registran como `event`.

### 4.5 Index.ts (`src/index.ts`)

**Cambios en composición:**

- Instanciar ClaudeAdapter y agregarlo al array `adapters`.
- Instanciar PersonalityManager y pasarlo al StateMachine.
- Instanciar MCP server (si `config.mcp.enabled`).
- Wiring de `POST /hooks/claude` → `claudeAdapter.handleHookEvent`.
- Wiring de `POST /approve/:id` → `claudeAdapter.resolvePermission`.
- Hot-reload de personalidad al cambiar `config.personality`.

## 5. Flujo de datos

```
Claude Code (session N)
    │
    ├── hook script ──POST /hooks/claude──→ ClaudeAdapter
    │                                          │
    │                                    handleHookEvent()
    │                                          │
    │                              ┌───────────┴──────────┐
    │                              │                      │
    │                     one-shot transcript       update session
    │                     read (enrich)             tracker
    │                              │                      │
    │                              └──────┬───────────────┘
    │                                     │
    │                              newEvent(...)
    │                                     │
    │                              bus.publish()
    │                                     │
    │                        ┌────────────┼────────────┐
    │                        │            │            │
    │                    recorder    AM.push()    SSE broadcast
    │                   (ndjson)         │         (event)
    │                                   │
    │                          onActiveChange()
    │                                   │
    │                          stateMachine.apply()
    │                                   │
    │                    ┌──────────────┼──────────────┐
    │                    │             │              │
    │              personality    emit(state)    SSE broadcast
    │              .balloon()        │            (state)
    │                    │           │
    │                    └─────┬─────┘
    │                          │
    │                   transport.send()
    │                   (sim: stdout)
    │
    ├── MCP tools ──→ bus.publish() / stateMachine.forceTemporary()
    │
    └── MCP resources ──→ stateMachine.current() / getHealth()

Dashboard (browser)
    │
    ├── GET / ──→ index.html
    ├── GET /stream ──→ SSE (state, event, health, session)
    ├── POST /approve/:id ──→ claudeAdapter.resolvePermission()
    └── GET /state, /events, /health ──→ snapshots JSON
```

## 6. Permission flow detallado (D6)

```
Notification hook (type=permission)
    │
    ▼
ClaudeAdapter.handleHookEvent()
    │
    ├── one-shot transcript read → extraer comando
    ├── check criticalCommands config → isCritical
    ├── crear Event {source:'claude', category:'permission', severity:'critical'}
    │   payload: {sessionId, command, isCritical, cwd}
    │   ttlMs: undefined (override en config → infinite)
    ├── session.state = 'permission_pending'
    ├── session.pendingPermission = {eventId, command, isCritical}
    │
    ▼
bus.publish() → AM.push() → stateMachine.apply()
    │
    ▼
stateRule match: {source:'claude', category:'permission'}
    │
    ▼
ResolvedState: {emotion:'DOUBTFUL', leds:[amber], balloon: personality template}
    │
    ▼
transport.send() + SSE broadcast
    │
    ▼ (esperando resolución)
    │
POST /approve/:id {action:'approve'}  ── o ──  MCP tool approve_permission()
    │
    ▼
claudeAdapter.resolvePermission(sessionId, 'approved')
    │
    ├── AM.resolve(eventId, 'approved')
    ├── session.state = 'working'
    ├── session.pendingPermission = undefined
    │
    ▼
AM promueve siguiente en cola → stateMachine → nueva cara
```

**En modo `--simulate`**: no hay touch físico. Approve/deny exclusivamente via:
1. `POST /approve/:sessionId` con body `{action: 'approve' | 'deny'}`.
2. MCP tool `approve_permission(sessionId, action)`.
3. Botón en el dashboard (que hace POST al endpoint).

**SPEC GAP**: D19 menciona que `PreToolUse` hooks pueden *responder*
allow/deny — esto permitiría que el bridge apruebe directamente sin keystroke
injection. Se investiga como extensión post-MVP. Por ahora, approve/deny solo
registra la decisión en el state tracker del bridge; el usuario todavía debe
aprobar en la terminal de Claude Code.

## 7. Métricas nuevas (`/metrics`)

Además de las existentes de SPEC §13:

```
claude_sessions_active                            gauge
claude_hook_events_total{hook_event}              counter
claude_transcript_reads_total                     counter
claude_transcript_unknown_lines_ratio             gauge     # salud del parsing
claude_permissions_total{action}                  counter   # approved/denied
mcp_tool_calls_total{tool}                        counter
mcp_resource_reads_total{resource}                counter
dashboard_connections_active                      gauge     # SSE clients
```

## 8. Nuevas stateRules sugeridas (`config.example.yaml`)

```yaml
stateRules:
  # ... reglas existentes ...

  - match: { source: claude, category: permission }
    state:
      emotion: DOUBTFUL
      servo: { pitch: 10 }
      leds: [{ row: left, color: amber, pattern: solid }]
      balloon: "{personality_template}"

  - match: { source: claude, category: prompt }
    state:
      emotion: NEUTRAL
      decorators: ['heart']

  - match: { source: claude, category: error }
    state:
      emotion: SAD
      leds: [{ row: right, color: red, pattern: solid }]

  - match: { source: claude, category: progress }
    state:
      emotion: HAPPY

  # S2.6: set_face MCP tool — la emoción viene del payload, no de la rule.
  # El StateMachine tiene un caso especial para {source: mcp:set_face}: si
  # `payload.emotion` está presente, sobrescribe `state.emotion`.
  - match: { source: mcp:set_face, category: set_face }
    state:
      emotion: NEUTRAL  # placeholder — se sobrescribe con payload.emotion
```

## 9. `bridge doctor` (S2.4)

Comando de verificación que reporta el estado de salud de la instalación:

```bash
$ bridge doctor

✓ Config file found and valid
✓ Bridge server reachable at http://127.0.0.1:1780
✓ Claude hooks installed in ~/.claude/settings.json
  - UserPromptSubmit ✓
  - Stop ✓
  - Notification ✓
  - SubagentStop ✓
✓ Hook script exists and is executable
✓ MCP server configured
✗ BLE transport: simulated (no hardware)
```

Checks:
1. Config file: existe, parsea, valida.
2. Bridge server: reachable (`GET /health`).
3. Claude hooks: `settings.json` contiene las entradas correctas.
4. Hook script: existe, `+x`, contenido no corrupto.
5. MCP server: configurado en Claude Code (best-effort check).
6. BLE transport: estado actual.

## 10. Configuración MCP en Claude Code (S2.5)

El MCP server del bridge se configura en `~/.claude/settings.json` (o
project-level) como:

```json
{
  "mcpServers": {
    "buildagotchi": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-bridge>/dist/mcp.js"]
    }
  }
}
```

`bridge init --hooks` lo instala junto con los hooks (misma confirmación).

## 11. Decisiones de esta spec (resumen S2.*)

- **S2.1** — Lectura one-shot del transcript: últimas 50 líneas del JSONL,
  parsing tolerante, fallos no bloquean el flujo.
- **S2.2** — `bridge init --hooks` instala hooks + MCP en `settings.json` con
  diff visible y confirmación; el script vive en `~/.buildagotchi/hooks/`.
- **S2.3** — MCP transport: stdio (child process). Sin puerto dedicado.
- **S2.4** — `bridge doctor` verifica hooks, config, conectividad, MCP.
- **S2.5** — MCP server del bridge se registra como stdio server en la config
  de Claude Code.
- **S2.6** — **MCP tools reutilizan endpoints existentes** (resolución C1 del
  council). No hay `POST /face`: `set_face` postea a `POST /events` con
  `source:'mcp:set_face', category:'set_face', severity:'high'` y payload
  `{emotion, balloon?}`. Una stateRule para ese source/category aplica la
  emoción directamente. `approve_permission` usa `POST /approve/:sessionId`
  existente. Zero superficie nueva en el server para MCP.
- **S2.7** — **MCP server obtiene el Bearer token del Keychain via
  `security(1)`** al arrancar (resolución C4 del council). Ambos (bridge y
  MCP) son procesos locales del mismo usuario — comparten acceso al Keychain
  vía `platform.getSecret()`. Si no hay token: el MCP funciona en modo
  read-only (solo resources, tools deshabilitadas con warn) o el usuario
  corre `bridge init` primero. Sin variables de entorno, sin config manual
  del token en Claude Code.

## 12. Cuestiones abiertas

- **Q5** — Formato exacto del payload de stdin de los hooks de Claude Code:
  verificar con la documentación oficial o experimentando. El schema se hace
  tolerante (campos extra se ignoran, campos faltantes tienen defaults).
- **Q6** — `PreToolUse` hook response format para approve/deny: investigar si
  el bridge puede responder allow/deny directamente. Si es viable, habilitar
  approve físico desde la cabeza en Fase 1B.
- **Q7** — ¿El MCP SDK soporta resources con parámetros dinámicos
  (`state/current?include=sessions`)? Si no, resources fijos sin filtro.
