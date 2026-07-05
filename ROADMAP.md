# ROADMAP — StackChan Claude Buddy

Plan de fases con **gates de validación** entre bloques. El MVP es Fase 2 —
todo lo demás es condicional a que el MVP se use en la vida real.

Cada fase produce algo funcionando y verificable por sí mismo. El plan detallado
bite-sized (TDD, pasos de 2-5 min) se escribe *just-in-time* al arrancar cada fase.

Decisiones ancladas en [DECISIONS.md](DECISIONS.md).

Estado: **Fase 0 pendiente de arrancar.**

---

## Fase 0 — Discovery (una tarde, sin escribir features)

**Objetivo**: convertir suposiciones en hechos antes de comprometer diseño detallado.

- Instalar ModdableSDK y toolchain para ESP32-S3 / CoreS3.
- Flashear `stack-chan/` tal cual en el CoreS3, target `m5stackchan_cores3`.
- Confirmar que arranca: cara renderiza, servos se mueven, LEDs responden, touch de
  cabeza reporta eventos, mic captura, speaker suena.
- **Validar R2 (ESP32-S3 con todo activo)**: correr un mod que ejercite BLE + audio +
  servos + LEDs + display + touch en paralelo. Confirmar que no derrapa.
- **Validar R7 (audio por WiFi confirmado)**: medir round-trip PTT (BLE) vs audio
  (WiFi). Confirmar que BLE es viable para comandos y WiFi para audio.
- Leer y anotar el protocolo BLE de `claude-desktop-buddy/REFERENCE.md` con detalle.

**Verificación**: StackChan corriendo firmware stock. Todas las capacidades listadas
funcionando. Riesgos R2 y R7 con números.

**Entregable**: `Stackchan/NOTES.md` con estado verificado + latencias + sorpresas.

---

## Fase 1 — Bridge foundation + link BLE (el esqueleto vivo)

**Objetivo**: bridge Node/TS hablando con el StackChan por BLE. Arquitectura correcta
desde el día 1 — no un monolito que después haya que refactorizar.

**Alcance:**
- **Estructura del bridge**: adapter pattern, event bus, **Attention Manager**
  (arbitra prioridad, TTL, expiración, reemplazo), state machine central, capa
  `platform/` (D2) para lo macOS-específico.
- **Modo simulation** (`--simulate`): bridge sin BLE real; imprime a stdout +
  dashboard qué habría mandado. Habilita desarrollo de fases 2-7 sin hardware.
- **Dashboard local** (`localhost:1780`):
  - Estado actual + Cognitive Load con breakdown de componentes (aunque el score
    todavía no exista en Fase 1, el layout se deja listo).
  - Últimos eventos.
  - **Health de cada adapter** (HEALTHY/DEGRADED/BROKEN, último evento, latencias).
  - Salud del BLE.
  - **Botones**: replay last 30 min / replay today.
- **`/metrics` endpoint** (D23): Prometheus-text con eventos/min, BLE reconnects,
  heartbeat misses, adapter failures, parser errors, latencias p50/p95.
- **`POST /events` endpoint** (D26): superficie HTTP para que procesos externos
  empujen eventos al pipeline. Schema versionado + rate limit global. Habilita
  probar integraciones con un `curl` antes de invertir en un adapter.
- **Config declarativa** (`config.yaml`) + **hot-reload** (D18).
- **Event Recorder** (D15): log ndjson append-only con contexto por línea
  (score, mode, BLE health, adapter health).
- **BLE con seq/ack + heartbeat + state_sync** (D7) — mitiga R1. Reconexión auto.
- **Latency instrumentation** (D23): budgets medidos desde el día 1.
- **Firmware safe mode** (D16): cara SLEEPY si no llega heartbeat en 15s.
- **Firmware**: extender esquema de mensajes; handler mínimo para `set_face(emotion)`
  y evento `button_pressed`.

**Test end-to-end**:
1. Simulation: dashboard muestra flujo completo sin hardware.
2. Real: `setFace('HAPPY')` cambia la cara; botón A → evento logueado.
3. Matar bridge → firmware entra safe mode → volver a arrancar → state_sync.
4. Matar firmware → bridge detecta por heartbeat → reconecta → resync.
5. Cambiar `config.yaml` → cambios reflejados sin reiniciar.
6. `bridge replay events.ndjson` → reproduce eventos de un log guardado.

---

## Fase 2 — Monitor de Claude Code (el MVP)

**Objetivo**: el StackChan refleja el estado real de mi trabajo con Claude Code.
**Este es el MVP** (D20) — si no lo uso en dos semanas, no sigo con fases posteriores.

**Alcance:**
- **`ClaudeAdapter` aislado, ultra-paranoid, multi-instancia** (D19 + D21):
  tailer de `~/.claude/*.jsonl` con parsing tolerante; tracker por `pid + cwd`
  (múltiples sesiones simultáneas de Claude Code); health status HEALTHY/DEGRADED/
  BROKEN — si BROKEN, cara muestra "Claude cambió", no miente en silencio.
- Detección de sesiones activas, waiting, errores, fin de tarea, permission pending.
- Al pedir permiso, la cara + speech balloon muestran de cuál sesión (path corto
  del proyecto); aprobar aplica a esa sesión específica.
- Tokens 5h/semanal (via `ccusage` o endpoint interno) → cara refleja cuánto queda.
- **Cola de aprobaciones con guarda de seguridad (D6)**: permission pending → cara
  DOUBTFUL + tilt arriba + LED ámbar. Touch cabeza:
  - Non-critical: click único = approve, swipe back = deny
  - Critical (rm, sudo, drop, force push…): **hold 2s** con feedback visual
- **Botón C**: ciclar modo NORMAL / FOCUS / SLEEP (afecta umbral de prioridad D4).
- **Dedup (D5)**: mismo error N veces = 1 evento con count, no ruido.
- Event Recorder captura toda la actividad para replay/históricos.
- **MCP server del bridge — versión mínima** (D26): tools `notify()` y
  `set_face()` expuestas para que Claude Code (u otro agente MCP) las llame.
  Se extiende en fases posteriores (`speak`, `blink_led`, `look_at`, etc.).

**Verificación**: al correr Claude Code, el StackChan cambia de estado real. Aprobar
un permiso desde la cabeza funciona con la guarda correcta. Mismo error repetido no
genera ruido emocional. Un `curl -X POST localhost:1780/events` desde otra terminal
dispara una notif visible.

---

## 🚦 Gate 1 — Validación del MVP (2 semanas de uso real)

Antes de invertir en Fase 3+, verificar los criterios de D20 con **datos duros del
Event Recorder**:

- Uso ≥5 días laborales/semana, 3 semanas seguidas.
- ≥50% de permisos aprobados desde la cabeza (no terminal).
- **Trust checks/día ≤ 2** (D22): rara vez abro Claude para verificar cuando el
  buddy dice OK. Métrica dura, no anécdota.
- Modo FOCUS se usa al menos una vez al día.
- Latency budgets (D23) cumpliendo p95.

**Si no se cumple**: parar. Entender por qué antes de agregar más.

---

## Fase 3 — Trabajo (Jira + Calendar + GitHub)

**Objetivo**: notifs de trabajo laborales, predecibles, de valor inmediato. Consolida
el sistema de prioridades y el pattern de adapters antes de fuentes ruidosas.

**Orden interno recomendado** (por valor decreciente, para poder cortar si el
tiempo aprieta): **Calendar → GitHub → Jira**. Cada uno es entregable independiente.

**Alcance:**
- **`CalendarAdapter`** (Google + Atlassian) — primero: próxima reunión en X min →
  speech balloon + azul lento izq + bajo tono. Focus time → modo FOCUS automático.
  Valor inmediato y bajo riesgo.
- **`GitHubAdapter`** — segundo: PRs pendientes de review, CI rojo,
  comentarios/mentions → dir=der, ámbar/rojo según severidad.
- **`JiraAdapter`** — tercero: tickets asignados, cambios de estado, mentions →
  dir=izq, azul.
- Los tres consumen `config.yaml` para umbrales y mapeos — cero lógica cableada.
- Cola de notifs navegable con touch cabeza (swipe fwd/bwd entre notifs).
- **Error budget** (D17) por adapter para prevenir tormentas.
- Cada adapter con health status (D21 aplicado análogamente si el contrato es frágil).

**Nota**: los MCP de Jira/GitHub/Atlassian requieren OAuth (autorizar en claude.ai o
`claude mcp` interactivo). Confirmar acceso antes de arrancar.

**Verificación**: ticket asignado + reunión próxima disparan reacciones correctas,
direccionadas al lado correcto, respetando modo activo.

---

## Fase 4 — Ambient + Cognitive Load (el diferencial fuerte)

**Objetivo**: el "background mood" del sistema. Con adapters de Fase 3 activos, ya hay
suficientes inputs para un score de carga con sentido.

**Alcance:**
- **Cognitive Load score** (D14) con heurística simple y pesos declarativos:
  - Score 0-100 con derivación categórica FLOW/FOCUSED/BUSY/OVERLOADED/BLOCKED
  - Cara refleja el rango, decorators (sweat) aparecen en niveles altos
  - Solo alimenta cara cuando no hay evento activo — no pisa reacciones concretas
  - Ponderación horaria contextual (afinable)
- **Pomodoro**: mueve la cabeza al terminar el bloque.
- **Break reminders** cada 90 min: mira a la ventana.
- **Idle nudge**: Claude esperándote hace X min → TTS suave (si Fase 5 ya está).
- **Focus/DND**: cara SLEEPY, LEDs tenues, servos lentos, silencia lo no urgente.

**Verificación**: en un día real, la cara refleja carga cognitiva gradual sin
necesidad de eventos discretos. Un ciclo Pomodoro completo dispara el movimiento;
en FOCUS solo pasan urgentes.

---

## 🚦 Gate 2 — ¿Sigue aportando valor?

Con Cognitive Load funcionando, evaluar antes de invertir en voz:

- ¿La cara con carga me da información que uso?
- ¿Miro el buddy en vez de revisar Mac cada X min?
- ¿Vale la pena la complejidad de STT/TTS o el sistema visual/físico ya alcanza?

**Si voz no parece necesaria**: quedate en Fase 4 + Chrome (Fase 6) y da por
terminado el producto. No todos los proyectos tienen que llegar a la última fase.

---

## Fase 5 — Voz (solo Claude primero)

**Objetivo**: hablarle a Claude por voz sin cambiar de app. Multi-LLM pospuesto —
evita comprometer scope antes de saber si se usa.

**Alcance:**
- Resolver A1 (TTS: probablemente Piper + onnxruntime local) y A2 (STT: Whisper
  local vs API) con confidence score.
- **Audio por WiFi** (D2/R7), no BLE — comandos por BLE, audio por WiFi.
- Botón B push-to-talk: captura mic → STT → Claude → respuesta hablada + resumen
  en pantalla.
- STT dudoso → cara dudosa + pide repetir.
- **Comandos de voz al sistema**: "modo focus", "muestra tokens", "silencia 30 min",
  "qué tengo pendiente".
- Lip-sync con `useTTS` de Moddable.

**Verificación**: PTT + preguntar → respuesta hablada. Comando "modo focus" → sistema
entra en FOCUS. STT dudoso → cara pide repetir.

### Fase 5b — Multi-LLM (condicional a uso real)

- Botón A: ciclar Claude / GPT / Gemini.
- Wrappers para OpenAI y Gemini en el bridge.
- Ruteo sugerido: Gemini info actual, GPT conversación libre.

---

## 🚦 Gate 3 — ¿Multi-LLM se usa?

Después de 2 semanas de Fase 5b, si solo hablo con Claude, el Council pierde razón
de ser. **Council queda en backlog automático si este gate no se cumple.**

---

## Fase 6 — Chrome CDP adapter (opcional, con error budget agresivo)

**Objetivo**: enterarme de errores de Chrome sin tener DevTools abierto. La fuente más
ruidosa — al final del roadmap adrede.

**Alcance:**
- launchd: `.app` wrapper de Chrome de dev con puerto 9222 + perfil dedicado.
- **`ChromeAdapter` como plugin reemplazable** (R4/D8): cliente CDP, suscripción a
  `Runtime.exceptionThrown`, `Runtime.consoleAPICalled` (error/warn),
  `Network.responseReceived` (4xx/5xx), `Network.loadingFailed`.
- **Error budget agresivo** (D17): `chrome.max_emotional_events_per_minute: 3`
  por default. Sin esto la cara vive triste.
- Allowlist de URLs (localhost:*), dedup 500ms, umbral por severidad.
- Buffer circular + `getResponseBody` automático para 4xx/5xx.
- Mapeo en config: exception → ANGRY + rojo der + alerta; console error →
  contador + boca preocupada.

**Verificación**: con DevTools cerrado, provocar una exception en localhost → el
StackChan reacciona sin generar tormenta. El buffer permite inspección posterior.

**Alternativa honesta**: si tras Fase 4-5 Chrome no aporta suficiente sobre lo
que ya tenés, mover a backlog. No hay obligación.

**Extracción minimal si no aguantás la espera**: si en algún punto realmente
necesitás Chrome antes, se puede sacar una versión ultra-minimal (solo
`Runtime.exceptionThrown` con error budget de 1/min) e insertarla después de la
Fase 2 sin romper nada. Pero por default, esta fase queda tarde a propósito.

---

## Fase 7 — Council (condicional a Gate 3)

**Objetivo**: aprovechar Claude/GPT/Gemini para orquestar respuestas colaborativas y
mostrar consenso. Diferencial único de un buddy físico. **Solo si Gate 3 se cumplió.**

**Alcance (D13):**
- Modo Council activable por voz ("modo council") o botón.
- Roles configurables (default: Opus trabaja, GPT + Gemini revisan).
- **Detección de consenso**: heurística inicial simple (similarity de embeddings o
  un LLM juez). Afinar con evidencia de uso.
- **StackChan muestra**: 🙂 alto / 😕 parcial / 😬 conflicto + balloon con divergencia.
- Resultados detallados en el dashboard.

**Verificación**: pregunta ambigua → 3 respuestas → StackChan refleja consenso →
dashboard muestra detalle.

---

## Backlog (post-MVP)

- Wake word on-device (A3).
- IMU: head-pet → HAPPY + corazón; levantar → dashboard; sacudir → snooze 5 min.
- Costos multi-proveedor agregados.
- Deploys (Cloudflare/Vercel/Fly), Docker/procesos, dev server watch.
- **Daily review + métricas históricas**: sobre el Event Recorder — interrupciones,
  approvals, tiempo en FOCUS. Genera valor real.
- **Buddy Memory contextual**: recuerda proyecto/tarea en foco.
- **Adaptive behavior**: aprende horarios de FOCUS/DND sin config.
- **Detección de contexto cambiado**: cambio de ventana/proyecto ajusta estado.
- **VS Code / terminal**: integración adicional.
- **Git local**: branch, estado de repo, commits pendientes (sin API).
- **Self-reflection diaria**: resumen del día.
- **StackChan como MCP server completo** (estilo `kisaragi-mochi/stackchan-mcp`).
- **Portabilidad Linux/Windows del bridge** (D2): empaquetado por OS.
- **Distribución a otros usuarios**: instaladores, docs, community.
- **OTA / auto-update**: firmware over-the-air para ESP32, auto-update del bridge
  (git pull + relaunch por launchd). Baja prioridad para uso personal.
- **Adaptive behavior**: aprender horarios de FOCUS/DND del historial del Event
  Recorder sin config manual.
- **Trust check extendido**: triangular con más señales (revisar Jira, GitHub,
  mail) además de Claude Code.
