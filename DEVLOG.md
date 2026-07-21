# DEVLOG — buildagotchi

Log cronológico de desarrollo. Cada entrada registra qué se hizo, qué se
verificó, y decisiones tomadas. El ROADMAP tiene el plan; esto tiene la
realidad.

---

## 2026-07-05 — Día 1: Arquitectura y specs

### Sesión 1 (mañana)
- Creación del repo `mahumadad/buildagotchi` con docs arquitectónicos:
  DECISIONS.md (D1-D26), ROADMAP.md (Fases 0-7 + gates), NOTES.md (template
  Fase 0), SETUP.md, README.md.
- SPEC-FASE-1.md: spec completa de Fase 1 (bridge + BLE), con partición
  1A (sin hardware) / 1B (con hardware).
- Review adversarial → hardening de la spec (mensajes BLE, edge cases).
- `config.example.yaml` inicial.

**Commits**: `7e5ce89`..`8bcc3e3` (6 commits)

### Estado al cierre
- Docs fundacionales completos. Hardware pedido, no ha llegado.
- Fase 0 bloqueada por hardware. Fase 1A lista para arrancar.

---

## 2026-07-08 — Día 2: Ecosystem audit + Fase 1A + Fase 2 completa

### Sesión 2 (madrugada) — Ecosystem + decisiones
- Auditoría de repos de referencia: Clawdmeter (BLE→ESP32), ComandOS
  (hooks+Piper), ccboard, dashboards community.
- Nuevas decisiones: D27 (vitality layer), D28 (personalidad configurable).
- Referencias externas ancladas en DECISIONS.md.
- Council review de SPEC-FASE-2: aprobado con cambios. D19 (hooks-based) y
  A1 (Piper TTS) cerradas.

**Commits**: `6426eb5`..`628154f` (4 commits)

### Sesión 3 (tarde) — Fase 1A completa (M0-M5)
- SPEC-IMPL-FASE-1A.md escrita con Fable (plan detallado bite-sized).
- Implementación de M0-M5 con Sonnet, ejecutando el plan:

| Milestone | Qué | Tests |
|---|---|---|
| M0 | Scaffold: TS strict, Vitest, Biome, estructura de dirs | 0 |
| M1 | Contratos core, EventBus con dedup, EventRecorder, graceful shutdown | 49 |
| M2 | Config schema (zod) + hot-reload loader | 17 |
| M3 | Attention Manager + StateMachine | 38 |
| M4 | BridgeServer HTTP nativo + POST /events + replay + DemoAdapter | 28 |
| M5 | Protocolo BLE + transports (loopback + sim) | 17 |

- Review adversarial con Opus 4.8 → 4 fixes aplicados.
- **Total Fase 1A**: 149 tests, typecheck limpio, biome limpio.

**Commits**: `9eeca59`..`4963eef` (8 commits)

### Sesión 4 (noche) — Fase 2 completa (M6-M11)
- SPEC-FASE-2.md + SPEC-IMPL-FASE-2.md escritas.
- Auditoría de repos de referencia para validar approach de hooks.
- Implementación M6-M11:

| Milestone | Qué | Tests nuevos |
|---|---|---|
| M6 | ClaudeAdapter (hooks multi-sesión) + transcript reader | 20 |
| M7 | Hooks installer (dedupe-merge) + bridge doctor (5 checks) | 12 |
| M8 | Dashboard UI (HTML/CSS/JS), POST /hooks/claude, POST /approve, SSE | 8 |
| M9 | MCP server (notify, set_face, approve_permission) + resources | 7 |
| M10 | Personality presets (YAML) + template interpolation | 5 |
| M11 | Integration wiring, config schema update, hot-reload personality | 5 |

- Bug encontrado en simulación: approve no limpiaba el evento del Attention
  Manager → cara quedaba DOUBTFUL. Fix: `resolvePermission` retorna eventId,
  server llama `am.resolve()`.
- Dashboard verificado end-to-end con preview tool:
  - Hook lifecycle completo: UserPromptSubmit → Permission (botones
    Approve/Deny) → Approve → Stop → SessionEnd
  - SSE live, health badges, event log con color-coding por severidad
  - Multi-sesión independiente
- **Total Fase 2**: 227 tests (78 nuevos), typecheck + biome limpios.

**Commits**: `d85ea0f`..`2f96237` (9 commits)

### Estado al cierre
- **Fase 1A**: completa ✅
- **Fase 2**: completa ✅ (software — falta wiring con hardware en 1B)
- **Fase 0**: bloqueada por hardware (CoreS3 K151 no ha llegado)
- **Fase 1B**: bloqueada por hardware (BLE real)
- 17 commits locales pendientes de push a origin
- 74 archivos, ~13,300 líneas nuevas

---

## 2026-07-09 — Día 3: Fase 2.5 (deuda expresiva + observabilidad)

Sesión larga, dos etapas.

### Etapa 1 (mañana): D19-enrichment + hallazgos del emulador

- `claude-jsonl-scanner.ts` extendido con `title`, `lastPrompt`, `lastResponse`
  (head 64 KB / tail 128 KB, sin `readFileSync` completo).
- `claude-desktop-titles.ts`: nueva fuente para el chat name real
  (`~/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json`,
  filtra `titleSource === "user"`).
- Adapter: `PostToolUse` hook para auto-resolver `pendingPermission` desde el
  chat de Claude, `slug` de Claude Code, `desktopTitle` prioritario.
- Dashboard: nombre de sesión ahora sigue la cascada `desktopTitle > slug >
  lastPrompt > title`, y el balloon deja de ser controlado por el cliente
  vía `updateScreenInfo` (era la fuente de 4 bugs).
- **Bug de LEDs cazado**: `emit(state)` mandaba `ResolvedState` crudo pero el
  cliente esperaba `{resolvedState, mode}`. Fix defensivo en `notifyState`,
  luego reemplazado en Fase 2.5 por `notifyState()` sin argumento (S2.5.15).

### Etapa 2 (tarde): Fase 2.5 — SPECs, council, implementación

**SPECs**: `SPEC-FASE-2.5.md` + `SPEC-IMPL-FASE-2.5.md`. La motivación explícita
es que el firmware Moddable del CoreS3 no puede correr JS de browser: toda
lógica de "qué mostrar" que viva en el dashboard hay que reescribirla en Fase 1B
y las dos copias divergirán. Fase 2.5 mueve la propiedad del balloon al
servidor y paga otras deudas de observabilidad antes de que Fase 3 sume cinco
adapters encima.

**Council** (rev. 2, aprobado con cambios): encontró tres BLOQUEANTES y cinco
IMPORTANTES. El más grave: el `AttentionManager` tiene tres vías que limpian
`#active` sin publicar al bus (TTL expiry, mode-drop, watchdog), y con la rev. 1
del spec el balloon del evento muerto se pegaba al siguiente evento promovido
de la cola. **Verificado empíricamente** contra el bridge corriendo: bajé el TTL
crítico a 5 s, disparé un permission, y capturé la traza `am_decision: expired
→ state_change (otro event)` — el bug estaba dormido porque el balloon aún lo
pintaba el cliente.

Rev. 2 reescribe S2.5.2: la política vive en el `stateRule` (`sticky` /
`transient`), no en el valor del balloon. `transient` es el default y muere
por CUALQUIER vía; `sticky` solo lo reemplaza otro balloon.

**Cambios menores del council aplicados**: M17 (Metabolic State) devuelto a
Fase 4 con criterio explícito de retomada; `pulse` fuera del enum (el firmware
solo tiene `on/off/blink/rainbow`); `emit(state)` conserva firma (el
transporte BLE la necesita); `permission_critical` como categoría distinta con
guard test para el `ttlOverride` infinito.

### Milestones M12a → M17

| M | Alcance | Tests nuevos |
|---|---|---|
| M12a | `StateMachine` con `#balloon: {text, policy}`, herencia inteligente, `set_face` y `forceSafeState` limpian | 22 (los 21 del council + #22 de regresión encontrado mid-M13) |
| M12b | Dashboard renderer tonto. `grep -c setBalloon dashboard.js` == 1. `notifyState()` sin arg | 0 (regresión visual en Chrome) |
| M13 | Split `permission` / `permission_critical`, `stateRules` completas, presets con `silentCategories`. Guard test TTL + contract test template↔categoría | 49 (3 adapter + 4 schema + 36 contract + 6 integration) |
| M14 | SSE `state` con `active`/`queue`/`mode`. Panel Attention + badge con leyenda | 6 |
| M15 | `BalloonHistory` ring buffer. `GET /balloons`. Screen history panel. Eventos consecutivos idénticos con `×N` | 9 |
| M16 | `POST /replay` gated por `--simulate`, guard de symlink con `realpath` (no solo `resolve`), tag `replay: true` | 5 |
| M17 | Integración end-to-end (6 casos) | 6 |

### Bug real cazado durante M13 e2e

El council modeló "transient → apply(null) → promote de la cola". El
`AttentionManager` también resuelve por `resolve → #promote` **sin pasar por
apply(null)**. Con el approve desde el chat (PostToolUse), un permission
transient dejaba su texto sobre el prompt siguiente. Reproducido en Chrome vía
`GET /state`. Fix en `#resolveBalloon`: la herencia en regla silenciosa solo
copia si la política previa era `sticky`; si era `transient`, limpia.

Tests: #6 M12a (apply(null) path) + #22 M12a (regresión del path directo).

### Otro bug: fecha del día-log del recorder

M16 usaba `new Date().toISOString().slice(0,10)` (UTC); el recorder rota por
fecha local. En zonas negativas el `POST /replay` sin `file` no encontraba
nada durante ~5 horas después de medianoche local. Fix: `localDateString()`
exportada del recorder y usada por el server.

### Estado al cierre

- **351/351 tests verdes** (227 base Fase 2 + 124 de Fase 2.5).
- `tsc --noEmit` 0 errores. Biome limpio en los archivos tocados; los errores
  restantes de `dashboard.js` (línea 577 `useSingleVarDeclarator`) son
  preexistentes en código de auto-servo que no se tocó.
- Verificado end-to-end en Chrome: panel Attention con TTL `∞` y contador de
  cola, Screen history con timestamps reales, agrupación `×N` en Events,
  `POST /replay lastN=5` devuelve `{published:5, skipped:0}` y las líneas
  aparecen en el ndjson con `replay: true`.
- Fase 4 conserva D14 (Metabolic State) con seam `#backgroundMood()` ya
  expuesto y criterio de retomada documentado en S2.5.5.
- 16 commits base sin push a origin + todo Fase 2.5 sin commitear.

---

### Post-Fase 2.5 — el checklist manual encuentra un deadlock

Al ejecutar el paso 5 del checklist de §8.1 (aprobar desde el chat, no desde el
dashboard), el robot quedó **colgado permanentemente**: cara DOUBTFUL, LED rojo
parpadeando y `⚠ sudo rm -rf /` en pantalla, para un permiso ya aprobado.

**Causa**: el hook `PostToolUse` limpiaba `session.pendingPermission` en el
adapter, pero nunca liberaba el evento en el `AttentionManager`. Como
`permission_critical` tiene TTL infinito (S2.5.8) y `permission_resolved` es
`ambient` — incapaz de preemptar un `critical` —, el AM entraba en deadlock. El
camino del dashboard sí llamaba `attentionManager.resolve()`; el del hook, que
agregué esta misma mañana, no. El campo `originalEventId` que el adapter emitía
en el payload **no lo consumía nadie** (`grep -rn originalEventId src/ test/` →
cero resultados).

Es el mismo bug que el DEVLOG registra como arreglado en Fase 2 para el camino
del dashboard. Se arregló una puerta y se dejó la otra abierta.

**Por qué 351 tests no lo vieron**: vivía estrictamente *entre* dos módulos.
`claude-adapter.test.ts` verificaba que `pendingPermission` quedara `undefined`;
`attention.test.ts` verificaba `resolve()`. Ninguno cruzaba la costura
`hook → adapter → bus → AM`, porque la separación de módulos — que es correcta —
hacía que ninguno la poseyera. Un test de integración no es un lujo cuando dos
módulos correctos producen un sistema incorrecto.

**Fix**: `AttentionManager.push()` honra `payload.resolvesEventId`. El mecanismo
es genérico (D3: eventos normalizados) — un `build_fixed` de Fase 3 puede retirar
un `build_failed` sin código nuevo. Corre **antes** del filtro de modo: si no, en
`SLEEP` un resolver `ambient` se descartaría y su target quedaría activo para
siempre. Ese caso se verificó a mano contra el bridge.

`originalEventId` → `resolvesEventId`: el nombre viejo describía la procedencia;
el nuevo describe la intención, que es lo que el AM necesita entender.

Nuevo `test/permission-resolve-chain.test.ts`: 6 tests que instancian el adapter
y el bus **reales**. Mockear cualquiera de los dos reintroduce el punto ciego.

**357/357 tests verdes.** Verificado end-to-end en Chrome, en `NORMAL` y en
`SLEEP`.

Hallazgo secundario, no arreglado: un `response` se encola detrás del `prompt`
de su propia sesión (misma severidad `ambient`, no lo preempta) y el balloon con
la respuesta de Claude aparece **~30 s tarde**, cuando el `prompt` expira.
Registrado como D-06 en DEBT.md con el fix propuesto — el mismo
`resolvesEventId` lo resuelve.

---

---

## 2026-07-10 — Día 4: saldar la deuda (391 tests)

Sesión secuencial. La pregunta que la abrió fue "¿qué queda por arreglar?", y la
respuesta honesta empezó verificando si el bug de ayer era un ejemplar o un caso.
Era un ejemplar.

### P0 — El permiso que sobrevive a su sesión

Ayer arreglé el camino del hook `PostToolUse` y escribí en este mismo archivo que
Fase 2 *"arregló una puerta y dejó la otra abierta"*. Hice exactamente lo mismo.

`SessionEnd` y `#cleanStale` borraban la sesión sin liberar su permiso.
Reproducido en vivo: cerrar el chat con un permiso pendiente dejaba al robot con
`⚠ sudo rm -rf /` para una sesión que ya no existía.

El fix no fueron tres llamadas más a `#autoResolvePending`, sino `#retireSession()`
como **único** camino fuera de `#sessions`. Y un test del **invariante**, no de los
casos: *tras cualquier evento del adapter, ningún permiso activo o encolado
pertenece a una sesión que no existe*. Ocho tests terminan en la misma aserción.
Una quinta puerta falla ahí, no en el escritorio.

### D-06 — La respuesta llegaba 30 segundos tarde

`prompt` y `response` son ambos `ambient`, así que el response se encolaba detrás
del prompt de su propia sesión y solo aparecía cuando el prompt expiraba. Para un
dispositivo *ambient* eso es al revés: mirás al robot para saber si Claude
terminó. Un prompt deja de significar algo cuando llega su respuesta; ahora lo
retira con el `resolvesEventId` de ayer. **De ~30 s a inmediato**, cronometrado.

### D-01 — `statesEqual` con `JSON.stringify`

El orden de claves generaba transiciones espurias: un `state_change` que miente,
`face_changes_total` inflado, un broadcast SSE redundante, un duplicado en
`BalloonHistory`. Nunca disparó porque ningún adapter emite `direction`; los de
Fase 3 sí. Comparación campo a campo.

El fix rompió un test de M12a, y ahí está lo interesante: **ese test dependía del
bug**. Aplicaba una regla silenciosa cuyo estado resuelto era idéntico al inicial
y afirmaba que algo se emitía. Solo pasaba porque el orden de claves difería.

### D-02 — 67 MB para leer 50 líneas

`readTranscriptTail` hacía `readFileSync` del transcript completo. Medido contra
un archivo real de 67 MB: **92.8 ms → 0.5 ms**, salida byte-idéntica. Corría
dentro de un hook con presupuesto de 2 s (`curl -m 2`), en el mismo hilo que el
bus. Nuevo `tail-reader.ts` con ventana que crece de 256 KB a 8 MB — una línea
más larga que la ventana devolvía nada, y "raro" no es lo mismo que "correcto".

Escribiéndolo metí un bug y lo saqué: con la ventana empezando a mitad de archivo
y sin ningún `\n`, `indexOf` da -1 y `slice(0)` devuelve el fragmento como si
fuera una línea. Un fragmento parsea como línea desconocida, y `unknownLineRatio`
determina el health del adapter: una línea suficientemente grande lo habría
reportado BROKEN.

### D-04 / D-05 — El emulador no puede mentir

`rainbow` (legal en el enum, porque el firmware lo tiene) se pintaba como sólido.
Y `pattern: 'off'` **encendía** el LED, porque `renderLeds` agregaba la clase `on`
antes de mirar el pattern. Las dos son divergencias emulador↔firmware, que es
precisamente lo que S2.5.1 existe para evitar. `dashboard.js` queda limpio de
biome por primera vez.

### Balance

**391/391 tests** (357 → 391). Seis commits, uno por arreglo. `tsc` y `biome`
limpios. Todo verificado contra el bridge corriendo, no solo en test.

Dos de los tres bugs graves de ayer y hoy salieron del **checklist manual**, no de
la suite. La costura entre módulos correctos es donde vive este sistema y donde
menos cobertura tenía. Los tres tests nuevos de cadena (`permission-resolve-chain`,
`permission-session-invariant`, `prompt-response-chain`) instancian el adapter y
el bus **reales**: mockear cualquiera de los dos reintroduce el punto ciego.

Enmendé un commit: corrí `biome --write` desde la raíz del repo con `--prefix`,
agarró otra config y reformateó tres archivos con tabs y comillas dobles. Se
corrige corriendo biome desde `bridge/`.

---

## 2026-07-10 — Día 4 (tarde): el checklist, el pipeline y los tokens

Sesión larga. El hilo conductor no lo puse yo: **cuatro veces encontramos código o
decisiones escritas como si estuvieran vivas, conectadas a nada.**

### El checklist §8.1, terminado

Pasos 6 al 14 ejecutados contra el bridge corriendo. El paso 6 —la razón de ser
del council— pasó: un permiso benigno expiró por TTL y el balloon se limpió sin
dejar fantasma sobre el evento promovido.

El paso 11 estaba **mal escrito**. Decía que al resolverse un crítico la `response`
"no vuelve". Vuelve, y debe: `attention.ts:149` re-encola lo que preempta, y un
evento vivo merece la pantalla. Lo que no existe es un stack de balloons.

### Lo que estaba escrito y no lo llamaba nadie

- **D-07**: el hot-reload moría tras el primer guardado atómico. `fs.watch` sobre
  una ruta sigue al inodo; vim, VS Code y `sed -i` lo renombran. Fallaba en
  silencio absoluto: ni log ni contador. Ahora vigila el directorio.
- **D-09**: el trust check de D22 **no existía**. Además D22 presupuestaba un
  permiso de macOS que no hace falta — `lsappinfo` es API pública.
- **D-11**: `tsconfig` solo incluía `src`. Los tests nunca se typecheckaban. Al
  destaparlo aparecieron 30 errores, dos de ellos bugs dormidos: el `EventBus`
  construido con un `Metrics` donde va un `DedupConfig`.
- **El pipeline BLE entero**: `ProtocolSession` y `SimTransport` existían,
  testeados en aislamiento, y `index.ts` mandaba el estado a `logger.info`.
  `forceSafeState()` (D16) llevaba desde la Fase 1 sin un solo llamador, porque
  el protocolo no tenía forma de avisar que el link murió.
- **Los tokens**: ya extraíamos `output_tokens` y lo adjuntábamos al payload.
  Nadie lo leía.

### El bug que el cableado destapó

Al conectar el transporte real bajo `--simulate`, el link **oscilaba una vez por
segundo** y cada muerte llamaba a `forceSafeState()`, borrando la cara. Causa:
`#sendStatePayload` transmitía y *después* registraba el `#pending`. Un transporte
síncrono entrega el ack dentro de `send()`, `#handleAck` no encuentra nada
pendiente, y dos acks "perdidos" matan un link sano. `protocol.test.ts` nunca lo
vio: su `LoopbackTransport` responde a los 10 ms, siempre a tiempo.

### Tokens y presión de contexto

Dos números que responden preguntas distintas y se mantienen separados. El
**output** es gasto (acumulado + diario persistido, siguiendo a
`claude-desktop-buddy`). El **contexto** es presión: sube solo, se desploma al
compactar, y no se suma entre sesiones. La ventana del modelo se **declara** en
config: ningún campo del transcript la reporta, y un porcentaje contra un límite
adivinado se ve autoritativo siendo inventado.

Los umbrales mueven la cara, disparados por flanco. Al compactar, `context_calm`
retira al evento anterior con el `resolvesEventId` genérico.

### Lecciones, que son las de siempre

**Un test que no falla cuando rompes lo que dice proteger no prueba nada.** Muté
cada módulo nuevo. Una mutación sobrevivió: podía romper `forget()` del monitor de
presión y los once tests seguían verdes, porque ambos tests de olvido observaban
un nivel *distinto* al anterior y emitían igual con o sin el bug.

**La verificación en vivo encuentra lo que los tests no.** El balloon de presión
salía como `": contexto 91%"` sin el proyecto. El paso 6 destapó el hot-reload. Y
la vista secundaria, que yo había dado por buena verificando solo el estado del
servidor, hacía **desaparecer al robot**: ocultar el contenedor 3D lo colapsaba a
0×0 y `StackchanScene#resize()` solo corre al redimensionar la ventana. Lo
encontró Mario apretando los botones.

También me equivoqué escribiendo deuda: D-10 afirmaba que `state_latency_ms` "solo
mide hasta el ResolvedState". Es falso — mide exactamente la pata del firmware. Si
hubiera implementado sobre mi propia nota sin verificarla, habría duplicado una
medición correcta.

### Balance

**447 tests** (391 → 447), typecheck de `src` **y** `test`, lint en la línea base.
Veinte commits, ninguno pusheado. El Gate 1 pasó de tener tres de cuatro criterios
inmedibles a tenerlos todos con datos.

`DEBT.md` quedó con cinco entradas abiertas (D-03, D-10, D-12, D-13, D-14) y
cinco resueltas hoy. Ninguna de las abiertas se puede cerrar sin hardware, sin
datos reales, o sin una decisión tuya.

---

## 2026-07-10 — Life Stats (espejo honesto)

### Qué se hizo

Feature completa: tres métricas persistentes (approvals/denials, fromHead%,
racha de días laborales) en `LifeStats`, con hito edge-triggered, página LIFE
en la vista stats del robot, y panel Life en el dashboard.

- Spec: `docs/superpowers/specs/2026-07-10-life-stats-design.md` (rev 2, post-council)
- Plan: `docs/superpowers/plans/2026-07-10-life-stats.md` (6 tareas TDD)
- Council (Fable): 8 hallazgos, 2 bloqueantes resueltos antes de implementar
  - C1: conducto de approvals sesgado → dos caminos explícitos
  - C2: demo/sim/replay persisten datos falsos → flag `enabled` + replay guard
  - C3: velocidad incluye esperas humanas → diferida a v2 (D-15)
  - C4: tabla de transiciones para fin de semana

### Archivos nuevos

- `bridge/src/core/workday.ts` — `isWorkday`, `workdayGap` puros
- `bridge/src/core/life-stats.ts` — clase `LifeStats` con JSON persistence
- `bridge/test/workday.test.ts` (11 tests)
- `bridge/test/life-stats.test.ts` (19 tests)

### Archivos modificados

- `bridge/src/index.ts` — wiring + milestone + replay guard
- `bridge/src/server/server.ts` — `recordResolution` en dashboard + `/stats.life`
- `bridge/src/config/schema.ts` — `milestoneStreakDays`
- `bridge/src/core/screen-view.ts` — `PAGES.stats` 2→3
- `bridge/src/server/public/screen.mjs` — página LIFE (array dispatch)
- `bridge/src/server/public/index.html` — panel Life
- `bridge/src/server/public/dashboard.js` — render life data
- `bridge/src/server/public/dashboard.css` — estilos life panel
- `config.example.yaml` — stateRule `life_milestone` + `milestoneStreakDays`

### Verificación

- 503 tests verdes (30 nuevos para workday + life-stats + screen)
- Typecheck `src` + `test` limpio
- Dashboard: panel Life renderiza (verificación visual parcial — el servidor
  corriendo no tenía el backend cargado, pero el DOM es correcto)
- Verificación E2E completa requiere reinicio del bridge

### Decisiones

- **Velocidad diferida** (D-15): no se puede medir honestamente sin
  `pendingPromptAt` y sin excluir turnos con permisos pendientes.
- **Feriados no manejados**: aceptable para v1; `isWorkday` está extraído como
  función pura para que añadir feriados sea un cambio local.
- **Replay guard**: `!e.payload.replayedFrom` en ambos bloques de `index.ts`;
  encontrado por el reviewer de Task 3, corregido en commit separado.

**Commits**: `15dfc7e`..`3d5128c` (6 commits)

---

## 2026-07-11 — Decisiones interactivas: solo el enriquecimiento (fase 0)

### Qué se hizo

De la spec de decisiones interactivas (`docs/superpowers/specs/2026-07-11-decisiones-interactivas.md`)
se implementó **únicamente el enriquecimiento de permisos con `PreToolUse`**:
la card de permiso y el balloon ahora pueden mostrar qué comando real está
pidiendo aprobación (`Bash: git push origin main`) en vez de solo "esperando
permiso". El relay de permisos (hook bloqueante que expone la decisión al
dashboard) y la Parte 2 (AskUserQuestion visible) **no se implementaron** —
quedan como trabajo futuro.

**Motivo (fase 0):** las sesiones de Claude Code corren en
`bypassPermissions`, así que el relay que se había diseñado (interceptar
`PermissionRequest` y bloquear hasta que el dashboard responda) nunca se
dispara — no hay eventos que relayar. Y aunque se cambiara el modo, el hook
`PermissionRequest` no es verificable de forma headless (requiere una sesión
interactiva real para confirmarlo). Sin poder verificar el mecanismo base,
construir el relay encima habría sido especulativo. El enriquecimiento vía
`PreToolUse` sí es 100% verificable con hooks simulados por curl, así que es
lo único que se construyó esta ronda.

Task 1 y 2 (ya hechas antes de esta sesión, commits `2c7e5d1`, `548116b`,
`41a75b2`) agregaron `summarizeToolUse` (mapea `tool_name`/`tool_input` a un
resumen legible) y los campos `toolName`/`summary` en
`ClaudeAdapter#pendingPermission`. Esta tarea (Task 3) fue solo de
superficie: mostrar esos campos donde ya existían canales para hacerlo, y
documentar el alcance real.

### Archivos modificados

- `bridge/src/server/public/dashboard.js` — la card de permiso prefiere
  `pendingPermission.summary` sobre `.command`, con el mismo fallback a
  `'(command unavailable)'` de antes.

### Deliberadamente NO tocado (y por qué)

- **`bridge/src/server/server.ts` `#sessionsPayload`**: el brief original
  pedía copiar `toolName`/`summary` al payload de sesión. Verificado que
  `#sessionsPayload` (línea 384-391) ya serializa la sesión completa
  (`out[id] = s`), no una proyección de campos — `pendingPermission` viaja
  entero, incluidos los campos nuevos de Task 2. No había nada que agregar.
- **`config.example.yaml` (templates de balloon)**: el brief sugería mover el
  balloon a `{tool}`. Verificado en `bridge/src/personality/interpolate.ts`
  que el interpolador **no tiene fallback**: una clave ausente del contexto
  se deja como literal (`{tool}` a secas) en vez de vaciarse o caer a otra
  clave — es deliberado (`interpolate.ts:8-11`, para que un bug de template
  sea visible). Como `permission_prompt` puede llegar sin un `PreToolUse`
  previo en la misma sesión (p. ej. vía `/sim/permission`, que no manda
  `tool_input`), cambiar el template a `{tool}` habría hecho que el balloon
  mostrara literalmente `"{tool}"` en ese caso. Los templates se dejan como
  `{command}` (que ya se enriquece con el comando real cuando `tool` existe).
  Mostrar el **nombre de la tool** en el balloon queda pendiente hasta que el
  interpolador soporte un fallback tipo `{tool|command}`.

### Verificación

- 532 tests verdes (53 archivos), typecheck limpio (`tsc --noEmit`).
- Cobertura existente a nivel de unidad ya ejercía el flujo completo:
  `bridge/test/claude-adapter.test.ts` ("enriches a permission with the
  preceding PreToolUse (Bash)" y "permission without a preceding PreToolUse
  behaves as before").
- **E2E en navegador: no concluyente por servidor obsoleto**, no por el
  código. El bridge corriendo en `localhost:1780` arrancó a las 17:16, antes
  del commit `548116b` (19:29) que introdujo el enriquecimiento — `tsx` no
  recarga en caliente, así que el proceso vivo ejecuta el `claude-adapter.ts`
  de antes de Task 1/2. Repetir el guión de curl del brief (`PreToolUse` con
  `tool_name: Bash`, `tool_input.command: git push origin main`, luego
  `Notification permission_prompt`) contra ese proceso deja
  `pendingPermission` sin `command`/`summary` — consistente con código viejo,
  no con un bug nuevo. No se reinició el servidor (fuera de alcance de esta
  tarea). Verificación E2E real queda pendiente del próximo reinicio del
  bridge.

### Decisiones

- Alcance de esta ronda: **solo enriquecimiento**, no relay, no
  AskUserQuestion Parte 2. Ambos quedan en la spec como trabajo futuro,
  bloqueados/diferidos por la razón de fase 0 de arriba.

---

## 2026-07-11 — Feature B: vida percibida (head-pet + idle micro-expresión)

### Qué se hizo

De `docs/superpowers/specs/2026-07-11-adopcion-firmware-original.md` (rev 3),
dos reacciones nuevas que hacen que el robot se sienta "vivo" sin agregar
tráfico BLE innecesario:

- **Caricia (`head_pet`)**: el gesto `pet` (device y `/sim/touch`) emite su
  propia categoría `head_pet` — no reutiliza `tap`/`swipe_*` — porque
  `stateRules` matchea por categoría, no por payload, y mezclar `pet` con los
  swipes de cabeza habría hecho que cualquier semántica futura de esos swipes
  compitiera con la caricia. La regla en `config.example.yaml` resuelve
  `{ emotion: HAPPY, decorators: [heart], leds: [] }` con un `ttlOverride`
  (`source: firmware, category: head_pet, ttl: 3s`) para que la reacción se
  retire sola. `pet` nunca aprueba un permiso — sigue siendo `tap` el único
  gesto con esa autoridad.
- **Micro-expresión idle**: un modifier cosmético (`idle-expression.mjs`) que
  hace un guiño asimétrico de un solo ojo cada pocos segundos, gated por
  `state.active === null` (la señal idle que el bridge ya manda en
  `#statePayload`). No es un `ResolvedState` — es puramente client-side,
  igual que blink/breath/saccade. Ver D30: emitirla server-side habría sido
  el mismo anti-patrón de firehose BLE que el council marcó para el
  face-mimic (C5).

### Archivos modificados

- `bridge/src/server/server.ts` — categoría `head_pet` en
  `handleDeviceInput` y `#handleSimTouch`.
- `config.example.yaml` — stateRule + `ttlOverride` para `head_pet`.
- `bridge/src/server/public/idle-expression.mjs` — modifier puro
  `(tickMs, face) => face`, con rng inyectado para tests determinísticos.
- `bridge/src/server/public/face-renderer.js` — `#idle`, `setIdle()`, el
  modifier agregado al array de modifiers.
- `bridge/src/server/public/dashboard.js` —
  `faceRenderer.setIdle(state.active == null)` en `renderState`.
- Tests: `bridge/test/server-touch.test.ts`, `bridge/test/attention.test.ts`,
  `bridge/test/integration-fase2.test.ts`, `bridge/test/idle-expression.test.ts`.

### Verificación

- Suite completa verde (tests nuevos de touch, attention, integración e
  idle-expression incluidos).
- Verificación en vivo del gating: con un evento real de alta prioridad
  activo (`context_high`), la caricia de baja severidad queda encolada
  detrás — el Attention Manager prioriza correctamente. Observación de
  producto (no bug): mientras hay trabajo urgente activo, una caricia física
  no da feedback inmediato — queda anotado, no es un defecto de esta tarea.

### Decisiones

- **`head_pet` como categoría propia** (no reutilizar `tap`/`swipe_*`):
  `stateRules` matchea por categoría, no por payload — ver Task 1, commit
  `93870e1`.
- **Idle híbrido, rev 3 del spec** (D30): el servidor sólo expone la señal
  de idle; la micro-expresión la corre el cliente/firmware como cosmético.
  Evita el firehose BLE que tendría emitirla como `ResolvedState`.
- **Deuda abierta** (D-17): ni el gesto `pet` ni la micro-expresión idle
  están validados contra el touch panel real del CoreS3 — Fase 0 lo resuelve.

**Commits**: `93870e1`..`766ca9f` (3 commits: gesture, idle module, wiring).

---

## 2026-07-19 — Bubble legible: separación de la boca, scroll y TTLs por prioridad

### Qué se hizo

Cuatro mejoras de presentación pedidas tras revisar el dashboard (cambios sin
commit aún, en working tree):

- **Bubble despegado de la boca** (`balloon-layout.mjs`): `tailLength` 12 → 28
  (antes quedaba a 8px de la boca cerrada y se solapaba con la boca abierta,
  que baja hasta y=177) y la punta de la cola ahora apunta al *borde inferior*
  de la boca (`tailTipOffset: 8` → y=156) en vez de a su centro, donde quedaba
  enterrada. Además la burbuja hereda el `breathY` de la cara (`dy` en
  `drawBalloon`), así la cola no se despega cuando el robot respira.
- **Scroll de texto en el bubble**: `layoutBalloon` ya no trunca a 2 líneas con
  "…" — devuelve todas las líneas (tope de seguridad `maxLines: 12`; el servidor
  ya trunca a 240 chars ≈ 8 líneas) y la ventana visible de `visibleLines: 2` se
  desliza con `scrollOffsetPx()`, función pura de `elapsedMs` (pausa inicial
  1.2s, desliz ease-out de 250ms por línea, pausa 800ms, pausa final 2.5s y
  vuelve al inicio). Clip al `roundRect` + pop de entrada de 180ms anclado a la
  punta de la cola.
- **TTLs monótonos con la severidad** (`config.example.yaml`, `config.yaml`,
  defaults de `schema.ts`): estaban invertidos (`critical: 30s` vs `low: 10m` —
  una notificación `low` podía ocupar la cara 10 minutos). Ahora
  `critical: 5m, high: 2m, medium: 1m, low: 30s, ambient: 15s`. Las dos
  categorías `critical` del adapter siguen con override infinito, así que el
  cambio de `critical` solo afecta a eventos externos (`POST /events`).
- **Dashboard reordenado** (`index.html`): el sidebar era Simulation → Face →
  Health → Attention; ahora es Face → Attention → Health → Simulation. Lo
  accionable queda junto a la cara y el tooling de dev al fondo.

### Decisiones

- **Divergencia consciente con el firmware**: el robot físico trunca a 2 líneas;
  el emulador ahora muestra todo el texto con scroll. El *wrap* (métrica
  k8x12-12) se mantiene idéntico y testeado — lo que cambia es solo la
  presentación. Si el scroll gusta, se porta al firmware en Fase 1B.
- El scroll es función pura para testearlo sin canvas (14 tests en
  `balloon-layout.test.ts`, 544/544 verde).

---

## 2026-07-19 (tarde) — Mejoras accionables: sonido crítico, response->response, teclado y TTL en cola

### Qué se hizo

Cuatro commits nuevos tras el filtro del usuario: cualquier acción o sonido
 debe poder ayudar y ser reproducible en el StackChan físico.

- **Sonido distinto para `permission_critical`** (`config.example.yaml` y test
  M13-7): un comando destructivo (`sudo rm -rf`, etc.) ya no suena como un
  permiso cualquiera (`permission`) sino como alarma (`error`). El firmware ya
  transporta `sound` en `ResolvedState` y tiene capacidad de audio (tono TTS
  en `stackchan/wasm/tone.ts`); este cambio solo cambia qué sonido se pide,
  no añade una capacidad nueva del emulador.
- **Response retira a la response anterior** (`claude-adapter.ts` + AM):
  ambas son `ambient`, así que sin esto una respuesta nueva se encolaba detrás
  de la anterior hasta 15s mostrando texto viejo de Claude. El `Stop` hook
  ahora emite `resolvesEventIds` (plural) para retirar, en un solo tiro, tanto
  su propio prompt (D-06) como la `lastResponseEventId` de la sesión. El AM
  acepta la lista. El sticky balloon sigue sobreviviendo al idle; solo lo
  reemplaza una respuesta más nueva.
- **Atajos de teclado A/B/C** (`dashboard.js` + `index.html`): espejan los
  botones físicos del CoreS3. `A` aprueba/denega un permiso pendiente, `B`
  lo contrario, `C` cambia de modo. Ignoran inputs y modificadores para no
  romper navegación o edición. Paridad con el robot, no divergencia.
- **TTL en la cola del Attention panel** (`attention.ts`, `server.ts`,
  `dashboard.*`): el snapshot del AM ahora incluye `deadline` en cada ítem
  encolado (igual que en el activo). El dashboard muestra la cuenta atrás al
  lado de cada evento en cola, para que el usuario vea qué va a morir sin
  mostrarse. El payload SSE cambia (`queue` pasa a `{event, deadline}[]`),
  pero el único consumidor es el dashboard.

### Decisiones

- **Divergencias cero con el hardware**: A, B, C y D son o bien cambios de
  protocolo (sound), lógica pura del servidor (resolvesEventIds, TTL en la
  cola) o espejo de botones físicos (teclado). Nada es cosmético del emulador
  que el robot no pueda reproducir.
- **D (TTL en cola) es observabilidad, no acción**: no está en el robot, pero
  tampoco promete una capacidad que el robot no tenga; solo da más contexto al
  dashboard. El usuario pidió ayuda, y ver el TTL ayuda a entender por qué
  desaparece algo.

### Commits

- `e9f0f1e` — Give destructive permissions the alarm sound
- `3207782` — Retire the previous response when a new one arrives
- `a95f53c` — Add keyboard shortcuts A/B/C mirroring the physical buttons
- `3548714` — Show each queue item remaining TTL in the Attention panel

---

## 2026-07-19 (noche) — Más mejoras accionables: thinking y doble toque destructivo

### Qué se hizo

Tres commits más, siguiendo el mismo filtro: la acción o sonido debe ser
reproducible en el robot físico.

- **Indicador "pensando"** (`face-renderer.js`, configs, test): el `prompt`
  ahora lleva el decorador `thinking` — tres puntitos rebotando cerca de la
  boca. Aparece mientras el prompt está activo y desaparece cuando la
  `response` lo retira. El decorador viaja en `ResolvedState`, así que el
  StackChan físico lo puede reproducir. Se añadió un TTL override de 2m para
  que no se apague en turnos largos (antes 15s).
- **Doble toque para permisos destructivos** (`server.ts`, `dashboard.js`,
  test): una cabezada (`tap`) aprueba un permiso normal de una vez; si el
  permiso es `critical` (comandos destructivos configurados en
  `criticalCommands`), la primera cabezada arma una guarda de 700ms y la
  segunda dentro de la ventana aprueba. El dashboard muestra "double-tap
  head to approve" en las tarjetas críticas. El simulador devuelve
  `pending_confirmation` en la primera cabezada para que el usuario sepa
  que debe repetir.

### Decisiones y deuda

- **3 fue fácilmente reproducible**: es solo un decorador más en el
  `ResolvedState` que ya existe.
- **1 tiene una pata fuera del bridge**: la lógica de doble toque corre en
  el servidor y funciona si el sensor de cabeza envía eventos `tap`. El
  firmware real hoy produce `press`/`release`/`forwardSwipe`/`backwardSwipe`
  (D-13), no `tap`. Así que este cambio prepara el bridge, pero la alineación
  del vocabulario del firmware sigue siendo deuda técnica. No añadí un botón
  de "double-tap" en el simulador: el usuario simula la acción real tocando
  dos veces el botón `tap` existente dentro de 700ms.

### Commits

- `34cef66` — Add thinking indicator during prompt-to-response gap
- `287a568` — Require double head-tap to approve destructive permissions

---

## 2026-07-20 (tarde) — Alinear vocabulario de cabeza con el firmware (D-13)

### Qué se hizo

Se retomó el trabajo interrumpido por corte de créditos y se completó la
alineación del vocabulario táctil de la cabeza entre el bridge y el firmware.

- **`server.ts`**: el `handleDeviceInput` de BLE ya no acepta `tap`/`hold`/
  `swipe_fwd`/`swipe_back` como gestos crudos. El firmware real solo envía
  `press`, `release`, `forwardSwipe`, `backwardSwipe` y `pet` (cuando lo
  soporta). El bridge ahora deriva `tap` (`press` + `release` dentro de 300ms)
  y `hold` (`press` ≥ 2000ms) localmente, de forma que el simulador y el robot
  comparten la misma lógica. El doble toque destructivo sigue funcionando sobre
  `press`/`release` derivados.
- **`dashboard.js`**: los botones de touch del emulador envían `press`/`release`
  en lugar de `tap`/`hold`, espejando exactamente lo que el CoreS3 reportaría.
  El botón "tap" ahora es un `press` de 50ms; "hold" se mantiene con
  `pointerdown`/`pointerup` y el servidor deriva el `hold` por duración.
- **`server-touch.test.ts`**: se reescribió el harness para devolver el servidor
  y sus dependencias, y los tests pasan a usar `press`/`release` para simular
  toques. Se añadió un test de `hold` → `SLEEP`.

### Decisiones y deuda

- **D-13 sigue abierta**: la lógica de tap/hold ahora vive en el bridge, pero
  el firmware todavía debe confirmar cuándo envía `press`/`release` y si el
  doble toque debe derivarse en el device en lugar de en el servidor. La
  alineación del vocabulario está hecha; la verificación real es Fase 1B.
- **No se tocó la asignación semántica de `forwardSwipe`/`backwardSwipe`**: el
  upstream ya los usa para caricias (HAPPY+corazón). Esa decisión se deja para
  Fase 0/Fase 1B.

### Commits

- `5956ca4` — Align head-touch vocabulary with firmware (`press`/`release`)

---

## 2026-07-20 (noche) — AskUserQuestion visible (Parte 2 de decisiones interactivas)

### Qué se hizo

Implementación de la **Parte 2** del spec de decisiones interactivas: hacer
visibles las preguntas de opción múltiple de Claude Code sin intentar responderlas
desde el robot (el bridge no puede responder `AskUserQuestion` en modo monitor).

- **`claude-adapter.ts`**: el `PreToolUse` de `AskUserQuestion` emite un evento
  `question` de severidad `medium` con `header`, `questions[]` y opciones (con
  descripciones truncadas a 80 chars). El `PostToolUse` de `AskUserQuestion`
  emite `question_resolved` con `resolvesEventId` y la respuesta elegida. `UserPromptSubmit`
  y `Stop` auto-resuelven la pregunta si sigue pendiente (el usuario contestó en
  el terminal). Se añadieron `question` y `question_resolved` a `CLAUDE_CATEGORIES`.
- **`server.ts`**: un tap en la cabeza con pregunta pendiente (y sin permiso
  pendiente) dispara `focusTerminal` hacia esa sesión. Nuevo endpoint
  `POST /focus/:sessionId` para el botón "Go to terminal" del dashboard.
- **`config.example.yaml` + `config.yaml`**: state rules para `question`
  (DOUBTFUL + `question_mark`) y `question_resolved` (HAPPY + clear balloon).
- **`face-renderer.js`**: nuevo decorator `question_mark` que dibuja una `?` azul.
- **`dashboard.js` + `dashboard.css`**: las tarjetas de sesión muestran la
  pregunta, las opciones y un botón "Go to terminal" cuando hay `pendingQuestion`.
- **Presets**: se añadieron templates `question`/`question_resolved` para todos
  los presets para mantener el contrato M13.
- **Tests**: `claude-adapter.test.ts` (5 tests), `question-resolve-chain.test.ts`
  (2 tests integración con AM), y `server-touch.test.ts` (tap con pregunta pendiente).

### Decisiones y deuda

- **No se implementó la Parte 1** (relay real de `PermissionRequest`): sigue
  bloqueada por el modo `bypassPermissions` de las sesiones actuales y porque
  requiere un hook que espere la respuesta del usuario. No se difirió más, se
  deja como trabajo futuro explícito.
- **No se añade sonido nuevo**: `question` reutiliza `notification` (ya está en el
  firmware) y `question_resolved` reutiliza `approve`. Nada que el robot no pueda
  reproducir.
- **D-15 (métrica de velocidad)**: `PermissionRequest` trae `pendingPromptAt`, pero
  como la Parte 1 sigue sin implementar, D-15 sigue diferida.

### Commits

- `f466748` — Make AskUserQuestion visible (read-only Part 2)

---

## 2026-07-20 (noche, segunda vuelta) — Limpieza de tests: unhandled rejection en #runScan

### Qué se hizo

Se corrigió el ruido de `Unhandled Rejection` que aparecía en casi todos los runs
 de `claude-adapter.test.ts` (y de vez en cuando en el suite completo).

- **`claude-adapter.ts`**: `#runScan` ahora usa `(await scanClaudeSessions(...)) ?? []`.
  El mock en tests devolvía `undefined` en algunos casos, y el código asumía que
  siempre recibía un array. Con el fallback vacío se comporta igual que "no hay
  sesiones nuevas" sin lanzar.

### Resultado

- `npx vitest run` → 56 archivos, 574 tests, **0 errores no manejados**.
- No cambia comportamiento en producción: `scanClaudeSessions` real devuelve array.

### Commits

- `abe7fcf` — Fix unhandled rejection when scanClaudeSessions returns undefined

---

## 2026-07-20 (noche, tercera vuelta) — D-12: trust-check filtra focus sin input humano

### Qué se hizo

Se implementó la **opción (a)** del fix propuesto en D-12: correlacionar el focus
transition hacia Claude con actividad real de input.

- **`bridge/src/adapters/trust-check.ts`**: `TrustCheckDeps` ahora acepta
  `secondsSinceLastInput()` y `inputThresholdSeconds`. `poll()` descarta un trust
  check cuando el último input real ocurrió hace más del umbral (default 1 s). Se
  añadió `secondsSinceLastInput()` que en macOS consulta
  `CGEventSourceSecondsSinceLastEventType` para eventos de teclado/mouse/scroll
  vía `python3` + ctypes; en otras plataformas o si falla, devuelve null y el
  comportamiento vuelve al pre-D12 (no filtra).
- **`bridge/src/index.ts`**: el adaptador de producción se inicializa con el helper
  de input real.
- **`bridge/test/trust-check.test.ts`**: 3 tests nuevos para (1) no contar sin input
  reciente, (2) contar con input reciente, (3) fallback a contar cuando el helper
  no está disponible.
- **`DEBT.md`**: D-12 se actualiza: fix implementado, queda calibrar el umbral con
  datos reales antes de Gate 1.

### Resultado

- `npx vitest run` → 56 archivos, 577 tests, 0 errores.
- El trust-check deja de inflarse por auto-focus de Claude/Chrome; ahora solo
  cuenta cuando un humano tocó teclado/mouse justo antes de la transición.

### Commits

- `59c213c` — Filter trust-check by real input activity (D-12)

---

## Pendientes inmediatos

- [ ] Push a GitHub (20 commits ahead de `origin/main`)
- [x] Checklist §8.1 completo (2026-07-10). El paso 11 estaba mal escrito y se
      corrigió en la spec.
- [ ] Fase 3 (Calendar → GitHub → Jira). El OAuth de los MCP necesita una sesión
      interactiva.
- [ ] Fase 0: ejecutar cuando llegue el hardware (NOTES.md tiene el template)
- [ ] Fase 1B: BLE real con noble + CoreS3
- [ ] Gate 1: 3 semanas de uso real del MVP (criterios en ROADMAP.md)

[DEBT.md](DEBT.md) queda con varias entradas abiertas: D-03 (decisión pendiente
sobre `pulse`), D-10 (medición de latencia del firmware), D-12 (trust-check), D-13
(verificación real del vocabulario táctil), D-15 (métrica de velocidad), D-16
(balloon del emulador vs firmware), D-17 (`pet`/idle sin hardware) y D-18
(caricia perdida cuando el AM está ocupado).

