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

## Pendientes inmediatos

- [ ] Push a GitHub (16 commits + todo Fase 2.5)
- [ ] Fase 0: ejecutar cuando llegue el hardware (NOTES.md tiene el template)
- [ ] Fase 1B: BLE real con noble + CoreS3
- [ ] Gate 1: 3 semanas de uso real del MVP (criterios en ROADMAP.md)
