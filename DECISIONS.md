# DECISIONS — StackChan Claude Buddy

Registro de decisiones arquitectónicas del proyecto. Actualizar cuando una decisión
cambie; no borrar las rechazadas (evita re-litigar).

Última actualización: 2026-07-05

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
      ├─ Cognitive Load engine (background mood cuando no hay evento activo, con decay temporal)
      ├─ Event Recorder (ndjson append-only, incluye score + mode + BLE health por línea)
      ├─ Simulation mode (correr sin hardware para dev en paralelo)
      ├─ Dashboard local (localhost:port): estado + breakdown de load + health de adapters + replay
      ├─ /metrics endpoint (Prometheus-text: eventos/min, BLE reconnects, heartbeat misses, ...)
      ├─ Config declarativa (config.yaml) + hot-reload
      └─ Memory local (dedup por event_hash + last_seen + count)
      ↕
   Adapters (cada uno con health status HEALTHY/DEGRADED/BROKEN):
   ├─ ClaudeAdapter (aislado — jsonl contrato interno; multi-instancia por PID+cwd)
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
"background mood" (Cognitive Load) cuando la cola queda vacía.

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
    Scheduler), credential storage (`keytar` npm ya abstrae los tres), paths de
    Chrome y `~/.claude`, comandos para relanzar Chrome.
- **NO Rust**: BLE/MCP/CDP/LLM SDKs menos maduros en Rust; curva de aprendizaje enorme
  vs valor real para el volumen de eventos esperado (decenas/minuto, no miles/seg).
  Reconsiderar solo con evidencia de bottleneck.

### D3 — Modelo de eventos normalizado

Todos los adapters emiten al bus un mismo shape:

```ts
interface Event {
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
- **Ambient**: buscador voz (Fase 4: solo Claude; multi-LLM después), Google +
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
  "cognitiveLoadScore": 47,
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
Cognitive Load, mapeos, prioridades — todo iterativo. Un endpoint del dashboard
(o watcher de archivo) dispara la recarga. Validación de schema antes de aplicar.

### D19 — ClaudeAdapter ultra-paranoid parsing

`~/.claude/*.jsonl` es contrato interno y puede cambiar sin aviso. El adapter:

- Valida schema por línea, tolera desconocidos.
- Si una línea no matchea, la loguea a nivel warn y **skipea** — no crashea el bridge.
- Tests con fixtures de logs reales del usuario (grabados) + fixtures corruptos.
- Aislado detrás de una interfaz estable — si el formato cambia mucho, cambia solo
  este archivo.
- **Multi-instancia**: tracker por `pid + cwd`. Cada sesión de Claude Code activa es
  un item en la cola. Al pedir permiso, el dashboard/cara muestra de cuál sesión
  (path del proyecto). Aprobar desde la cabeza aplica a la sesión al frente de la
  cola por prioridad.

### D21 — ClaudeAdapter con health status explícito

El peor escenario del ClaudeAdapter no es "no funciona" — es **mentir en silencio**.
Contramedida: el adapter mantiene un estado observable:

- **HEALTHY** (<5% líneas desconocidas en ventana móvil): opera normal.
- **DEGRADED** (5-20% desconocidas): sigue operando, cara muestra decorator "?"
  discreto, dashboard alerta amarillo.
- **BROKEN** (>20% desconocidas o parser crash repetido): cara pasa a estado
  DOUBTFUL con speech balloon **"Claude cambió"**. Dashboard marca rojo. El buddy
  no pretende saber lo que no sabe.

Umbrales configurables. Aplica el mismo patrón a otros adapters con contratos
frágiles (ChromeAdapter si Google endurece CDP, etc.).

### D22 — Trust check metric (medida dura de confianza)

Métrica automatizable de "¿le creo a la cara?":

- **Definición**: contar cuántas veces por día el usuario abre/enfoca Claude Code
  (via Accessibility API en macOS) **mientras el buddy está en estado
  NEUTRAL/HAPPY** (nada pendiente según el buddy).
- **Filtro anti-falsos-positivos**: solo cuenta si Claude no tenía foco en los 30s
  previos. Re-activaciones rápidas (alt-tab, notif, etc.) no cuentan.
- **Fase burn-in**: los primeros 3 días de uso no cuentan para el Gate 1 (curva de
  aprendizaje del usuario, no del sistema).
- Alta cuenta ⇒ el usuario verifica constantemente ⇒ no confía en la cara.
- Baja cuenta ⇒ confía. Meta MVP (D20): trust_checks/día ≤ 2 en las semanas 2 y 3.
- Se registra en el Event Recorder como evento sintético `category: "trust_check"`.

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
Después de 2 semanas del MVP en uso real, verificar:

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
- **Repo público en GitHub** cuando el MVP funcione (post Gate 1 mínimo).
- **Licencia permisiva** (MIT o Apache 2.0) para que forkear sea trivial.
- **Código legible**: no ofuscado, nombres claros, funciones cortas — el estándar
  normal de "un desarrollador entiende esto".
- **Higiene de secretos desde el día 1**: tokens/keys en Keychain (`keytar`) o
  variables de entorno, nunca en archivos versionados. `config.yaml` gitignored,
  `config.example.yaml` versionado.
- **`.gitignore` robusto** desde Fase 1: logs de eventos, credentials, builds,
  `.env`, dumps del recorder.
- **README honesto cuando exista** (post-MVP): "esto es mi buddy personal, andá
  a probar, no prometo nada, PRs bienvenidos pero no revisados con SLA".
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
  útil a molesto. Mitigaciones: error budget por adapter (D17), Cognitive Load solo
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

Feature dedicada, no backlog. Aprovecha los wrappers multi-LLM de Fase 4b:

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

### D14 — Cognitive Load score (Fase 4)

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
- 0-20 → FLOW
- 21-40 → FOCUSED
- 41-60 → BUSY
- 61-80 → OVERLOADED
- 81-100 → BLOCKED

La cara se vuelve más estresada conforme sube (NEUTRAL → DOUBTFUL → SAD → ANGRY +
sweat decorator + LEDs más intensos). **Solo alimenta la cara cuando el sistema
está idle emocionalmente** — no pisa reacciones concretas (un error de Chrome
sigue disparando ANGRY directo). Es el "background mood".

**Ponderación contextual del tiempo** (afinable en config): un error a las 11am no
pesa lo mismo que a las 23:30 si estás cansado. Multiplicador horario opcional.

---

## Decisiones abiertas

- **A1 — TTS**: preferencia "sin costo". Candidato principal **Piper + onnxruntime**
  en Mac (corre bien en Apple Silicon). Verificar contra defaults de Moddable en
  Fase 4.
- **A2 — STT**: Whisper local (whisper.cpp) vs API. Decidir en Fase 4 con confidence
  score → si baja, cara dudosa + pide repetir.
- **A3 — Wake word**: motor y si vale la complejidad. Post-MVP.

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
