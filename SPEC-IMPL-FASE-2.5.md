# SPEC-IMPL-FASE-2.5 — Plan de ejecución

**Spec funcional**: [SPEC-FASE-2.5.md](SPEC-FASE-2.5.md). **Rev. 2** (post-council).
**Milestones**: M12a → M17. **Base**: 254 tests verdes al arrancar.

---

## 0. Reglas de ejecución

- **Un milestone = un commit** (`M12a: …`). Imperativo, cuerpo explica el porqué.
  Nunca `Co-Authored-By`.
- **Orden TDD por módulo**: escribir el test, verlo fallar, implementar, verde.
  Los tests enumerados **son el criterio de done**, no una sugerencia.
- **Nada se pushea sin autorización explícita.** Los commits quedan locales.
- Al cerrar cada milestone: `npm test` (todos verdes), `npx tsc --noEmit` (0
  errores), `npx biome check` sobre los archivos tocados (0 errores).
- **Regresión**: los 254 tests de Fase 2 no se rompen. Si un test viejo falla, se
  arregla el código o se justifica el cambio de contrato en el commit — no se
  borra el test.

---

## 1. Hallazgos verificados que condicionan el plan

**Leer antes de empezar M12a.** Los tres primeros se confirmaron ejecutando el
bridge, no leyendo el código.

### 1.1 El bug que M12 despierta *(verificado, 2026-07-09)*

Con `ttlBySeverity.critical: 5s` y `ttlOverrides: []`, un permiso expiró y el
`AttentionManager` ascendió otro evento de la cola **sin publicar nada al bus**:

```
am_decision  action=expired   eventId=019f49bd    ← el permiso
state_change to.emotion=NEUTRAL  eventId=019f49bc ← otro evento, ascendido
```

Tres caminos hacen esto: `attention.ts:190-193` (TTL), `:91-94` (modo),
`:280-283` (watchdog). Si el balloon heredara en silencio, el texto del permiso
quedaría bajo un evento sin relación. **De ahí sale `balloonPolicy` (S2.5.2).**

### 1.2 `PersonalityManager.balloon()` nunca devolvió un string *(verificado)*

En la misma traza, la columna `balloon` dice `None` incluso en el `state_change`
del permiso. `personality.ts:31` busca `templates['permission']`; los presets
definen `permission.pending`. Intersección vacía con las 6 categorías emitidas.

M13 no es "agregar templates", es **reconciliar el naming** (S2.5.8) y blindarlo
con un test de contrato.

### 1.3 `if (balloon)` no distingue "sin template" de "limpiar"

`""` es falsy (`state-machine.ts:130`). `balloon()` debe devolver `string | null`
y el llamador chequear `!== null` (S2.5.10).

### 1.4 Dos fuentes de balloon compiten en el servidor

- `rule.state.balloon` — literal, **no interpolado** hoy.
- `personality.balloon(category)` — interpolado, **pisa** al anterior (`:130`).

D28 dice que la personalidad es la capa de expresión. Se resuelve en S2.5.9: la
personalidad gana el **texto**; la regla gana la **política**.

### 1.5 `notifyState` recibe dos formas distintas

`StateMachine.emit` manda un `ResolvedState` crudo; `#handleSimMode` y
`#handleSimTouch` mandan `{resolvedState, mode}`. Hay un wrapper defensivo en
`server.ts:201`. **Se arregla en el llamador, sin tocar la firma de `emit`**
(S2.5.15) — el transporte BLE necesitará el estado empujado.

---

## 2. M12a — Política de balloon en el `StateMachine`

**Objetivo**: la política completa, con unit tests puros. **No se toca el
dashboard.** Nadie ve nada. Es la pieza que si sale mal, sale mal en silencio.

**Si M12a no está verde, M12b no se toca.**

### 2.1 Tipos

`src/core/state-machine.ts`:

```ts
export type BalloonPolicy = 'sticky' | 'transient';

export interface StateRule {
  match: StateRuleMatch;
  /** Política del bridge, NO se envía al firmware (S2.5.12). Default: transient. */
  balloonPolicy?: BalloonPolicy | undefined;
  state: Partial<ResolvedState> & { emotion: ResolvedState['emotion'] };
}

interface Balloon { text: string; policy: BalloonPolicy }
```

`ResolvedState.balloon` pasa de `string | undefined` a **siempre presente** en lo
emitido (S2.5.11). El tipo puede seguir siendo opcional; el `StateMachine`
garantiza la presencia.

### 2.2 `src/personality/interpolate.ts` (nuevo)

Extraer la interpolación de `personality.ts` para que el `StateMachine` la reuse
sin importar el manager.

```ts
export function interpolate(template: string, ctx: Record<string, string>): string;
export function truncate(text: string, max: number): string;   // sufijo '…'
```

### 2.3 `src/personality/personality.ts`

```ts
balloon(category: string, context?: Record<string, string>): string | null {
  const template = this.#customTemplates[category] ?? this.#preset.templates[category];
  if (template === undefined) return null;   // ← S2.5.10: distingue de ""
  return interpolate(template, context ?? {});
}
```

### 2.4 `src/core/state-machine.ts`

**Contexto de interpolación** (S2.5.6) — reemplaza el objeto fijo de `:125-129`:

```ts
function templateContext(e: Event): Record<string, string> {
  const ctx: Record<string, string> = {};
  for (const [k, v] of Object.entries(e.payload)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      ctx[k] = String(v);
    }
  }
  ctx.project = typeof e.payload.cwd === 'string' ? (e.payload.cwd.split('/').pop() ?? '') : '';
  ctx.session = typeof e.payload.sessionId === 'string' ? e.payload.sessionId.slice(0, 8) : '';
  return ctx;
}
```

**Resolución del balloon** (S2.5.2, S2.5.9, S2.5.13):

```ts
#resolveBalloon(rule: StateRule | undefined, e: Event): Balloon {
  const ctx = templateContext(e);
  let raw: string | undefined = rule?.state.balloon;                 // default estructural
  const fromPersonality = this.#personality?.balloon(e.category, ctx) ?? null;
  if (fromPersonality !== null) raw = fromPersonality;               // S2.5.9; "" limpia

  if (raw === undefined) return { ...this.#balloon };                // hereda texto Y política
  return {
    text: truncate(interpolate(raw, ctx), this.#balloonMaxChars),    // S2.5.13
    policy: rule?.balloonPolicy ?? 'transient',
  };
}
```

**Background mood** (S2.5.2):

```ts
#backgroundMood(): { state: ResolvedState; balloon: Balloon } {
  const balloon: Balloon =
    this.#balloon.policy === 'sticky' ? this.#balloon : { text: '', policy: 'transient' };
  const emotion = this.#personality?.idleEmotion() ?? 'NEUTRAL';
  return { state: { emotion, decorators: [], leds: [], balloon: balloon.text }, balloon };
}
```

**`set_face` y `forceSafeState`** (S2.5.14):

```ts
// dentro de #resolve, override de mcp:set_face:
if (e.source === 'mcp:set_face' && typeof e.payload.emotion === 'string') {
  state.emotion = e.payload.emotion as Emotion;
  balloon = {
    text: typeof e.payload.balloon === 'string' ? e.payload.balloon : '',   // nunca hereda
    policy: 'transient',
  };
}

forceSafeState(): void {
  this.#balloon = { text: '', policy: 'transient' };
  this.#transition({ ...BACKGROUND_MOOD, balloon: '' }, undefined);
}
```

**`apply()` asigna `#balloon` antes de `#transition`.** Crítico: si `statesEqual`
corta la transición, la *política* igual debe actualizarse. Dos reglas con el
mismo texto y distinta política, si no se asigna antes, dejarían la política vieja.

```ts
apply(input: ActiveAttention | null): void {
  const isCritical = input !== null && input.event.severity === 'critical';
  this.#recordCriticalSample(isCritical);
  this.#lastSeverity = input?.event.severity;

  const { state, balloon } = input ? this.#resolve(input.event) : this.#backgroundMood();
  this.#balloon = balloon;                    // ← antes del early-return de #transition
  this.#transition(state, input?.event.id);
}
```

### 2.5 Tests obligatorios

`test/balloon-policy.test.ts` (nuevo). Los 4 primeros son los que exigió el
council: **rojos antes del fix.**

| # | Test | Expected |
|---|------|----------|
| 1 | `transient` con balloon → `tick()` lo expira → `apply(null)` | `balloon === ''` |
| 2 | `transient` con balloon → `setMode('SLEEP')` lo descarta → `apply(null)` | `balloon === ''` |
| 3 | `sticky` con balloon → `apply(null)` | el balloon sobrevive |
| 4 | `sticky` → evento con regla sin balloon | hereda texto **y** política `sticky` |
| 5 | `transient` → evento con regla sin balloon → `apply(null)` | `balloon === ''` (heredó `transient`) |
| 6 | **El bug de §1.1**: `transient` expira, se promueve otro evento sin balloon | `balloon === ''`, no el del permiso |
| 7 | Regla define `balloon` → reemplaza | el texto nuevo |
| 8 | `balloon: ""` en la regla → limpia | `balloon === ''` |
| 9 | Template de personality pisa a la regla (S2.5.9) | el del preset |
| 10 | Template `""` limpia aunque la regla tenga texto | `balloon === ''` |
| 11 | Sin template ni regla → hereda | el anterior |
| 12 | La política **siempre** viene de la regla, nunca del preset | preset con texto + regla `sticky` → `sticky` |
| 13 | Dos estados que solo difieren en balloon **sí** transicionan | `emit` llamado 2 veces |
| 14 | Interpola cualquier campo del payload | `"[{project}] {text}"` → `"[proj] ok"` |
| 15 | Trunca al `balloonMaxChars` | length ≤ 240, termina en `…` |
| 16 | El truncado respeta el prefijo interpolado (S2.5.13) | `[proj]` sobrevive |
| 17 | El `ResolvedState` emitido siempre tiene `balloon: string` | primera emisión → `''` |
| 18 | `set_face` sin balloon **limpia** (S2.5.14) | `balloon === ''` |
| 19 | `set_face` con balloon lo usa, política `transient` | texto, y muere al idle |
| 20 | `forceSafeState()` limpia y resetea la política | `balloon === ''`, `sticky` previo descartado |
| 21 | Política actualizada aunque `statesEqual` corte la transición | `sticky`→`transient` mismo texto → al idle, limpia |

**El #6 y el #21 son los que valen.** El #6 es el bug verificado. El #21 es el que
nadie escribiría sin haber pensado en el early-return.

### 2.6 Done

`npm test` verde (254 + 21). `tsc --noEmit` limpio. **El dashboard sigue
funcionando exactamente igual que antes** — no lo tocamos. Verificable: abrir el
emulador, disparar un permiso, el balloon aparece (dibujado por el cliente).

---

## 3. M12b — El dashboard pasa a renderer tonto

**Depende de**: M12a verde. Reversible con un `git revert`.

### 3.1 `src/index.ts`

```ts
emit: (state) => { transport.send(state); server.notifyState(); }   // S2.5.15
```

Se borra el wrapper defensivo de `notifyState` (`server.ts:201`), que existía solo
para tolerar las dos formas.

### 3.2 `src/server/public/dashboard.js`

**Se elimina:**
- `updateScreenInfo()` y su `setInterval(…, 12000)`.
- `lastScreenInfoKey`.
- `permissionBalloonText()`.
- Las llamadas a `showBalloon` en `renderSessions` y `addEvent`.
- El `balloonTimer` / `durationMs` de `showBalloon`.

**Queda:**

```js
function renderState(state) {
  const rs = state.resolvedState;
  if (!rs) return;
  if (rs.emotion) faceRenderer.setEmotion(rs.emotion);
  if (rs.decorators) faceRenderer.setDecorators(rs.decorators);
  faceRenderer.setBalloon(rs.balloon || null);   // ← única llamada en todo el archivo
  renderLeds(rs.leds);
  …
}
```

`sessionLabel` / `sessionName` se conservan: las **cards** los necesitan. Solo el
balloon deja de usarlos.

### 3.3 Verificación

Manual, en el emulador. `grep -c 'setBalloon' dashboard.js` → **1**.

Con las `stateRules` actuales (sin las de M13), el balloon estará vacío para casi
todo. **Eso es esperado**: el servidor todavía no tiene templates. Es la ventana
incómoda entre M12b y M13, y es la razón de que M13 venga inmediatamente después.

### 3.4 Done

El emulador no muestra balloons (salvo los que las reglas viejas produzcan). El
`GET /state` es la única verdad. Un `git revert` restaura el comportamiento
anterior si algo se ve mal.

---

## 4. M13 — Categorías, `stateRules`, sonidos y templates

**Depende de**: M12b. Cierra la ventana abierta en §3.3.

### 4.1 `src/adapters/claude-adapter.ts` (S2.5.8)

```ts
/** Categorías con severity 'critical'. Consumida por el guard test de TTL. */
export const CLAUDE_CRITICAL_CATEGORIES = ['permission', 'permission_critical'] as const;

/** Todas las categorías que este adapter puede emitir. Consumida por el test de contrato. */
export const CLAUDE_CATEGORIES = [
  'prompt', 'response', 'permission', 'permission_critical',
  'permission_resolved', 'notification', 'subagent',
] as const;
```

En el case `Notification` / `permission_prompt`:

```ts
const isCritical = command
  ? this.#deps.criticalCommands.some((c) => command.includes(c))
  : false;
const event = newEvent({
  source: 'claude',
  category: isCritical ? 'permission_critical' : 'permission',   // ← S2.5.8
  severity: 'critical',
  payload: { sessionId, cwd: session.cwd, ...(command !== undefined ? { command } : {}), isCritical },
});
```

`payload.isCritical` se mantiene: `dashboard.js:253` lo usa para el `⚠`.

### 4.2 `config.yaml` + `config.example.yaml`

Las `stateRules` de la §9 de la spec funcional, tal cual. **Y el override que
cierra el filo:**

```yaml
attentionManager:
  ttlOverrides:
    - { source: claude, category: permission,          ttl: infinite }
    - { source: claude, category: permission_critical, ttl: infinite }
```

`grep -c pulse config.yaml` debe dar **0** (S2.5.16).

### 4.3 `src/config/schema.ts`

- `StateRuleSchema` gana `balloonPolicy: z.enum(['sticky','transient']).optional()`
  como **hermano de `state`**, no dentro (S2.5.12).
- `personality.balloonMaxChars: z.number().int().positive().default(240)`.
- `LedCommandSchema.pattern`: `z.string()` → `z.enum(['solid','blink','rainbow','off'])`
  (S2.5.16). Hoy acepta cualquier string y un typo pasa silencioso.

### 4.4 `presets/personalities/*.yaml` (los 4)

Claves alineadas con `CLAUDE_CATEGORIES`. **Se renombran** `permission.pending` →
`permission` y `permission.critical` → `permission_critical`. Las claves viejas se
borran.

Cada preset declara además su lista de silencio deliberado, consumida por el test
de contrato:

```yaml
name: companion
silentCategories: [prompt, subagent, notification]   # ← ausencia intencional, no olvido
templates:
  permission: "{project}: {command}"
  permission_critical: "{project}: ⚠ {command}"
  permission_resolved: ""
  response: "[{project}] {text}"
  error: "✕ {message}"
```

### 4.5 Tests obligatorios

| # | Test | Expected |
|---|------|----------|
| 1 | Comando crítico emite `permission_critical` | `category === 'permission_critical'` |
| 2 | Comando normal emite `permission` | `category === 'permission'` |
| 3 | `payload.isCritical` sigue presente en ambos | `true` / `false` |
| 4 | **Guard de TTL (S2.5.8)**: para toda categoría de `CLAUDE_CRITICAL_CATEGORIES`, `#computeDeadline()` devuelve `null` | itera el array; falla si alguien agrega una categoría sin override |
| 5 | **Contrato template↔categoría (S2.5.8)**: para toda categoría de `CLAUDE_CATEGORIES` × cada preset, `balloon(cat)` devuelve string **o** la categoría está en `silentCategories` | 7 × 4 = 28 aserciones |
| 6 | `permission_resolved` limpia el balloon | `balloon === ''` |
| 7 | Cada categoría produce un `sound` distinto | permission / notification / error |
| 8 | `subagent` no produce sonido | `sound === undefined` |
| 9 | `pattern` inválido falla la validación de config | `pattern: 'pulse'` → zod error |
| 10 | `mascot` no pone texto en `response` | `balloon === ''` |
| 11 | `response` interpola `{text}` y es `sticky` | `'[p] listo'`, sobrevive al idle |
| 12 | `balloonPolicy` fuera de `state` no llega al `ResolvedState` | `'balloonPolicy' in resolvedState === false` |

**El #4 y el #5 son la razón de ser de este milestone.** Sin ellos, S2.5.8
reintroduce el bug de §1.1 y §1.2 la próxima vez que alguien renombre algo.

### 4.6 Done

En el emulador: un permiso crítico y uno benigno producen LED, cara, sonido y
texto distintos. El balloon vuelve a aparecer, ahora desde el servidor.

---

## 5. M14 — SSE enriquecido, panel de Attention, badge de modo

**Depende de**: M12b.

### 5.1 `src/server/server.ts`

```ts
#statePayload() {
  const snap = this.#opts.attentionManager.snapshot();
  return {
    resolvedState: this.#opts.stateMachine.current(),
    mode: snap.mode,
    active: snap.active,          // { event, deadline } | null
    queue: snap.queue,            // Event[]
  };
}
notifyState(): void { this.#broadcast('state', this.#statePayload()); }
```

`#handleState` y `#handleStream` reusan `#statePayload()`. `#handleSimMode` y
`#handleSimTouch` dejan de construir el payload a mano.

### 5.2 UI

Panel **Attention** en la sidebar, bajo Health:

```
ACTIVE   ⚠ critical · permission_critical · claude · ∞
QUEUE (2)
  · high    · error     · github  · 1m54s
  · ambient · response  · claude  · 22s
```

`deadline: null` se pinta como `∞`. El contador se refresca en el cliente cada 1 s
(solo la cuenta regresiva; el dato viene del servidor).

Badge de **modo** con leyenda:

| Modo | Leyenda |
|---|---|
| NORMAL | "todo pasa" |
| FOCUS | "solo critical + high" |
| SLEEP | "solo critical" |

### 5.3 Tests obligatorios

| # | Test | Expected |
|---|------|----------|
| 1 | SSE `state` incluye `active` y `queue` | `queue.length === 1` tras 2 pushes |
| 2 | SSE `state` incluye `mode` | `'FOCUS'` tras `/sim/mode` |
| 3 | `GET /state` y SSE `state` coinciden | mismo `resolvedState` |
| 4 | `emit(state)` conserva su firma (S2.5.15) | `transport.send` recibe el estado |
| 5 | `active: null` cuando la cola se vacía | tras resolve + `tick()` |
| 6 | `deadline: null` se serializa para el permiso | `active.deadline === null` |

### 5.4 Done

`Fake permission prompt` muestra el evento en `ACTIVE` con `∞`. `Cycle mode` a
FOCUS y pushear un `ambient` → no entra a la cola.

---

## 6. M15 — Historial de balloons y agrupación de eventos

**Depende de**: M12a (el `StateMachine` es quien alimenta el historial).

### 6.1 `src/core/balloon-history.ts` (nuevo)

Interfaz en §6 de la spec funcional. Se llena desde `StateMachine.#transition`
cuando el balloon efectivo cambia. Inyectado como dep opcional para no acoplar.

### 6.2 `GET /balloons`

Devuelve `recent()`. Sin auth (localhost, no destructivo — D26).

### 6.3 Agrupación de eventos (cliente)

`addEvent` compara con la primera fila de la lista. Si `source + category +
severity` coinciden, incrementa `×N` en vez de prepender.

**No** toca el `EventBus`: su dedup por hash es semántico (mismo payload) y ya
existe. Esto es puramente visual.

### 6.4 Tests obligatorios

| # | Test | Expected |
|---|------|----------|
| 1 | Guarda hasta `capacity` | 15 push, cap 10 → 10 |
| 2 | El más nuevo va primero | `recent()[0]` |
| 3 | No duplica el mismo texto consecutivo | 1 entrada |
| 4 | Ignora `""` | 0 entradas |
| 5 | Guarda el `eventId` | `'e1'` |
| 6 | `GET /balloons` devuelve el historial | array de 2 |
| 7 | Un cambio de balloon alimenta el historial | `push` llamado |
| 8 | Un estado sin cambio de balloon no lo alimenta | `push` llamado 1 vez tras 2 `apply` iguales |
| 9 | Un `transient` que se limpia **no** guarda `""` | el `""` no entra al historial |

---

## 7. M16 — Replay por HTTP

**Depende de**: M14 (para ver el efecto). **Gated por `--simulate`.**

### 7.1 `POST /replay`

```ts
// body: { file?: string, lastN?: number, instant?: boolean }
```

**Seguridad (S2.5.7)**, en este orden:

1. `!this.#opts.simulate` → `403 {error:'replay disabled in production'}`.
2. `path.resolve(recorderDir, file)`; rechazar con `400` si
   `!resolved.startsWith(recorderDir + path.sep)`.
3. Sin `file`, usa el ndjson del día.

Reusa `replay(file, bus, opts)` sin cambios.

**Cuidado**: activar `recorder.setReplayMode(true)` durante el replay y
desactivarlo en un `finally`, o el ndjson del día se contamina con eventos falsos
indistinguibles de los reales.

### 7.2 UI

Botón "Replay today" en el panel Simulation + `<input type=number>` para `lastN`
(default 20). Feedback: `{published, skipped}`.

### 7.3 Tests obligatorios

| # | Test | Expected |
|---|------|----------|
| 1 | `403` sin `--simulate` | 403 |
| 2 | Path traversal rechazado | `file: '../../etc/passwd'` → 400 |
| 3 | **Symlink que escapa** el recorder dir | 400 *(fixture con symlink real; `path.resolve` no lo detecta)* |
| 4 | Sin `file` usa el ndjson del día | `published: 3` |
| 5 | `lastN` limita | `published: 3` de 10 |
| 6 | Los eventos re-publicados llevan `replay: true` | línea del recorder |
| 7 | `setReplayMode(false)` se restaura si `replay()` tira | modo off tras el error |

*(El test #3 de la rev. 1 — `file: 'a/../../x'` — se borró: `path.resolve`
normaliza y lo hace idéntico al #2. El traversal real que `resolve` no atrapa es
el symlink.)*

---

## 8. M17 — Integración y verificación

**Depende de**: M12a–M16.

### 8.1 Checklist manual (emulador, `--simulate`)

| # | Paso | Esperado |
|---|---|---|
| 1 | Prompt real desde otra sesión de Claude | balloon **no** cambia (regla sin balloon → hereda) |
| 2 | Llega la respuesta | `[proyecto] texto…` completo hasta 240 chars |
| 3 | Esperar 60 s sin actividad | el balloon **sigue** (política `sticky`) |
| 4 | `Fake permission prompt` con `rm -rf` | `⚠ rm -rf`, LED izq rojo blink, DOUBTFUL, sonido `permission` |
| 5 | Aprobar **desde el chat de Claude**, no del dashboard | `PostToolUse` → balloon limpio, LED verde, sonido `approve` |
| 6 | **Quitar el `ttlOverride` de `permission`, bajar `ttlBySeverity.critical` a 5 s, disparar un permiso benigno** | a los 5 s el balloon se limpia solo *(el bug de §1.1, ahora cubierto)*. **Ojo**: sin quitar el override el permiso benigno tampoco expira — el paso decía "bajar el TTL" a secas y era irreproducible, porque S2.5.8 le dio TTL infinito a las DOS categorías de permiso. Revertir el config al terminar |
| 7 | `Cycle mode` → FOCUS, luego una respuesta | balloon **no** cambia (ambient filtrado); la card **sí** |
| 8 | En FOCUS, disparar un permiso | pasa (critical), balloon cambia |
| 9 | `Cycle mode` → SLEEP con un permiso activo | pasa (critical); un `error` de severity `high` no |
| 10 | `POST /events` × 5 idéntico | una fila `×5` |
| 11 | Crítico mientras hay balloon de respuesta | preempta. Al resolverse el crítico, la `response` **sí** vuelve si su TTL no expiró: `attention.ts:149` re-encola el evento preemptado, y un evento todavía vivo merece la pantalla. Lo que no existe es un *stack de balloons* — el balloon sigue al `active`, nunca se apila |
| 12 | Panel Attention | `active` con `∞`, `queue` con los encolados |
| 13 | Screen history | los últimos 10, más nuevo arriba |
| 14 | `Replay today` | los eventos re-corren; el ndjson marca `replay: true` |

**El paso 6 es la verificación de que el council valió la pena.** Antes del fix,
ese balloon quedaba pegado indefinidamente.

**El paso 11** no es una pérdida de información: es un cambio de ubicación (§12 de
la spec funcional). La redacción original decía que la `response` "no vuelve", y
es falso: el AM re-encola lo que preempta. Verificado en vivo el 2026-07-10, con
el AM recién arrancado — un primer intento midió sobre un `error` de `high` que
seguía activo con 2 min de TTL, y confundió su balloon con el de la `response`.
Para verificar preemption hay que partir de una cola vacía.

### 8.2 Tests de integración

`test/integration-fase2.5.test.ts`:

| # | Test |
|---|------|
| 1 | Ciclo completo: prompt → response → el balloon persiste tras idle |
| 2 | permission preempta response; al resolverse, limpia |
| 3 | permission expira por TTL; el balloon se limpia aunque se promueva otro evento |
| 4 | En FOCUS, un `ambient` no llega al `StateMachine` |
| 5 | ~~Hot-reload de `config.yaml` cambia `stateRules` sin reiniciar~~ — **nunca se escribió**. El E2E-5 real cubre `BalloonHistory` |
| 6 | ~~Hot-reload que cambia `balloonPolicy` de `sticky` a `transient` surte efecto~~ — **nunca se escribió**. El E2E-6 real cubre el silencio del preset `mascot` |

**Los dos tests de hot-reload que esta tabla prometía nunca se escribieron**
(constatado el 2026-07-10). La cobertura real vive en `config-loader.test.ts`, que
escribía siempre con `writeFileSync` — in-place, mismo inodo — y por eso pasaba
sobre el único camino que funcionaba, mientras el guardado atómico dejaba el
watcher huérfano para siempre. Ese era D-07, ya resuelto: el loader vigila el
directorio, y hay un test que hace un `rename` real y exige que un **segundo**
cambio posterior también recargue.

### 8.3 Docs

- `DECISIONS.md`: agregar S2.5.1–S2.5.16.
- `DEVLOG.md`: entrada de la fase, incluyendo el experimento de §1.1.
- `ROADMAP.md`: **Fase 4 conserva D14**; anotar que su seam
  (`StateMachine.#backgroundMood()`) quedó expuesto por M12a, y el criterio de
  retomada de S2.5.5.
- `README.md`: el diagrama de flujo de datos.
- **Issue aparte** (no en este PR): `statesEqual` usa `JSON.stringify`
  (`state-machine.ts:46`); el orden de claves depende de qué ramas de `#resolve`
  corrieron.

---

## 9. Dependencias entre milestones

```
   M12a (política, core, sin UI)
     │
     ├──────────────┐
     ▼              ▼
   M12b          M15 (history)
     │              │
     ├──────┐       │
     ▼      ▼       │
   M13    M14       │
            │       │
            ▼       │
          M16       │
            └───┬───┘
                ▼
               M17
```

M12a es el cuello de botella y el único milestone con riesgo real. M13 debe seguir
a M12b lo antes posible: entre ambos hay una ventana donde el emulador casi no
muestra balloons (§3.3).

---

## 10. Archivos por milestone

| M | Nuevos | Modificados |
|---|---|---|
| M12a | `personality/interpolate.ts`, `test/balloon-policy.test.ts` | `core/state-machine.ts`, `personality/personality.ts` |
| M12b | — | `index.ts`, `server/server.ts`, `server/public/dashboard.js` |
| M13 | — | `adapters/claude-adapter.ts`, `config/schema.ts`, `config.yaml`, `config.example.yaml`, `presets/personalities/*.yaml` (4), `test/claude-adapter.test.ts`, `test/attention.test.ts`, `test/personality.test.ts` |
| M14 | `test/server-attention.test.ts` | `server/server.ts`, `index.ts`, `server/public/{dashboard.js,index.html,dashboard.css}` |
| M15 | `core/balloon-history.ts`, `test/balloon-history.test.ts` | `core/state-machine.ts`, `server/server.ts`, `server/public/dashboard.js` |
| M16 | `test/server-replay.test.ts` | `server/server.ts`, `server/public/{dashboard.js,index.html}` |
| M17 | `test/integration-fase2.5.test.ts` | `DECISIONS.md`, `DEVLOG.md`, `ROADMAP.md`, `README.md` |

---

## 11. Referencias auditadas

Evidencia de código, no README.

| Fuente | Ruta | Qué aporta | Veredicto |
|---|---|---|---|
| `AttentionManager` propio | `bridge/src/core/attention.ts:106-148`, `:190-193`, `:91-94`, `:280-283` | Preemption por severidad, TTL, `drop_worst`. **Y las tres vías de limpieza silenciosa.** | Es la razón de S2.5.1 *y* de S2.5.2 |
| `stack-chan` LED API | `firmware/stackchan/led/led.ts:60-140` | `on`, `off`, `blink`, `rainbow`. **`pulse` no existe.** | Fija el enum de M13.3 (S2.5.16) |
| `stack-chan` speech balloon | `firmware/stackchan/renderers-piu/effects/speech-balloon.ts:1-239` | `countWrappedLines()` mide glifos con `k8x12-12` | El wrap lo hace el firmware ⇒ el bridge trunca por chars (S2.5.4) |
| `claude-desktop-buddy` | `REFERENCE.md:1-225` | Heartbeat BLE con **un solo campo `msg`** de texto | Valida S2.5.11 (el firmware espera un balloon resuelto) y §12 (no hay stack) |
| `sound-engine` propio | `bridge/src/server/public/sound-engine.js:1-33` | 13 tonos: `tap, swipe, hold, buttonA/B/C, approve, deny, permission, notification, modeChange, error` | Las `stateRules` de M13 solo pueden usar estos nombres |

**Lo que NO se encontró en ningún repo referencial**: un sistema de mood con decay
temporal. Es parte de por qué D14 se devolvió a Fase 4 (S2.5.5) — no hay prior art
que reduzca su riesgo, y hoy no hay inputs que lo alimenten.
