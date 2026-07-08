# SPEC — Fase 1: Bridge foundation + link BLE

Spec de implementación de la Fase 1 del [ROADMAP](ROADMAP.md). Las decisiones
arquitectónicas grandes viven en [DECISIONS.md](DECISIONS.md) (se referencian como
D*n*); las decisiones nuevas de esta spec se numeran **S1.*n*** y si alguna crece
en importancia se promueve a DECISIONS.md.

Estado: **borrador aprobable** — lista para arrancar M0 cuando se apruebe.

---

## 1. Objetivo y criterio de done

Bridge Node/TS con la arquitectura definitiva (bus + Attention Manager + state
machine + config + recorder + dashboard), hablando con el StackChan por BLE con
protocolo confiable (seq/ack + heartbeat + state_sync).

**Done** = los 6 tests end-to-end del ROADMAP pasan:

| # | Test | Parte |
|---|---|---|
| 1 | Simulation: dashboard muestra flujo completo sin hardware | **1A** |
| 2 | Real: `setFace('HAPPY')` cambia la cara; botón A → evento logueado | 1B |
| 3 | Matar bridge → firmware safe mode → rearrancar → state_sync | 1B |
| 4 | Matar firmware → bridge detecta por heartbeat → reconecta → resync | 1B |
| 5 | Cambiar `config.yaml` → reflejado sin reiniciar | **1A** |
| 6 | `bridge replay events.ndjson` reproduce eventos de un log guardado | **1A** |

## 2. Partición 1A / 1B (S1.1)

El kit no llegó y la Fase 0 no arrancó. D11 (simulation mode) existe exactamente
para esto, así que la fase se parte en dos entregables:

- **Fase 1A — bridge completo en simulación** (sin hardware, arrancable HOY):
  todo el bridge, con el protocolo BLE implementado sobre un transport abstracto
  y ejercitado contra un transport de loopback que simula el firmware (acks,
  latencias, drops). Tests 1, 5, 6 + suite automatizada del protocolo.
- **Fase 1B — link real** (requiere Fase 0 completada): transport BLE real
  (noble), extensión del firmware Moddable (`set_face`, `button_pressed`,
  safe mode D16, acks D23), y los tests 2, 3, 4 con el fierro en la mesa.

Regla: **nada de 1B puede requerir refactor de 1A** — si al tocar hardware hay
que cambiar una interfaz de 1A, es un bug de esta spec y se anota en NOTES.md.

## 3. Stack y tooling (S1.2)

| Qué | Elección | Por qué |
|---|---|---|
| Runtime | Node ≥ 20, ESM | D2 |
| Lenguaje | TypeScript 5, `strict: true` | D2 |
| Package manager | npm (workspaces no — un solo paquete `bridge/`) | cero tooling extra |
| Tests | Vitest | rápido, TS nativo |
| Validación de schemas | Zod (config, Event, mensajes BLE) | una sola herramienta para los 3 contratos |
| YAML | `yaml` | mantenido, sin deps |
| HTTP server | `node:http` nativo | 6 rutas, no justifica framework |
| Dashboard front | HTML estático + vanilla JS + SSE | proyecto personal, cero build de front |
| Logging | pino (JSON) — separado del Event Recorder | el log de app no es el recorder |
| BLE (solo 1B) | `@abandonware/noble` detrás de `Transport` | **riesgo alto, smoke test en M0** (ver Q4) — si falla en macOS moderno, alternativa se evalúa sin tocar el resto |
| Lint/format | Biome | una herramienta, cero config wars |

**Ejecución (S1.5)**:

- **Dev**: `tsx watch src/index.ts` (arranque instantáneo, sin build).
- **Prod**: `tsc` → `dist/`; launchd ejecuta `node dist/index.js` — el daemon no
  depende de tsx ni de ningún tooling de TS en runtime.
- **launchd**: el bridge corre como **LaunchAgent** (sesión de usuario), NO como
  LaunchDaemon. Dos razones: (a) los permisos TCC de Bluetooth necesitan poder
  mostrar el consent dialog, imposible para un daemon de sistema; (b) el acceso a
  Keychain (vía `security(1)`) necesita el keychain del usuario logueado. `RunAtLoad` + `KeepAlive`.

## 4. Estructura de directorios

```
bridge/
  src/
    core/
      events.ts          # Event, Severity, zod schemas (contrato D3)
      bus.ts             # event bus tipado + dedup (D5) + hook recorder
      attention.ts       # Attention Manager
      state-machine.ts   # Event/mood → ResolvedState
      modes.ts           # NORMAL / FOCUS / SLEEP (D4, D9)
    adapters/
      adapter.ts         # interfaz Adapter + health (D21 genérico)
    ble/
      protocol.ts        # framing, seq/ack, heartbeat, state_sync, state_applied
      transport.ts       # interfaz Transport
      transport-sim.ts   # SimTransport: stdout + dashboard (D11)
      transport-loopback.ts  # LoopbackTransport: firmware falso para tests
      transport-noble.ts # 1B — BLE real
    config/
      schema.ts          # zod schema de config.yaml
      loader.ts          # load + validate + hot-reload (D18)
    recorder/
      recorder.ts        # ndjson append-only + rotación (D15)
      replay.ts          # replay de un log contra el bus
    server/
      server.ts          # node:http: /state, /metrics, /events, /health, SSE
      metrics.ts         # registro de métricas (D23, R8)
      public/            # dashboard estático
    platform/
      platform.ts        # interfaz (D2)
      macos.ts           # paths, Keychain vía security(1), launchd (launchd: 1B)
    index.ts             # composición + arranque
    cli.ts               # bridge [--simulate] [--config path] | bridge replay <file>
  test/
    fixtures/            # ndjson de eventos, configs válidas/rotas
  config.example.yaml
  package.json
firmware/                # 1B — mods Moddable sobre stack-chan
```

## 5. Contratos core

```ts
type Severity = 'critical' | 'high' | 'medium' | 'low' | 'ambient';

interface Event {
  schemaVersion: 1;
  id: string;                       // uuid v7 (ordenable por tiempo)
  source: string;                   // adapter interno o 'external:<nombre>' (D26)
  category: string;
  severity: Severity;
  hash: string;                     // dedup (D5)
  timestamp: number;                // epoch ms
  direction?: 'left' | 'right';
  ttlMs?: number;                   // override puntual del TTL por severidad
  payload: Record<string, unknown>;
}

type Emotion =
  | 'NEUTRAL' | 'HAPPY' | 'SAD' | 'ANGRY'
  | 'SLEEPY' | 'DOUBTFUL' | 'COLD' | 'HOT';   // las 8 de stack-chan (D1)

interface ResolvedState {
  emotion: Emotion;
  decorators: string[];             // 'heart' | 'sweat' | 'tear' | 'zzz' | 'angry_mark'
  gaze?: 'left' | 'right' | 'center';
  leds: LedCommand[];               // fila/índice, color, patrón
  sound?: string;
  servo?: { yaw?: number; pitch?: number };
  balloon?: string;                 // speech balloon (texto corto)
}

type AdapterHealth = 'HEALTHY' | 'DEGRADED' | 'BROKEN';   // D21

interface Adapter {
  readonly name: string;
  start(bus: EventBus): Promise<void>;
  stop(): Promise<void>;
  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string };
}
```

En Fase 1 no hay adapters reales: hay un **`DemoAdapter`** (emite eventos
sintéticos configurables, para el test 1) y la fuente `external:*` vía
`POST /events`. El primero real es `ClaudeAdapter` en Fase 2.

## 6. Event bus + dedup (D5)

Pipeline síncrono y determinístico por evento:

```
publish(e) → validar (zod) → dedup → recorder → Attention Manager
```

- **Dedup**: ventana default 60s por `hash` (config). Repetición dentro de la
  ventana incrementa `count` y NO re-emite, salvo cambio de severidad. Tras
  N repeticiones (default 10) el hash se auto-mutea hasta que la ventana expire.
- Evento inválido: se loguea `parser_errors_total`++, línea `incident` al
  recorder, no crashea nada.

## 7. Attention Manager

Cola priorizada: orden por (severidad desc, timestamp asc).

- **TTL**: tabla por severidad (config, ver §10) + **`ttlOverrides`** por
  source+category — así se expresa "permission de Claude: TTL infinito" sin
  hacks. `Event.ttlMs` puntual gana sobre todo.
  **Semántica de `infinite`**: `parseDuration('infinite')` produce `null`
  internamente. El AM trata `ttl === null` como "sin expiración por tiempo —
  solo se resuelve por acción explícita (approve/deny, dismiss por touch) o
  por ser reemplazado por evento de mayor severidad". No confundir con `0`
  (que sería "expira inmediatamente").
- **Replacement** (config): `higher_severity_interrupts` (default) — mayor
  severidad interrumpe al activo (que vuelve a la cola si le queda TTL);
  misma o menor severidad encola.
- **Cambio de modo** (D4/D9): al entrar a FOCUS se descartan medium/low/ambient
  encolados; a SLEEP, todo salvo critical. Cada descarte emite `am_decision`.
- **Cola llena** (`maxQueueSize`, default 20): se descarta el evento de menor
  severidad más viejo, con `am_decision: {action: 'dropped', reason: 'queue_full'}`.
- **Idle**: cola vacía + `transitionToBackgroundMoodDelay` (default 2s) →
  background mood. En Fase 1 el mood es NEUTRAL fijo (con motions vivos del
  firmware); el Metabolic State lo reemplaza en Fase 4 sin cambiar esta interfaz.
- Toda decisión (chose / interrupted / expired / dropped / requeued) va al
  recorder como línea `am_decision`.

**Watchdog (S1.3 — precisión sobre DECISIONS)**: el fallback "AM sin emitir en
5s → NEUTRAL/SLEEPY" se implementa como watchdog de **liveness del tick loop**
(tick cada 1s para expirar TTLs), no de emisiones — el AM legítimamente no emite
nada si no hay cambios. Si el tick no corre en 5s o lanza excepción repetida, la
state machine fuerza estado seguro y escribe línea `incident`.

## 8. State machine

Mapea `ActiveAttention | BackgroundMood → ResolvedState` usando **solo config**
(D3: nada de "Chrome→ANGRY" cableado):

- Reglas `match: {source?, category?, severity?}` → `{emotion, decorators, leds,
  sound, servo, balloon}`. Primera regla que matchea gana; hay defaults por
  severidad como red de seguridad.
- Emite al transport **solo en cambio real de estado** (diff), marcando
  `bridge_ts` para la medición e2e (D23).
- Alimenta `face_changes_per_minute` y `time_in_critical_state_per_hour` (R8).

## 9. Protocolo BLE (D7) — spec de mensajes

JSON line-delimited sobre Nordic UART (UUIDs según REFERENCE.md, a confirmar y
anotar en NOTES.md durante Fase 0). Envelope común:

```jsonc
{ "v": 1, "seq": 42, "t": "state", "ts": 1751700000000, "p": { /* payload */ } }
```

| `t` | Dirección | Payload | Ejemplo (envelope + `p` abreviado) | Notas |
|---|---|---|---|---|
| `hello` | ambos | `{role, fw_version?, bridge_version?, ts}` | `{"v":1,"seq":1,"t":"hello","ts":1751700000000,"p":{"role":"bridge","bridge_version":"0.1.0","ts":1751700000000}}` | handshake; establece el mapeo de relojes (ver abajo) |
| `state` | bridge→fw | `ResolvedState` | `{"v":1,"seq":42,"t":"state","ts":...,"p":{"emotion":"DOUBTFUL","decorators":[],"leds":[{"row":"left","color":"amber","pattern":"solid"}],"servo":{"pitch":10}}}` | requiere `ack` |
| `ack` | fw→bridge | `{ack_seq}` | `{"v":1,"seq":8,"t":"ack","ts":...,"p":{"ack_seq":42}}` | retry 1 vez a los 500 ms; segundo miss → contador + reconexión |
| `state_applied` | fw→bridge | `{ack_seq, bridge_ts, fw_applied_ts}` | `{"v":1,"seq":9,"t":"state_applied","ts":...,"p":{"ack_seq":42,"bridge_ts":1751700000000,"fw_applied_ts":52341}}` | tras el frame renderizado → latencia e2e (D23) |
| `hb` | ambos | `{}` | `{"v":1,"seq":100,"t":"hb","ts":...,"p":{}}` | cada 5s; 3 misses (15s) = link muerto — calza con el safe mode del firmware (D16) |
| `state_sync` | bridge→fw | `ResolvedState` completo | igual que `state`, pero se emite siempre al (re)conectar aunque no haya cambio | siempre al (re)conectar, nunca incremental (D7) |
| `event` | fw→bridge | `{kind: 'button'\|'touch', detail}` | `{"v":1,"seq":11,"t":"event","ts":...,"p":{"kind":"button","detail":{"button":"A","action":"press"}}}` | botones y touch entran al bus como eventos `source: 'stackchan'` |

- **Mapeo de relojes (para la latencia e2e de D23)**: no se asume que el
  firmware tenga hora de pared — su `ts` es el reloj monotónico del ESP32
  (millis desde boot). En el `hello`, el bridge calcula
  `offset = fw_ts - bridge_ts - (rtt / 2)` y lo guarda para la conexión;
  cada `state_applied` se corrige con ese offset antes de alimentar
  `state_latency_ms`. El offset se refresca con un `hello` renovado cada 10 min
  (deriva de relojes) y siempre al reconectar. Vive en `protocol.ts`
  (`estimateClockOffset()`).
- **Fallo del `hello`**: si el firmware no responde a `hello` en los primeros
  **2s** tras conectar, se asume `clockOffset = 0`, se loguea warning con
  `handshake_failures_total`++ y la conexión se mantiene operativa. El
  dashboard marca `state_latency_ms` como inexacto hasta el próximo `hello`
  exitoso; el bridge reintenta `hello` cada 30s. Nunca se rechaza la
  conexión por falla de handshake: mejor un buddy que reacciona sin
  instrumentar latencia que uno silencioso.
- **Reconexión**: automática con backoff 1s → 2s → 4s → cap 10s. Budget e2e de
  reconexión + state_sync: < 3s (D23) — se mide, no se asume.
- **`Transport`** (interfaz): `connect() / disconnect() / send(line) /
  onLine(cb) / onStateChange(cb)`. Tres implementaciones (§4). El
  `LoopbackTransport` simula acks con latencia configurable, drops de mensajes
  y muerte del "firmware" — con eso los tests 3 y 4 se automatizan en 1A y en
  1B solo se re-verifican contra el fierro.

## 10. Config (`config.yaml`, D12 + D18)

Gitignored; se versiona `config.example.yaml` (D25). Draft del schema:

```yaml
schemaVersion: 1
mode: NORMAL                  # default al arrancar
server: { host: 127.0.0.1, port: 1780 }   # solo localhost (R6)

attentionManager:
  ttlBySeverity: { critical: 30s, high: 2m, medium: 5m, low: 10m, ambient: 30s }
  ttlOverrides:
    - { source: claude, category: permission, ttl: infinite }
  maxQueueSize: 20
  replacementPolicy: higher_severity_interrupts
  transitionToBackgroundMoodDelay: 2s
  onModeChange: { toFOCUS: drop_below_high, toSLEEP: drop_below_critical }

dedup: { windowSeconds: 60, autoMuteAfter: 10 }

external:                     # D26
  rateLimitPerMinute: 60
  requireToken: true          # token en Keychain; en --simulate: opcional + warning

recorder: { dir: ~/.buildagotchi/events, retentionDays: 30 }

ble:
  heartbeatSeconds: 5
  missesBeforeDead: 3
  reconnectBackoff: { initial: 1s, max: 10s }

stateRules:                   # Event → ResolvedState (D3); primera que matchea gana
  - match: { source: claude, category: permission }
    state: { emotion: DOUBTFUL, servo: { pitch: 10 }, leds: [{ row: left, color: amber, pattern: solid }] }
  - match: { severity: critical }
    state: { emotion: ANGRY, leds: [{ row: right, color: red, pattern: blink }] }
  - match: { severity: ambient }
    state: { emotion: NEUTRAL }
  # ... defaults por severidad

criticalCommands: [rm, sudo, "drop", "force push", "git reset --hard", delete]  # D6 (se usa en Fase 2)
```

**Duraciones (S1.6)**: los valores tipo `30s`, `2m`, `100ms` del YAML se parsean
con un helper `parseDuration()` (string → ms) integrado al schema como
refinement de zod, más el literal `infinite`. Se decide y escribe en M0 — no se
descubre en M2. Internamente todo es `number` en ms.

**Hot-reload (D18)**: `fs.watch` + debounce 100ms → parse → validación zod →
aplicar atómico. Config inválida: se conserva la vigente + warning en dashboard +
`config_reload_failures_total`++. Se mide duración (budget < 200ms, D23).
Nota: si `fs.watch` resulta flaky con editores que reemplazan el archivo por
rename (Neovim, VSCode con atomic save), se cambia a `chokidar` sin discusión —
está aislado en `config/loader.ts`.

## 11. Server local (`127.0.0.1:1780`)

| Ruta | Qué |
|---|---|
| `GET /state` | JSON: estado actual + cola del AM (Fase 1 se queda en JSON para evitar dashboarditis; la UI llega en Fase 2 cuando hay algo real que mostrar) |
| `GET /events` | JSON: últimos N eventos |
| `GET /health` | JSON: health de adapters + salud BLE (estado, reconnects, latencia p50/p95) |
| `GET /stream` | SSE: push en vivo de eventos/estado/health (consumible por scripts y por el dashboard cuando exista) |
| `GET /metrics` | Prometheus text (§13) |
| `POST /events` | D26: valida contra schema Event, fuerza `source` a `external:<nombre>`, auth Bearer (token en Keychain vía `security(1)`), rate limit global |
| `GET /health` | liveness del propio bridge |

**Bootstrap del token (S1.7)**: `bridge init` genera el token (random 32 bytes,
base64url), lo guarda en Keychain vía `security(1)` y lo **imprime una sola vez** con
el ejemplo de `curl` listo para copiar. Si ya existe, `bridge init` no lo pisa
(`--rotate` para regenerar). El bridge nunca lo loguea ni lo expone por HTTP.

**MCP server**: **no en Fase 1**. En esta fase solo existe `POST /events` como
superficie externa. El MCP server del bridge (tools `notify()`, `set_face()`,
etc.) se añade en Fase 2 — ver ROADMAP. La asimetría de auth entre HTTP (token
requerido) y MCP (`notify()` open en localhost) se resuelve entonces (S1.4).

**S1.4 — auth de `POST /events`**: Fase 1 sigue D26 literal (token requerido).
Nota abierta: D26 tiene una asimetría (HTTP con token pero MCP `notify()` open
en localhost) — se resuelve en Fase 2 cuando exista el MCP server, acá no se
inventa nada.

## 12. Event Recorder + replay (D15)

- Archivo `~/.buildagotchi/events/YYYY-MM-DD.ndjson`, append-only, rotación
  diaria, retención configurable (default 30 días).
- **Tipos de línea** (`line_type`): `event`, `am_decision`, `state_change`,
  `health_change`, `incident`. Cada línea lleva el contexto de D15
  (`metabolicScore` — null en Fase 1 —, `activeMode`, `bleHealthy`,
  `adapterHealth`).
- **Replay**: `bridge replay <file> [--speed N | --instant]` re-inyecta solo las
  líneas `event` al bus, con el recorder marcando `replay: true` (un replay no
  contamina el log del día). Los botones del dashboard usan el mismo mecanismo.

## 13. Métricas canónicas (`/metrics`, D23 + R8)

```
events_total{source,category,severity}        counter
parser_errors_total                           counter
ble_reconnects_total                          counter
heartbeat_misses_total                        counter
adapter_failures_total{adapter}               counter
config_reload_failures_total                  counter
external_events_rejected_total{reason}        counter   # rate limit / auth / schema
state_latency_ms                              histogram # e2e bridge→fw (D23), p50/p95
reconnect_duration_ms                         histogram
config_reload_duration_ms                     histogram
am_queue_size                                 gauge
face_changes_total                            counter   # fuente de verdad
# Los siguientes 3 son rates computados con ventana móvil 60s por el bridge para
# consumo directo del dashboard. Con un Prometheus real, usar rate(*_total[1m]).
face_changes_per_minute                       gauge     # R8: warn > 4 sostenido
time_in_critical_state_ratio                  gauge     # R8: warn > 0.3/hora
unique_sources_per_minute                     gauge     # R8: warn > 3
handshake_failures_total                      counter   # §9 fallo del hello
```

Los tres de R8 disparan alerta amarilla en el dashboard al superar umbral.

Nota sobre las gauges "per_minute": son rates, que en Prometheus canónico serían
`rate(counter[1m])` del lado del server. Como acá el consumidor típico es el
dashboard leyendo `/metrics` directo (sin Prometheus server), el bridge expone
**ambas**: el counter (fuente de verdad, para quien sí conecte Prometheus) y la
gauge computada con ventana móvil de 60s (lo que consume el dashboard).

## 14. Ciclo de vida del proceso (S1.8)

launchd manda `SIGTERM` al parar el agente. Sin manejo explícito se pierde la
última línea del recorder (buffer sin flush), queda una conexión BLE zombi y
se corrompe la percepción de salud al siguiente arranque. No es opcional para
un daemon:

```
SIGTERM/SIGINT →
  1. dejar de aceptar eventos (bus en drain)
  2. transport: enviar último estado NEUTRAL? NO — el firmware detecta el corte
     por heartbeat y entra a safe mode solo (D16); no inventamos un "goodbye"
  3. flush del Event Recorder (línea `incident: shutdown` incluida)
  4. cerrar transport y server
  5. exit(0) — con timeout duro de 3s: si algo cuelga, exit(1) igual
```

Se implementa en M1 junto con el Recorder (es su principal beneficiario) y se
testea: matar el proceso con eventos en vuelo → el ndjson termina en línea
completa y parseable, nunca truncada.

## 15. Testing

- **Unit**: AM (TTL, overrides, replacement, drops por modo, cola llena,
  watchdog), dedup/auto-mute, validación de config (fixtures válidas y rotas),
  framing del protocolo (seq/ack, retry, heartbeat, skew), reglas de state
  machine, rotación del recorder.
- **Integración (LoopbackTransport)**: evento → `state` → `ack` →
  `state_applied` → latencia registrada; caída del "firmware" → detección por
  heartbeat → reconexión → `state_sync`; drops de mensajes → retry → contador.
- **E2E manual**: checklist de §1 — tests 1, 5, 6 al cerrar 1A; 2, 3, 4 al
  cerrar 1B (resultados anotados en NOTES.md).

## 16. Plan de trabajo — milestones

Cada milestone termina en verde (tests + algo demostrable). El detalle bite-sized
(pasos de 2-5 min, TDD) se escribe al arrancar cada milestone, como manda el
ROADMAP.

| M | Entregable | Depende de |
|---|---|---|
| **M0** | Scaffolding: `bridge/` con TS estricto, Vitest, Biome, `.gitignore` reforzado (config.yaml, *.ndjson, .env), CLI esqueleto `--simulate`, `parseDuration()` (S1.6). **Aparte, en la Mac física: smoke test de noble (Q4)** | — |
| **M1** | Contratos core (`events.ts` + zod) + bus + dedup + Recorder con rotación + graceful shutdown (S1.8). Demo: publicar evento a mano → línea ndjson correcta; kill −TERM → ndjson sin línea truncada | M0 |
| **M2** | Config: schema + loader + hot-reload con validación. Demo: editar yaml → cambio aplicado < 200ms | M1 |
| **M3** | Attention Manager completo (TTL, replacement, modos, watchdog) + state machine con `stateRules`. Demo: secuencia del ejemplo de DECISIONS (reunión→exception→permission) resuelta correctamente en simulación | M2 |
| **M4** | Server: dashboard + SSE + `/metrics` + `POST /events` (auth + rate limit) + replay CLI y botones. **Cierra tests 1, 5, 6** | M3 |
| **M5** | Protocolo BLE sobre `Transport` + LoopbackTransport + instrumentación de latencias. Suite de integración de §14 verde. **Cierra Fase 1A** | M3 (paralelizable con M4) |
| **M6** | **1B** — `transport-noble` real + firmware: handler `set_face`/`button_pressed`, acks, safe mode (D16). **Cierra tests 2, 3, 4 y la Fase 1** | M5 + Fase 0 |

Camino crítico sin hardware: M0 → M1 → M2 → M3 → {M4, M5}. M6 queda gateado por
la llegada del kit y la Fase 0.

## 17. Decisiones de esta spec (resumen S1.*)

- **S1.1** — Fase partida en 1A (simulación, arrancable ya) / 1B (hardware).
- **S1.2** — Stack: npm + Vitest + Zod + `node:http` + pino + Biome; dashboard
  sin framework; noble solo en 1B detrás de `Transport`.
- **S1.3** — Watchdog del AM = liveness del tick loop, no ausencia de emisiones.
- **S1.4** — `POST /events` con token desde el día 1 (D26 literal); la asimetría
  con MCP `notify()` se resuelve en Fase 2.
- **S1.5** — Ejecución: `tsx` en dev; `tsc` → `dist/` en prod; el bridge corre
  como **LaunchAgent** de usuario (TCC de Bluetooth + Keychain), no LaunchDaemon.
- **S1.6** — Duraciones del YAML (`30s`, `2m`, `infinite`) → `parseDuration()`
  como refinement de zod; internamente todo en ms.
- **S1.7** — Token de `/events` se genera con `bridge init` (imprime una vez,
  guarda en Keychain, `--rotate` para regenerar).
- **S1.8** — Graceful shutdown obligatorio (SIGTERM de launchd): drain → flush
  recorder → cerrar transport/server, timeout duro 3s. Sin mensaje "goodbye" al
  firmware — el safe mode por heartbeat (D16) ya cubre ese caso.

## 18. Cuestiones abiertas (no bloquean M0-M4)

- **Q1**: ¿`@abandonware/noble` funciona en macOS actual (permisos TCC de
  Bluetooth)? **Tratado como riesgo alto, no curiosidad** — ver Q4. Si falla,
  el plan B es un helper nativo Swift/CoreBluetooth hablando con el bridge por
  unix socket; el daño queda contenido en `transport-noble.ts`.
- **Q2**: UUIDs y shape exactos de REFERENCE.md — se confirman en Fase 0
  (sección ya prevista en NOTES.md) y se fijan constantes en `protocol.ts`.
- **Q3**: formato exacto de `LedCommand` — se cierra en 1B al ver qué expone el
  firmware stock. Mientras tanto 1A usa un shape provisional laxo
  `{row: 'left'|'right', index?: number, color: string, pattern: string}` para
  no bloquear; ajustarlo en 1B es un cambio local a `events.ts` + config.
- **Q4**: **smoke test de noble en M0** (en la Mac física, fuera del repo si
  hace falta): script de 20 líneas que escanea advertising BLE. 10 minutos que
  evitan descubrir en M6 que hay que reingeniar el transport. Resultado se
  anota en NOTES.md.
