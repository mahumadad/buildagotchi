# DECISIONS — buildagotchi

Registro de decisiones arquitectónicas del proyecto. Actualizar cuando una decisión
cambie; no borrar las rechazadas (evita re-litigar).

Última actualización: 2026-07-06 (council: D19 reescrito, D21 ajustado, A1 cerrada)

---

## Principios de diseño (arriba de todas las decisiones)

Estos principios ganan cuando entran en conflicto con una decisión puntual. Si
una decisión los viola, la decisión está mal — no los principios.

- **Calm Tech**. buildagotchi opera en la periferia de la atención (Mark Weiser,
  Xerox PARC). Informa sin demandar foco. Cada feature nueva debe pasar el
  filtro "¿esto opera en periferia, o interrumpe?". TTS ruidoso cada 5 min
  falla el filtro; un micro-movimiento de servos cuando cambia estado lo pasa.
- **Espejo determinista, no simulador**. El buddy refleja realidad presente
  derivada de eventos verificables. No hay estado emocional acumulado ficticio
  (`hunger`, `resentment`, `xp`). Transiciones limpias: evento → estado. Sin
  "OK pero triste porque antes falló". Violar esto rompe D22 (trust checks).
- **Mecanismo, no política**. El bridge es un pipeline agnóstico al significado.
  Eventos entran, `stateRules` los interpreta, la cara reacciona. Políticas
  alternativas (tamagotchi de repos, coach de foco, whatever) viven en forks
  o en adapters de terceros — no como flags oficiales del bridge. YAGNI aplica.
- **Presencia física por interpolación, no por variables**. La sensación de
  estar vivo viene de la física del movimiento (breathing, saccades, morphing
  entre expresiones), no de contadores simulados en memoria. Ver D27.
- **Agnóstico al display**. StackChan (M5Stack CoreS3) es el primer target,
  no el único. El bridge (event bus + Attention Manager + `stateRules` + MCP)
  es hardware-agnostic por diseño; el firmware es intercambiable. Hoy StackChan
  vía BLE; mañana podría ser una pantalla OLED en Pi, una app móvil, o un
  wearable. **Corolario operativo**: no abstraer preventivamente. Cuando exista
  el segundo target, factorizamos. Antes, YAGNI.

---

## Concepto

StackChan (kit M5Stack CoreS3 / K151) como **desktop buddy** con dos roles:

1. **Dev**: cara física del estado de mi trabajo — Claude Code, código, CI, Chrome, Jira.
2. **Ambient**: asistente de escritorio — buscador multi-LLM por voz, calendario, foco.

El diferencial (nadie lo hizo, ver investigación): multi-LLM por voz con roles
distintos + notificaciones de dev heterogéneas + ambient, todo en un buddy físico.

---

## Arquitectura

```
StackChan (firmware Moddable, ESP32-S3)
      ↕  BLE — Nordic UART, JSON line-delimited, seq/ack + heartbeat + state_sync
   Bridge (daemon Node/TS en la Mac)  ← launchd lo mantiene vivo
      ├─ Event bus + adapter pattern (cada fuente = adapter aislado)
      ├─ Attention Manager (arbitra prioridad, TTL, expiración, reemplazo de eventos concurrentes)
      ├─ State machine → resuelve a {emoción, prioridad, dirección, LEDs, sonido} y lo manda al firmware
      ├─ Metabolic State engine (background mood cuando no hay evento activo, con decay temporal)
      ├─ Event Recorder (ndjson append-only, incluye score + mode + BLE health por línea)
      ├─ Simulation mode (correr sin hardware para dev en paralelo)
      ├─ Dashboard local (localhost:port): estado + breakdown de load + health de adapters + replay
      ├─ /metrics endpoint (Prometheus-text: eventos/min, BLE reconnects, heartbeat misses, ...)
      ├─ Config declarativa (config.yaml) + hot-reload
      └─ Memory local (dedup por event_hash + last_seen + count)
      ↕
   Adapters (cada uno con health status HEALTHY/DEGRADED/BROKEN):
   ├─ ClaudeAdapter (hooks oficiales + one-shot transcript reads; multi-instancia por session_id — D19)
   ├─ ChromeAdapter (CDP, plugin reemplazable)
   ├─ MCPAdapter (MCP server para que Claude Code lo consuma)
   ├─ LLMAdapter (OpenAI, Gemini)
   ├─ CalendarAdapter (Google + Atlassian)
   ├─ JiraAdapter
   └─ Watchers locales (tests, tsc, dev server, deploys)
```

**Attention Manager** es el nuevo primer ciudadano. Ejemplo del problema que resuelve:
`reunión en 5 min → exception Chrome → permission Claude → reunión empieza`.
¿Qué evento gana? ¿Quién expira al anterior? ¿Quién libera la cara al terminar? El
Attention Manager mantiene una cola priorizada con TTL por evento, política de
reemplazo (mayor severidad interrumpe, misma severidad encola), y transición a
"background mood" (Metabolic State) cuando la cola queda vacía.

**Políticas configurables en `config.yaml`:**

```yaml
attentionManager:
  ttlBySeverity:              # cuánto vive un evento sin resolución explícita
    critical: 30s             # permission: TTL infinito (override específico)
    high: 2m
    medium: 5m
    low: 10m
    ambient: 30s
  maxQueueSize: 20            # evita memory leak si Chrome entra en tormenta
  replacementPolicy: higher_severity_interrupts   # o always_enqueue
  transitionToBackgroundMoodDelay: 2s             # gap antes de pasar a mood
  onModeChange:               # qué hacer con eventos en cola cuando cambia el modo
    toFOCUS: drop_below_high  # descarta medium/low/ambient
    toSLEEP: drop_below_critical
```

**Cuando cambia el modo activo** (D9 NORMAL/FOCUS/SLEEP), los eventos en cola se
filtran según la política. Un evento MEDIUM en cola cuando entrás en FOCUS: se
descarta, no se acumula silencioso para reaparecer al salir.

**Casos borde específicos:**
- **Adapter BROKEN + evento critical del mismo adapter en curso**: el critical
  gana. El "Claude cambió" (D21) se degrada a decorator "?" discreto en vez de
  ocupar la cara entera. La honestidad no puede pisar la urgencia.
- **Dos permissions pending de distintas sesiones (D19 multi-instancia)**: se
  encolan por orden de llegada. Speech balloon muestra "N pendientes • proyecto-X"
  del que está al frente; swipe fwd/bwd navega entre ellos antes de aprobar.
- **AM en fallback**: si el AM no emite estado en 5s (bug, deadlock), la state
  machine transiciona a NEUTRAL/SLEEPY seguro y loguea el incidente. Nunca queda
  mostrando estado obsoleto.

**Trazabilidad**: el Event Recorder (D15) captura decisiones del AM
(`am_decision: {chose, interrupted, expired, reason}`) para poder responder
después "¿por qué la cara hizo X en este momento?".

**El firmware no recibe 50 tipos de mensajes.** El bridge resuelve todo el ruido
externo a un estado (emoción + prioridad + dirección + decorators + LEDs) y lo pushea
al firmware. Toda la complejidad vive del lado Mac.

---

## Decisiones cerradas

### D1 — Firmware: Moddable (`stack-chan/`), target `m5stackchan_cores3`

- **Lenguaje**: TypeScript/JS sobre ModdableSDK (runtime XS). Cero C++ escrito por
  nosotros; el C/C++ (XS, ESP-IDF, drivers nativos) queda bajo el capó como en Node.
- **Evidencia CoreS3 nativo**: `stack-chan/firmware/stackchan/manifest_m5stackchan_cores3.json`
  y `manifest.json:118-168` (config dynamixel + pines UART CoreS3). `bundle.devices`
  incluye `com.m5stack.cores3`.
- **Por qué Moddable y no un fork C++**: los buddies existentes (Anthropic upstream,
  esp32, s3, y TaoXieSZ) **no tienen sistema de caras** — son reproductores de GIF con
  7 tags fijos. TaoXieSZ lo dice explícito: *"Avatar lib intentionally dropped from
  MVP"* (`platformio.ini:290`). Queremos caras ricas → no había nada rico que reutilizar
  en C++. Moddable tiene la cara más expresiva (8 emociones, blink/breath/saccade, gaze
  XY por ojo, 5 decorators, speech balloon) y es JS end-to-end con el bridge.

- **`pulse`** (2026-07-10): decidido implementarlo de verdad como
  `NeoStrandEffect` propio, no mapearlo a un `blink` lento. Vive en
  `firmware/mods/led-pulse.ts` — no en `stack-chan/`, que es un clon del upstream
  sin rastrear. No requiere fork: `setScheme`/`start` son públicos. **No se ha
  encendido nunca**; `pulse` sigue fuera del enum del bridge hasta que se vea en
  un CoreS3. Ver D-03 en `DEBT.md`.

### D2 — Bridge: Node + TypeScript, diseñado portable, MVP ship Mac

- Familiar para el usuario, MCP SDK oficial en TS, librerías BLE/CDP maduras, ecosistema
  npm rico para adapters (SDKs oficiales Anthropic/OpenAI/Google).
- **Arquitectura**: adapter pattern con event bus. Cada fuente (Claude, Chrome, Jira,
  Calendar…) es un módulo aislado que emite `Event` normalizado; la state machine
  central los consume.
- **Portabilidad — postura pragmática**:
  - **Diseño**: los puntos OS-específicos se aíslan detrás de una capa `platform/`
    (disciplina barata que evita cablear macOS-ismos por todo el bridge).
  - **MVP ship**: solo macOS. No prometemos Linux/Windows en el MVP.
  - **Ampliación post-MVP**: si el proyecto se usa y hay demanda, empaquetar para
    Linux/Windows es una fase separada — la capa `platform/` la hace mecánica.
  - Puntos que la capa cubrirá: servicio de auto-arranque (launchd/systemd/Task
    Scheduler), credential storage (Keychain vía `security(1)` en macOS; equivalente por OS), paths de
    Chrome y `~/.claude`, comandos para relanzar Chrome.
- **NO Rust**: BLE/MCP/CDP/LLM SDKs menos maduros en Rust; curva de aprendizaje enorme
  vs valor real para el volumen de eventos esperado (decenas/minuto, no miles/seg).
  Reconsiderar solo con evidencia de bottleneck.

### D3 — Modelo de eventos normalizado

Todos los adapters emiten al bus un mismo shape:

```ts
interface Event {
  schemaVersion: number;   // versionado del contrato (D26) — hoy: 1
  id: string;              // uuid
  source: string;          // 'claude' | 'chrome' | 'jira' | 'github' | 'calendar' | ...
  category: string;        // 'permission' | 'error' | 'notif' | 'milestone' | ...
  severity: Severity;      // ver D4
  hash: string;            // para dedup (source + category + payload determinístico)
  timestamp: number;
  direction?: 'left' | 'right';   // hint para servos/LEDs
  payload: object;
}
```

La state machine mapea `Event → {emoción, decorator, LEDs, sonido, servo}`. NO se
cablea "Chrome→ANGRY" en el adapter — eso vive en config declarativa.

### D4 — Motor de prioridades

Cinco niveles con reglas por fuente (configurables):

- **critical**: interrumpe todo (permission de Claude Code, exception Chrome, deploy failed)
- **high**: notifica activo (CI rojo, PR bloqueado, reunión en 5 min)
- **medium**: notifica pasivo (ticket asignado, PR review pendiente)
- **low**: cola sin interrumpir (mentions no urgentes, warnings)
- **ambient**: puramente visual (heartbeat de sesión, pomodoro, breath)

Modo activo del sistema (NORMAL/FOCUS/SLEEP) define el umbral: en FOCUS solo pasan
`critical` y `high`; en SLEEP solo `critical`.

### D5 — Dedup y memoria local

Cada evento tiene `hash`. El bridge mantiene:

```ts
{ hash: string, first_seen: ts, last_seen: ts, count: number, muted: boolean }
```

Repetición del mismo evento en ventana corta = incrementa count, no re-emite estado
salvo cambio de severidad. Después de N repeticiones muteable auto.

### D6 — Seguridad del canal de aprobación

- **Permisos non-critical de Claude**: click único = approve, swipe back = deny.
- **Permisos críticos** (heurística: comando destructivo, `rm`, `sudo`, drop, force
  push, delete, git reset --hard, etc. — lista en config): **exige hold 2s** o
  **doble toque**. Un roce accidental NO aprueba.
- Feedback visual explícito: cara + LED cambia mientras se sostiene para confirmar.

### D7 — Protocolo StackChan ↔ bridge: Nordic UART, JSON line-delimited, con seq/ack + heartbeat

- **Spec de referencia**: `claude-desktop-buddy/REFERENCE.md` (UUID `6e400001-…`).
- **Extendida** con:
  - `seq` por mensaje, `ack` en la respuesta → detectar pérdidas.
  - Heartbeat cada 5-10s desde ambos lados → detectar link muerto rápido.
  - `state_sync` explícito: al reconectar, bridge push del estado completo actual (no
    incremental) para evitar estados zombis.
- Se reimplementa en Moddable (carpeta `firmware/stackchan/ble/`).

### D8 — Chrome: perfil dedicado + `--remote-debugging-port=9222` vía launchd

- CDP escucha eventos con DevTools **cerrado**. Chrome de dev con `--user-data-dir`
  separado, `.app` wrapper con ícono distinto. launchd lo levanta al login.
- Buffer circular en el bridge + `Network.getResponseBody` automático para 4xx/5xx.
- `ChromeAdapter` diseñado como reemplazable: si Google endurece el flag, se puede
  cambiar de estrategia (extension MV3) sin tocar el resto del bridge.

### D9 — Scope

- **Dev**: sesiones Claude Code, tokens (5h/semanal), estado de tasks/council, GitHub
  (PRs/CI/mentions), deploys, dev server local, Chrome DevTools, Jira.
- **Ambient**: buscador voz (Fase 5: solo Claude; multi-LLM después), Google +
  Atlassian Calendar, Pomodoro, break reminders.
- **Costos**: solo Claude por ahora.
- **Tickets**: solo Jira.

### D10 — Interacción: mic PTT primero, wake word después

- Push-to-talk vía botón B evita correr un modelo de wake word on-device al inicio.

### D11 — Modo simulation y dashboard del bridge desde Fase 1

- El bridge corre con `--simulate`: expone las mismas APIs pero sin BLE real; imprime
  a stdout / dashboard qué habría mandado al firmware.
- Permite desarrollo mientras la Fase 0 (hardware/toolchain) esté pendiente.
- Dashboard local (`localhost:1780` o similar): estado actual, últimos eventos,
  buffer Chrome, cola de notifs, salud del BLE.

### D12 — Config declarativa

Un `config.yaml` en el bridge:

- Umbrales por fuente (dedup window, severidad por defecto).
- Mapeos `Event → estado` (emoción, LEDs, sonido, servo).
- Asignación direccional configurable (default: izq=trabajo, der=código — pero
  cambiable).
- Lista de comandos considerados "críticos" para aprobación.
- Modo activo default, horarios de auto-DND.

### D15 — Event Recorder + Replay (desde Fase 1)

Log append-only ndjson con todos los eventos que pasan por el bus. No es feature de
usuario — es infraestructura que habilita mucho a bajo costo:

- **Debugging**: `bridge replay events.ndjson` reproduce un día entero de eventos
  contra la state machine actual. Oro para depurar bugs emocionales raros.
- **Daily review** (backlog, pero el log ya está): "hoy tuviste 12 interrupciones,
  8 approvals, 4 errores críticos, 2 reuniones".
- **Métricas históricas** (backlog): interrupciones/día, permisos aprobados, tiempo
  en FOCUS, distribución horaria.
- **Rotación**: por día. Retención configurable (default 30 días).

**Cada línea incluye contexto suficiente para análisis posterior**:

```jsonc
{
  "id": "...",
  "source": "claude",
  "category": "permission",
  "severity": "critical",
  "hash": "...",
  "ts": 1234567890,
  "payload": { /* ... */ },
  // Contexto en el momento del evento (para daily review sin re-simular):
  "metabolicScoreScore": 47,
  "activeMode": "FOCUS",
  "bleHealthy": true,
  "adapterHealth": "HEALTHY"
}
```

### D16 — Firmware safe mode al perder heartbeat

Si el firmware no recibe heartbeat en 15s, transiciona a cara SLEEPY o "X_X" +
LEDs muy tenues. Sin esto, si el bridge muere el StackChan sigue mintiendo con la
última cara.

Al recuperar heartbeat: `state_sync` completo (ver D7), vuelve al estado real.

### D17 — Error budget por adapter

Cada adapter tiene un límite configurable de eventos "emocionales" por unidad de
tiempo (ej: `chrome.max_emotional_events_per_minute: 3`). Superado el budget, los
eventos siguen llegando al log (D15) pero no disparan reacciones en la cara — se
convierten en contador silencioso.

Evita que el buddy parezca "permanentemente estresado" cuando una fuente ruidosa
(típicamente Chrome) tiene una tormenta.

### D18 — Config hot-reload

`config.yaml` se recarga sin reiniciar el daemon. Tunear umbrales, pesos de
Metabolic State, mapeos, prioridades — todo iterativo. Un endpoint del dashboard
(o watcher de archivo) dispara la recarga. Validación de schema antes de aplicar.

### D19 — ClaudeAdapter: hooks oficiales + lectura one-shot (council 2026-07-06)

**Decidido por council** con evidencia del ecosistema (ComandOS, ccboard,
claude-push usan hooks; claude-session-dashboard/ccusage tailean y se rompen
con cada cambio de formato).

**Fuente primaria: hooks oficiales de Claude Code** (`settings.json`). Son la
API publicada de eventos — entregan `hook_event_name`, `session_id`, `cwd` y
`transcript_path` por stdin. Eventos que consumimos: `SessionStart`,
`UserPromptSubmit`, `Stop`, `Notification` (permission/idle), `SessionEnd`.
El hook es un script mínimo que postea al bridge por `POST /events` (D26 —
el ClaudeAdapter reusa la superficie externa; casi no hay código nuevo).

**Enriquecimiento: lectura one-shot del transcript** que el propio hook
entrega (`transcript_path`), disparada por el hook — nunca un tailer
continuo. Patrón ComandOS (`turn_text()`): al llegar `Stop`/`Notification`,
leer el final del JSONL para extraer texto de respuesta, comando del
permiso, tokens del turno. Parsing tolerante (D21) aplica a ESTA lectura.

**Tailing continuo: rechazado** (ver Opciones rechazadas). Todo lo que el
MVP necesita lo dan hooks + one-shot reads + ccusage/API para cuota (patrón
Clawdmeter).

**Reglas del hook script** (no negociables):
- **Nunca bloquea a Claude Code**: `curl -m 2` fire-and-forget, exit 0 siempre.
- **Fallback local**: si el bridge no responde, escribe state file en
  `~/.buildagotchi/claude-state/<session_id>.json` — el bridge los lee al
  arrancar (resync) y así un bridge caído no pierde estado (protege D22).
- `bridge init --hooks` instala/actualiza la config de hooks en
  `settings.json` con diff visible y confirmación (patrón ccboard). `bridge
  doctor` verifica que sigan instalados.

- **Multi-instancia**: tracker por `session_id` (lo da el hook — reemplaza el
  plan anterior de inferir `pid + cwd`). Cada sesión activa es un item en la
  cola; al pedir permiso, la cara muestra de cuál sesión (path corto del
  `cwd`). Aprobar desde la cabeza aplica a esa sesión.
- **Nota a futuro (D6)**: los hooks `PreToolUse` pueden *responder*
  allow/deny — único mecanismo que permitiría aprobar desde la cabeza sin
  keystroke injection. Se explora en Fase 2; el tailing jamás podría
  (read-only).

### D21 — ClaudeAdapter con health status explícito

El peor escenario del ClaudeAdapter no es "no funciona" — es **mentir en silencio**.
Contramedida: el adapter mantiene un estado observable. Con D19 basado en hooks
(council 2026-07-06), las señales de salud son dos:

1. **Salud del canal de hooks** — el silencio no es salud:
   - **HEALTHY**: hooks instalados (verificado en `settings.json`) y al menos
     un evento recibido desde el último `SessionStart` conocido.
   - **DEGRADED**: hay sesiones de Claude Code corriendo (detectables por
     proceso) pero cero hooks en >N min, o `bridge doctor` detecta hooks
     ausentes/pisados en `settings.json` (otra tool pudo sobreescribirlos).
   - **BROKEN**: hooks desinstalados o el script falla repetidamente.
2. **Salud del parsing one-shot** (la lectura del transcript que dispara el
   hook): % de líneas desconocidas en las últimas K lecturas —
   - **HEALTHY** <5%, **DEGRADED** 5-20% (decorator "?" discreto),
   - **BROKEN** >20% o crash repetido → cara DOUBTFUL + balloon **"Claude
     cambió"**. El buddy no pretende saber lo que no sabe. Nota: transcript
     roto degrada el *enriquecimiento* (detalles), no la *detección* (hooks
     siguen entregando estado básico).

Umbrales configurables. Aplica el mismo patrón a otros adapters con contratos
frágiles (ChromeAdapter si Google endurece CDP, etc.).

### D22 — Trust check metric (medida dura de confianza)

Métrica automatizable de "¿le creo a la cara?":

- **Definición**: contar cuántas veces por día el usuario abre/enfoca Claude Code
  (via Accessibility API en macOS) **mientras el buddy está en estado
  NEUTRAL/HAPPY** (nada pendiente según el buddy).
- **Permiso macOS requerido**: ~~`kTCCServiceAccessibility`~~ **ninguno**.
  Corregido el 2026-07-10 al implementarlo: `lsappinfo front` + `lsappinfo info
  -only bundleid` es LaunchServices, API pública, sin TCC y sin diálogo de
  consentimiento. `osascript` sí habría necesitado permiso de Automatización;
  `lsappinfo` no. Esta decisión especificaba —y presupuestaba— un permiso que no
  existe.
- ~~**Si el usuario no lo concede**~~: rama muerta, no hay permiso que conceder.
  `readFrontmostBundleId()` devuelve `null` ante cualquier fallo y se pierde la
  muestra, no el bridge.
- **Filtro anti-falsos-positivos**: solo cuenta si Claude no tenía foco en los 30s
  previos. Re-activaciones rápidas (alt-tab, notif, etc.) no cuentan.
- **Fase burn-in**: los primeros 3 días de uso no cuentan para el Gate 1 (curva de
  aprendizaje del usuario, no del sistema).
- Alta cuenta ⇒ el usuario verifica constantemente ⇒ no confía en la cara.
- Baja cuenta ⇒ confía. Meta MVP (D20): trust_checks/día ≤ 2 en las semanas 2 y 3.
- Se registra en el Event Recorder como evento sintético `category: "trust_check"`,
  escrito **directo** por el adapter: no pasa por el bus ni por el
  AttentionManager. Un evento que el robot atendiera cambiaría la cara que la
  métrica usa como condición.
- **Falso positivo conocido**: las apps se roban el foco solas (Claude Desktop y
  Chrome, medidos). Ver **D-12** en `DEBT.md`. La métrica sesga hacia arriba, o
  sea hacia "el usuario no confía" — el lado inseguro para el Gate 1.

Post-MVP: extender a otras fuentes (revisar Jira, refrescar el mail) para triangular.

### D23 — Latency budget (SLA interno)

Números concretos que definen "se siente responsivo":

| Camino | Presupuesto |
|---|---|
| Evento crítico → cara cambia (permission, exception) — **e2e bridge→firmware→display** | **< 500 ms** |
| BLE reconnect completo (link + state_sync) | **< 3 s** |
| `state_sync` payload emitido tras reconexión | **< 1 s** |
| PTT keyup → primer chunk de STT | **< 400 ms** |
| STT completo → primer chunk de TTS | **< 1.5 s** |
| Config hot-reload (leer + validar + aplicar) | **< 200 ms** |

**Medición end-to-end** (no solo del lado bridge):
- Bridge marca `bridge_ts` al decidir enviar el estado.
- Firmware envía ack `state_applied(bridge_ts, fw_applied_ts)` cuando la cara
  ya cambió (después del frame).
- El bridge calcula `latency = fw_applied_ts - bridge_ts` (con corrección de
  clock skew estimada en el handshake inicial).

Cada latencia se instrumenta y se expone en `/metrics`. Si el p95 supera el
budget, aparece un warning en el dashboard con la métrica ofensora. No se cumple ⇒
optimizamos o revisamos el diseño; nunca "se siente lento" queda anecdótico.

### D20 — MVP y métricas de éxito

**MVP = Fase 2 completa** (Bridge + BLE + ClaudeAdapter + safe mode + event
recorder). Todo lo demás son *nice-to-haves* condicionales.

**Éxito del MVP (criterio go/no-go para seguir con Fase 3+):**
Después de 3 semanas del MVP en uso real (con burn-in de 3 días, ver D22), verificar:

- Uso ≥5 días laborales/semana durante al menos 3 semanas seguidas.
- Aprobé ≥50% de mis permisos desde la cabeza (no la terminal).
- Confío en la cara — no reviso la Mac "por si acaso" cuando ella dice que está
  todo bien.
- Modo FOCUS se usa al menos una vez al día.

**Si no se cumple**: no seguir con fases posteriores hasta entender por qué.
El plan **no** es "hacer todo"; es "hacer Fase 2 y validar".

### D24 — Feature kill criteria (matar subsistemas, no solo el proyecto)

Los gates del ROADMAP dicen cuándo dejar de agregar features. Falta la simétrica:
cuándo **quitar** features que no se usaron. Ejemplos concretos:

| Feature | Criterio de matar (mover a backlog o eliminar) |
|---|---|
| **ChromeAdapter** | < 1 interacción útil/día tras 2 semanas → backlog |
| **Buscador voz (Fase 5)** | < 20% de consultas de dev vía voz tras 2 semanas → backlog |
| **Multi-LLM (5b)** | < 3 preguntas/semana a GPT o Gemini tras 2 semanas → backlog + Council al backlog automático |
| **Modo Council (Fase 7)** | < 1 uso/semana tras 3 semanas → backlog o eliminación |
| **Pomodoro/breaks** | no activados en 2 semanas → deshabilitar por default |

Cada feature grande al mergearse añade su propio kill criterion medible en el
Event Recorder. Sin esto, features muertas siguen consumiendo mantenimiento y
ensuciando el dashboard.

### D25 — Single user first, open source de segunda instancia

**Distinción importante**: no es un producto, pero **sí es código público forkeable
cuando funcione**. La diferencia mata muchos proyectos personales que se hunden
tratando de ser producto o quedan cerrados por comodidad.

**Lo que NO es**:
- No hay soporte a usuarios.
- No hay instaladores, no hay `.app` firmado, no hay CI/CD público.
- No hay proceso de feature requests ni SLA de PRs/issues.
- No hay tests cross-platform reales (aunque el código esté arquitectónicamente
  abierto a Linux/Windows por D2, no se garantiza que corra).
- No hay documentación de instalación para "cualquier persona" — el que forkee
  se las arregla leyendo SETUP.md tal cual está.

**Lo que SÍ es (desde el día 1)**:
- **Repo público en GitHub** — se abrió ya, en fase de docs (adelantado respecto al
  plan original de abrir post-Gate 1; no cambia nada más de esta decisión).
- **Licencia Apache 2.0** (decidido — `LICENSE` ya en el repo).
- **Código legible**: no ofuscado, nombres claros, funciones cortas — el estándar
  normal de "un desarrollador entiende esto".
- **Higiene de secretos desde el día 1**: tokens/keys en Keychain (vía `security(1)`) o
  variables de entorno, nunca en archivos versionados. `config.yaml` gitignored,
  `config.example.yaml` versionado.
- **`.gitignore` robusto** desde Fase 1: logs de eventos, credentials, builds,
  `.env`, dumps del recorder.
- **README neutro y profesional** (actualizado 2026-07-05): presentación
  orientada a que el proyecto se forkee y comparta, sin tono personal. La
  honestidad se mantiene en el contenido (estado WIP, sin soporte, sin SLA,
  best-effort), no en el tono.
- **Commits que otro pueda leer** (el estilo del CLAUDE.md ya lo cubre).

**Consecuencia clave**: el diseño *funcional* asume un usuario, pero el código
está limpio como para que un curioso lo lea, lo copie, lo adapte a su propio
setup, y siga su camino. Diferencia entre "esto es mío" y "esto es mío pero
compartible".

### D26 — External event surface (MCP tools + HTTP endpoint)

El bridge expone una superficie estable para que **cualquier proceso externo**
(otros agentes MCP, scripts shell, cron jobs, webhooks, otros dispositivos)
pueda empujar eventos y accionar hardware. Prácticamente gratis dado el
event bus + Attention Manager, y desbloquea integraciones que no anticipamos.

**Dos capas**:

1. **HTTP endpoint** (`POST /events` en el dashboard) — Fase 1, línea de código:
   ```bash
   curl -X POST localhost:1780/events \
     -d '{"source":"manual","severity":"high","category":"reminder","payload":{"msg":"..."}}'
   ```
   Útil para shell aliases, cron, webhooks de GitHub Actions / Vercel /
   Cloudflare, cualquier cosa que hable HTTP.

2. **MCP server con tools de hardware** — Fase 2+ (extendido en cada fase que
   agregue capacidad):
   - `notify(source, severity, category, msg)` — evento normal por el pipeline
   - `set_face(emotion, ttl)` — cara temporal
   - `speak(text)` — TTS
   - `blink_led(row, color, pattern, duration)`
   - `look_at(direction)` — servos
   - `push_event(...)` — event completo con todos los campos

   Cualquier agente MCP (Claude Code, Cursor, Aider, script custom) los llama.
   Referencia de catálogo: `kisaragi-mochi/stackchan-mcp` (25+ tools).

3. **MCP resources (lectura del estado)** — Fase 2+, **superficie bidireccional**:
   - `mcp://buildagotchi/state/current` → `{ emotion, decorators, metabolicScore,
     mode, activeEvent, queueDepth, ... }`
   - `mcp://buildagotchi/attention/queue` → cola actual del Attention Manager
   - `mcp://buildagotchi/health` → estado de adapters + BLE + bridge
   - `mcp://buildagotchi/history/recent?minutes=N` → últimos eventos del Recorder

   El buddy deja de ser solo actuador y se vuelve **estado compartido del
   ecosistema de agentes**. Un LLM que quiere pedir input puede consultar
   `state/current` antes de decidir si interrumpir ("¿el buddy ya está
   DOUBTFUL por otra cosa? Espero"). Un script de deploy puede consultar
   `attention/queue` para decidir si esperar. Trust check automatizable:
   agente lee `state/current` en vez de que el usuario mire la cara.

   Read-only, sin auth para localhost (información no destructiva).

**Todos los eventos externos caen en el mismo pipeline**: event bus →
Attention Manager → State Machine → firmware. El campo `source` identifica al
emisor para trazabilidad en el Event Recorder (D15) y para aplicar error
budgets diferenciados (D17).

**Salvaguardas**:
- **Auth**: token en Keychain requerido para el endpoint HTTP y las MCP tools
  destructivas (`set_face`, `blink_led`, `speak`). Tools de solo-notif (`notify`,
  `push_event`) pueden ser open en localhost por simplicidad.
- **Rate limit global** además del per-adapter: ceiling total de eventos/min
  desde fuentes externas para prevenir floods (buggy o hostil).
- **Schema versionado** del Event: `schemaVersion: 1` en cada payload; cambios
  incompatibles suben mayor. Consumidores externos pueden depender de una versión.
- **Namespace de source**: `external:<nombre>` (ej: `external:cron`,
  `external:webhook-github`) para distinguirlos de adapters internos y aplicar
  políticas distintas si hace falta.

**Consecuencia**: features futuras se pueden **prototipar sin escribir un
adapter**. Un shell one-liner que hace `curl` alcanza para probar si vale la
pena la integración antes de invertir en un adapter permanente.

### D27 — Vitality layer separada del state layer

La sensación de "estar vivo" del buddy **no viene de datos** — viene de la
física del movimiento. Capa siempre activa, ortogonal al state machine, que
no representa ningún evento:

- **Breathing**: micro-oscilación de servos en idle (ej. ±2° en pitch cada
  4s, patrón sinusoidal con jitter para que no sea mecánico).
- **Saccades / blinking**: ya como decorators — se ejecutan sobre cualquier
  emoción actual sin pisarla.
- **Interpolación física entre estados** (referencia: `ExpressionWeight` de
  `stackchan-display`): al pasar de NEUTRAL a SAD, la cara **morfea** en
  ~300-600ms, no switchea de golpe. Los servos también interpolan.
- **Micro-jitter en LEDs**: si un LED está "solid amber", en realidad
  fluctúa ±3% de brillo cada 500ms. No perfectamente estático.

**Por qué separado del state layer**: si el vitality vive en el mismo lugar
que la resolución de emociones, se contamina — un breathing "irregular" se
lee como estado triste. Debe ser una capa que se **superpone** al estado
resuelto: primero el state machine decide "SAD + rojo sólido", después el
vitality layer aplica breathing + jitter encima.

**Configurable, no eliminable**: `config.yaml` permite bajar la amplitud
del breathing o desactivarlo (modo SLEEP lo hace más lento y sutil), pero
no se apaga completamente en modos activos. Si el buddy se queda 100%
estático, se lee como "colgado", no como "en reposo".

**Consecuencia diferencial**: es lo que separa buildagotchi de una app web
con pixel-art. La app necesita mecánicas adictivas (tamagotchi life) para
que no cierres la pestaña. El hardware físico ya tiene presencia — solo
necesita micro-señales de vida, no dramatismo.

### D28 — Personalidad como preset configurable (default: "compañero silencioso")

Sin personalidad definida, `stateRules` y los mensajes de TTS son arbitrarios.
Con personalidad *fija*, el proyecto pierde adaptabilidad. Solución:
**personalidad = preset de templates + defaults**, seleccionable en
`config.yaml`. No cambia arquitectura — solo strings y algunas emociones default.

**Presets iniciales**:

| Preset | Vibe | Ejemplo TTS (permiso pendiente) | Cara base idle |
|---|---|---|---|
| `companion` (**default**) | Presencia empática, poco parlanchín | *(silencio; cara DOUBTFUL + LED ámbar)* | NEUTRAL cálida |
| `supervisor` | Formal, directo, mínimo | "Autorización requerida" | NEUTRAL firme |
| `critic` | Cuestionador, seco | "¿Estás seguro de eso?" | DOUBTFUL |
| `mascot` | Sin palabras, sonidos y ojos | *(chirp + eyes wide)* | CURIOUS |

**Default = `companion`**: presencia sin invasión, alineado con Calm Tech.
TTS ausente por default en Fase 2-4; solo entra en Fase 5 y para eventos
críticos. Los otros presets existen para adaptación por fork o por gusto.

**Estructura en `config.yaml`**:

```yaml
personality:
  preset: companion            # companion | supervisor | critic | mascot | custom
  ttsEnabled: false            # default off hasta Fase 5
  templates:                   # solo si preset: custom
    permission.pending: "..."
    build.failed: "..."
```

Los presets viven en `presets/personalities/<name>.yaml` en el repo. Cada
uno define: templates de mensajes por categoría de evento, decorators
default por severidad, emoción idle. Un fork puede agregar `presets/goth/`
sin tocar el bridge.

**Qué NO define un preset**: prioridades, dedup, error budgets, mapeo
severity → cola. Esas son políticas del bridge. La personalidad es
**capa de expresión** encima del pipeline decisión.

**Consecuencia**: la pregunta "¿qué es buildagotchi?" tiene una respuesta
del usuario, no del proyecto. El default responde por él si no elige.

### D29 — El balloon del fork de firmware replica el del emulador

El emulador dibuja burbuja redondeada + cola hacia la boca + tema de 2
colores (Feature A, spec 2026-07-11-adopcion-firmware-original rev 2). La
cola no existe en el firmware upstream (`stack-chan`: 9-slice sin cola;
factory: flecha fija). Nuestro fork la implementará con la misma geometría
(`balloon-layout.mjs` es la referencia). Hasta entonces la divergencia vive
en DEBT. Del mismo council: el mod MCP del firmware upstream
(`mods/mcp/mod.js`, `set_emotion`/`say_message` en :8080) queda anotado como
**opción** de canal de debugging cuando llegue el robot — no compromiso.

---

## Mapeo hardware ↔ función (resumen)

Detalle por fase en ROADMAP. Convención base:

- **Cara + decorators**: estado emocional resuelto por la state machine.
- **Servos**: dirigir atención + señas de vida. Izq/der = configurable.
- **12 LEDs** (2 filas de 6): categoría + urgencia + heartbeat.
- **Touch cabeza** (3 zonas): acciones contextuales (approve/deny con guarda D6).
- **4 botones**: acciones globales fijas (A=modelo, B=PTT, C=modo, power=nativo).
- **2 mics MEMS** (24kHz): PTT → WAV → STT.
- **Speaker 1W**: TTS + alertas por prioridad.
- **Touch display 320×240**: alterna cara ↔ dashboard.
- **IMU**: bonus post-MVP.

---

## Riesgos anclados

- **R1 — BLE es el mayor riesgo técnico** (desconexiones, latencia, estados zombis).
  Mitigación: seq/ack + heartbeat + state_sync al reconectar desde Fase 1 (D7).
- **R2 — ESP32-S3 con todo activo simultáneamente** (BLE + audio + servos + LEDs +
  display + touch). Validar en Fase 0 antes de comprometer diseño detallado.
- **R3 — Dependencia de internals de Claude** (`~/.claude/*.jsonl`): aislado en
  `ClaudeAdapter`. Si rompe, el resto sigue funcionando.
- **R4 — CDP endurecido por Google**: `ChromeAdapter` reemplazable (D8).
- **R5 — Rate limits Anthropic**: bridge degrada gracefully — cara "enferma" si el
  API está caído, resto de fuentes sigue.
- **R6 — Seguridad del bridge**: tiene acceso a mucho (Claude sesiones, Chrome,
  Jira, Calendar). Tokens/OAuth en Keychain macOS, no en archivos planos. Sin
  exposición externa (dashboard solo escucha en localhost).
- **R7 — Latencia audio por BLE**: asumido resuelto por diseño — **BLE = comandos
  de estado, WiFi/HTTP = streams de audio**. El ESP32-S3 tiene BLE 5.0 pero su
  ancho de banda real para datos es bajo; audio duplex por BLE tiene latencia
  típicamente inaceptable. Fase 0 confirma; si contradice, ajustar.
- **R8 — Fatiga del usuario**: si el buddy es demasiado hablador/cambiante, pasa de
  útil a molesto. Mitigaciones: error budget por adapter (D17), Metabolic State solo
  pisa la cara en idle emocional (D14), decay temporal (D14), dedup (D5), safe mode
  (D16) evita alarmismo cuando el bridge muere. El tuning fino de umbrales/pesos vive
  en `config.yaml` con hot-reload (D18) para ajustar sin fricción durante uso real.
  **Métricas explícitas de fatiga en `/metrics`**:
  - `face_changes_per_minute`: warning si supera 4/min sostenido.
  - `time_in_critical_state_per_hour`: warning si > 30% de la hora.
  - `unique_sources_per_minute`: warning si > 3 (tormenta probable).
  Cualquiera dispara alerta amarilla en el dashboard para revisar config.

---

### D13 — Modo Council (Fase 7)

Feature dedicada, no backlog. Aprovecha los wrappers multi-LLM de Fase 5b:

- Sobre una tarea/pregunta compleja: Opus trabaja, GPT y Gemini revisan (o al revés,
  según config).
- StackChan muestra **consenso** con emoción compuesta:
  - 🙂 alto (todas coinciden)
  - 😕 desacuerdo parcial
  - 😬 conflicto fuerte
- Detección de consenso: heurística simple al inicio (similarity de embeddings o
  clasificación acuerdo/desacuerdo con un LLM juez). Refinar con evidencia de uso.
- Producto en sí mismo — nadie lo tiene en un buddy físico. Prioridad post-MVP pero
  compromiso, no wishlist.

### D14 — Metabolic State score (Fase 4)

Score agregado **0-100** que resume la carga del momento. Entradas ponderadas
declarativas en `config.yaml`:

- Errores activos (Chrome exceptions cuando se active, CI failures)
- Permisos pendientes de Claude
- Reuniones próximas (ponderadas por urgencia temporal)
- PRs abiertas / esperando review
- Builds rotas
- Tasks activas

**Heurística simple al inicio**, no ML/embeddings — tiene que ser predecible y
depurable. Ejemplo del formato:
`score = crit_errors*10 + pending_perms*5 + meetings_soon*3 + open_prs*1`,
clampeado a 0-100. Pesos afinables desde `config.yaml`.

**Decay temporal por entrada**: cada input tiene half-life configurable. Un error
de las 10am pesa lleno los primeros 10-15 min y va decayendo aunque siga abierto —
evita que un incidente viejo tenga a la cara enojada todo el día. Formato:
`weight * exp(-age_min / half_life_min)`. Half-lives por default: errores 30 min,
permisos ∞ (siempre urgentes), reuniones lineales al tiempo restante, PRs 6h.

**Derivación categórica** (no señal paralela — evita duplicar estado):
- 0-20 → CALM
- 21-40 → FLOW
- 41-60 → SATURATED
- 61-80 → OVERLOADED
- 81-100 → EXHAUSTED

**Metabolismo, no cognición**: la elección del término es deliberada. El
sistema no *piensa* que estás sobrecargado — *se satura* como respuesta
fisiológica a inputs. Esto refuerza que no hay lógica de "vida" ni
resentimiento acumulado (violaría el principio de "espejo determinista"):
inputs actuales → nivel actual, con decay temporal como única memoria.

La cara se vuelve más estresada conforme sube (NEUTRAL → DOUBTFUL → SAD → ANGRY +
sweat decorator + LEDs más intensos). **Solo alimenta la cara cuando el sistema
está idle emocionalmente** — no pisa reacciones concretas (un error de Chrome
sigue disparando ANGRY directo). Es el "background mood".

**Ponderación contextual del tiempo** (afinable en config): un error a las 11am no
pesa lo mismo que a las 23:30 si estás cansado. Multiplicador horario opcional.

**Estado (2026-07-09)**: sigue en Fase 4. El seam ya existe:
`StateMachine.#backgroundMood()` es el único punto que decide la cara cuando no
hay evento activo, y Fase 2.5 lo dejó aislado. Implementar D14 es reemplazar el
`personality.idleEmotion()` fijo por `emotionByState[metabolic.snapshot().state]`.

**Criterio para retomarlo** (S2.5.5): que existan ≥2 fuentes de input
independientes (Fase 3 aporta Calendar y GitHub) **y** que el score salga de
`CALM` en un día de uso real. Hoy, con solo el `ClaudeAdapter`: 2 sesiones
`working` (peso 1) + 1 permiso pendiente (peso 5) = score 7 → `CALM`. Salir de
`CALM` (>20) requiere 4 permisos simultáneos o un `error_active`, y ningún
adapter emite `category: error` todavía. El motor devolvería `CALM` siempre;
solo se movería con `curl`.

---

## Decisiones de Fase 2.5 — expresión y observabilidad (2026-07-09)

Tomadas en [SPEC-FASE-2.5.md](SPEC-FASE-2.5.md), revisadas por el council
(rev. 2, APROBADO CON CAMBIOS). El bug bloqueante (C1) se verificó
empíricamente contra el bridge corriendo antes de rediseñar — ver DEVLOG.

### S2.5.1 — El servidor decide el balloon, el cliente pinta

`dashboard.js` tenía cuatro escritores compitiendo por el mismo balloon
(`renderState`, `renderSessions`, `addEvent`, `updateScreenInfo`). Cada uno
produjo un bug. Ahora el `StateMachine` es la única fuente y el dashboard es un
renderer sin lógica: una sola llamada a `setBalloon`, dentro de `renderState`.

El argumento que la cierra no es estético: **el firmware Moddable del CoreS3 no
puede correr JS de browser**. Toda política que viva en el cliente hay que
reescribirla en Fase 1B, y las dos copias divergen. Corroborado por
`claude-desktop-buddy/REFERENCE.md`: el heartbeat BLE lleva un solo campo `msg`
de texto — el firmware espera un balloon **ya resuelto**, no reglas.

### S2.5.2 — La vida de un balloon la declara su regla, no su valor

Cada `stateRule` declara `balloonPolicy`:

| valor | significado |
|---|---|
| `transient` (**default**) | muere cuando su evento deja de ser el activo, **por cualquier vía**: resolución, expiración por TTL, drop por modo, watchdog |
| `sticky` | sobrevive a la muerte de su evento; solo lo reemplaza otro balloon |

Y el texto: regla sin `balloon` → **hereda**; `""` → limpia; string → reemplaza.

**Por qué no un valor centinela.** La rev. 1 usaba `undefined`/`""` para
codificar la vida del balloon y obligaba a que `permission_resolved` recordara
poner `balloon: ""`. El council lo rechazó como BLOQUEANTE y tenía razón: hay
**tres caminos** que limpian el evento activo del `AttentionManager` sin
publicar nada al bus (`attention.ts:190-193` TTL, `:91-94` mode-drop,
`:280-283` watchdog). El texto del evento muerto se pegaba al siguiente evento
promovido de la cola. *Un diseño que te obliga a recordar algo está mal.*

La vida de un balloon no es propiedad de su valor: es propiedad de su relación
con el evento que lo produjo. El default seguro (`transient`) limpia solo.

### S2.5.3 — El modo filtra la expresión, no el estado informativo

Un evento `ambient` (prompt, response) no pasa el filtro de `FOCUS`/`SLEEP` en
el `AttentionManager`, así que en esos modos la pantalla no se actualiza con
respuestas. Las cards del dashboard sí, porque viajan por el canal SSE
`session`, que no pasa por el bus. No es un bug: es Calm Tech operando.

### S2.5.4 — Truncado configurable, nunca cableado

`personality.balloonMaxChars` (default 240). El firmware querrá ~60 en 320×240.
El wrap lo hace el firmware (`speech-balloon.ts` mide glifos), así que el bridge
trunca por caracteres, no por píxeles.

### S2.5.5 — D14 (Metabolic State) permanece en Fase 4

La rev. 1 lo adelantaba. Devuelto por el council con argumento numérico
concluyente. Ver el estado anotado en D14 arriba.

### S2.5.6 — El template se interpola con todo el payload

No con un subset fijo de `{project, command, session}`. Habilita `{text}`,
`{message}`, `{tokens}` sin tocar código.

### S2.5.7 — `POST /replay` solo con `--simulate`

Republicar eventos al bus en producción reescribiría el estado real. El `file`
se resuelve con `realpath` contra `recorder.dir` — `resolve()` solo no atrapa un
symlink que escape del directorio.

### S2.5.8 — Las categorías de evento son la clave de todo

El `ClaudeAdapter` emite `permission` y `permission_critical` como categorías
distintas. Así `stateRules` le da LED rojo al crítico y `templates` texto
distinto, sin casos especiales en el código.

**El filo, y su cierre.** `#computeDeadline` busca el override por
`source`+`category` exactos. Sin la entrada de `permission_critical`, el permiso
**crítico** cae a `ttlBySeverity.critical` = 30 s y expira, mientras el benigno
conserva su TTL infinito. **Falla invertido.** Cerrado por dos tests
obligatorios, no por disciplina:

1. **Guard de TTL**: para toda categoría de `CLAUDE_CRITICAL_CATEGORIES`,
   `#computeDeadline()` devuelve `null`. Atrapa la próxima categoría que agregue
   Fase 3.
2. **Contrato template↔categoría**: para toda categoría de `CLAUDE_CATEGORIES` ×
   cada preset, o hay template o la categoría está en `silentCategories`.

*(Alternativa descartada: distinguir por severidad `critical` vs `high`. Cierra
el filo del TTL estructuralmente, pero en `SLEEP` el `AttentionManager`
descartaría el permiso benigno con Claude bloqueado esperando. Se prefirió el
filo cerrado por aserción al filo semántico sin cierre.)*

### S2.5.9 — La personalidad gana el texto; la regla gana la política

D28: la personalidad es capa de expresión. `rule.state.balloon` es el default
estructural; si el preset define template para esa categoría, lo pisa. Ambos se
interpolan. `balloonPolicy` siempre viene de la regla — no es expresión, es
mecánica.

### S2.5.10 — `PersonalityManager.balloon()` devuelve `string | null`

`null` = no hay template. `""` = limpiar. El llamador usa `!== null`.

**Hallazgo que lo motivó**: la feature de balloons por personalidad (D28) **nunca
funcionó**. `personality.ts` buscaba `templates[category]`; los presets definían
`permission.pending` y el adapter emitía `permission`. Intersección vacía con
las 6 categorías. `balloon()` no devolvió un string en dos fases, con 254 tests
verdes. El balloon que se veía lo dibujaba el cliente — el código que S2.5.1
borra.

### S2.5.11 — El `ResolvedState` emitido siempre lleva `balloon: string`

Posiblemente `""`. La herencia y la política se resuelven dentro del
`StateMachine` y nunca cruzan la frontera. Cliente y firmware no interpretan.

### S2.5.12 — `balloonPolicy` vive en el `StateRule`, no en el `ResolvedState`

`state` es lo que se envía al firmware. `balloonPolicy` es política del bridge;
el firmware no la necesita ni la entiende.

### S2.5.13 — El truncado se aplica al string final ya interpolado

No a cada variable. Un `{text}` de 4 KB no se come el prefijo `[proyecto]`.

### S2.5.14 — `set_face` y `forceSafeState()` limpian el balloon

`mcp:set_face` sin `payload.balloon` explícito → limpia. Un agente que fuerza una
cara no debe arrastrar el texto de otro evento. `forceSafeState()` es el estado
seguro: no puede heredar nada.

### S2.5.15 — `emit()` conserva su firma

`StateMachineDeps.emit: (state: ResolvedState) => void` no cambia: el transporte
BLE necesitará que el estado se le **empuje**, no ir a buscarlo. El bug de las
dos formas llegando a `notifyState` se arregló en el llamador, y `notifyState()`
pasó a no tener argumento — así toda ruta (emit, sim/mode, sim/touch) manda la
misma forma a nivel de tipos.

### S2.5.16 — Los patterns de LED son los del firmware

`stack-chan/firmware/stackchan/led/led.ts:60-140` expone `on`, `off`, `blink`,
`rainbow`. **`pulse` no existe** (lo tenía el emulador). El enum de zod se
restringe a `solid | blink | rainbow | off`. Escribir config contra una
capacidad que el hardware no tiene es fabricarse una migración.

---

## Decisiones abiertas

- **A2 — STT**: Whisper local (whisper.cpp) vs API. Decidir en Fase 5 con confidence
  score → si baja, cara dudosa + pide repetir.
- **A3 — Wake word**: motor y si vale la complejidad. Post-MVP.

### A1 — TTS: Piper primario + `say` fallback (CERRADA, council 2026-07-06)

- **Contrato**: `TTSProvider` — `synthesize(text) → WAV`. El bridge genera el
  WAV y lo manda por WiFi al speaker del firmware (R7). Provider elegible por
  config, sin tocar el pipeline.
- **Primario: Piper** (offline, gratis, voces es_MX/es_ES `.onnx`, probado en
  ComandOS y corre en Apple Silicon).
- **Fallback: `say` de macOS** (`say -o out.wav --data-format=LEF32@22050`) —
  cero dependencias, siempre disponible. Mitiga el riesgo de bitrot de Piper
  (el proyecto original rhasspy/piper está en transición de mantenimiento).
- Verificación práctica (instalar Piper, generar un WAV es_MX, medir latencia)
  = primer spike de Fase 5. Si Piper falla, `say` ya cumple el contrato.

---

## Opciones rechazadas (no re-litigar)

- **Fork C++ de TaoXieSZ como base**: descartado tras evidencia — no aporta reuso
  para caras ricas. Queda como referencia del protocolo BLE, no como base de firmware.
- **`claude-desktop-buddy-s3` como base CoreS3**: NO es CoreS3, es M5StickC Plus S3.
- **`claude-desktop-buddy` upstream (Anthropic)**: solo M5StickCPlus, rechaza PRs.
- **Protobuf/MessagePack en lugar de JSON line-delimited**: el volumen no lo justifica
  y rompería compat con la spec de REFERENCE.md. Reconsiderar solo si evidencia real
  de bottleneck.
- **Personalidad evolutiva, multi-buddy**: over-engineering, backlog lejano.
- **Tailing continuo de `~/.claude/*.jsonl` como fuente primaria del
  ClaudeAdapter** (council 2026-07-06): el formato es contrato interno y cambia
  sin aviso (evidencia: ccusage y claude-session-dashboard se rompen con
  releases). Los hooks oficiales cubren todo lo que el MVP necesita con API
  publicada. El transcript solo se lee one-shot cuando un hook lo entrega
  (D19). Reconsiderar únicamente si aparece una necesidad que los hooks no
  cubran y que justifique mantener un parser continuo.
- **Rust para el bridge**: BLE/MCP/CDP/LLM SDKs menos maduros en Rust; curva enorme
  vs valor real para el volumen esperado. Reconsiderar solo si aparece un bottleneck
  medible.
- **Retroalimentación háptica**: el CoreS3 no tiene motor de vibración.
- **Eliminar STT/TTS del scope**: fue requisito explícito del usuario. La opción
  correcta es *posponer* (Fase 4+), no eliminar.

---

## Fuentes de investigación

- Existentes más cercanos: `TaoXieSZ/claude-code-buddy` (protocolo BLE + estados),
  `kisaragi-mochi/stackchan-mcp` (MCP tools sobre hardware), `ronron-gh/AI_StackChan_Ex`
  (multi-LLM YAML), `tumourlove/claude-buddy` (JSONL tailer → animación, Electron).
- Gaps que llenamos: multi-LLM por roles (post-MVP), notifs de dev heterogéneas,
  Chrome CDP, ambient dev-focus, telemetría de tokens en el avatar.
