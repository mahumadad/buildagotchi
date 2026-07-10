# SPEC-FASE-2.5 — Expresión y observabilidad

**Estado**: aprobada con cambios por el council (2026-07-09). Rev. 2.
**Depende de**: Fase 2 completa (M6–M11, 254 tests).
**Ancla**: [DECISIONS.md](DECISIONS.md) — D3, D9, D15, D23, D26, D28.
**Hardware**: no requerido. Todo verificable en `--simulate` + emulador web.

---

## 0. Por qué esta fase existe

Fase 2 dejó el MVP funcionando, pero con una deuda arquitectónica que no se ve
hasta que llega el hardware: **el dashboard decide qué muestra la pantalla**.

Hoy hay cuatro escritores compitiendo por el mismo balloon:

| Escritor | Archivo | Cuándo |
|---|---|---|
| `renderState` | dashboard.js:164 | llega `ResolvedState` con `balloon` |
| `renderSessions` | dashboard.js:219 | hay `pendingPermission` |
| `addEvent` | dashboard.js:328 | evento con severity ≠ ambient |
| `updateScreenInfo` | dashboard.js:520 | timer cada 12 s |

Ninguno sabe de los otros. De ahí salieron los bugs que cazamos a mano: un
prompt nuevo borraba el mensaje persistente; el balloon del servidor pisaba el
de permiso; el texto se truncaba a 25 caracteres sin razón.

El punto que decide el diseño: **`updateScreenInfo` no puede correr en el
CoreS3.** El firmware Moddable recibe un `ResolvedState` por BLE y lo pinta. Toda
lógica de "qué mostrar" que viva en el browser hay que reescribirla en Fase 1B, y
las dos copias van a divergir.

Y hay una ironía: el `AttentionManager` **ya resuelve** el problema de prioridad
que el dashboard resuelve mal. Tiene cola priorizada por severidad, TTL con
overrides, preemption, filtrado por modo y drop-on-mode-change. Está construido,
testeado, y el balloon lo ignora.

Esta fase no agrega capacidades nuevas al robot. **Cablea las que ya tiene**, y
paga la deuda antes de que Fase 3 le sume cinco adapters encima.

> **Alcance verificado.** El único milestone que agregaba una capacidad nueva
> (Metabolic State, D14) fue devuelto a Fase 4 tras el fallo del council. Ver
> S2.5.5. La declaración de arriba es literal, no aspiracional.

---

## 1. El bug que este diseño casi introduce

Antes de leer el resto: hay un fallo que se verificó empíricamente contra el
código, y que condiciona toda la §3. Documentado acá porque es la razón de que
S2.5.2 tenga la forma que tiene.

**Tres caminos limpian el evento activo del `AttentionManager` sin publicar
ningún evento al bus:**

| Camino | Código |
|---|---|
| Expiración por TTL | `attention.ts:190-193` |
| Drop por cambio de modo | `attention.ts:91-94` |
| Watchdog por tick atascado | `attention.ts:280-283` |

Los tres terminan en `#promote()`, que asciende el siguiente de la cola o llama
`onActiveChange(null)`.

**Experimento** (2026-07-09, `--simulate`, `ttlBySeverity.critical: 5s`,
`ttlOverrides: []`):

```
event        category=permission    sev=critical  id=019f49bd
am_decision  action=interrupted                   eventId=019f49bd
state_change to.emotion=DOUBTFUL   balloon=None   eventId=019f49bd
am_decision  action=expired                       eventId=019f49bd   ← muere solo
state_change to.emotion=NEUTRAL    balloon=None   eventId=019f49bc   ← otro evento
```

Entre `expired` y el `state_change` siguiente **no se publicó nada**. Y el
`state_change` no lleva `eventId: null` — lleva **otro evento**, ascendido de la
cola.

Si el balloon heredara en silencio cuando una regla no lo define (que es lo que
hace falta para que una respuesta persista al pasar a idle), el texto
`⚠ sudo rm -rf /tmp/x` habría quedado colgando bajo una cara neutra de un
`subagent` sin relación. Las reglas de `prompt`, `subagent` y `notification` no
definen `balloon`.

La lección: **la vida de un balloon no es una propiedad de su valor. Es una
propiedad de su relación con el evento que lo produjo.** Un centinela (`""`,
`undefined`) no puede expresar eso.

Nota lateral, del mismo experimento: la columna `balloon` dice `None` en toda la
traza, incluso en el `state_change` del permiso. Ver §2.

---

## 2. Una feature muerta desde Fase 2

`personality.ts:31` busca `templates[category]`.

| Categorías que emite el `ClaudeAdapter` | Claves en `companion.yaml` |
|---|---|
| `prompt`, `response`, `permission`, `notification`, `subagent`, `permission_resolved` | `permission.pending`, `permission.critical`, `error`, `session.new`, `session.idle` |

**Intersección: vacía.** `state-machine.ts:130` (`if (balloon)`) nunca ejecutó su
rama. `PersonalityManager.balloon()` no ha devuelto un string en la vida del
proyecto, con 254 tests verdes. El balloon que se ve hoy lo dibuja el cliente —
el código que esta fase borra.

Dos consecuencias:

1. Esto es lo que mantiene **latente** el bug de §1: no hay balloon servidor que
   heredar. **M12 lo despierta.**
2. Los tests de `personality.test.ts` verifican `balloon()` contra categorías
   inventadas por el test, no contra las que el sistema emite. M13 agrega un test
   de contrato para que el próximo rename no repita la historia (S2.5.8).

---

## 3. Objetivo y criterio de done

| # | Criterio | Verificación |
|---|----------|--------------|
| 1 | El servidor es la única fuente del balloon | `grep -c 'setBalloon' dashboard.js` → 1 (solo en `renderState`) |
| 2 | Un evento `transient` que muere limpia su balloon | TTL corto + `tick()` → `resolvedState.balloon === ''` |
| 3 | Una respuesta (`sticky`) sobrevive al idle y a eventos sin balloon | prompt tras response → el texto sigue |
| 4 | Un permiso crítico preempta un mensaje de respuesta | `POST /sim/permission` → balloon cambia |
| 5 | Una respuesta se muestra completa y una sola vez | `statesEqual` deduplica; un solo `state_change` |
| 6 | Cada categoría tiene cara, LED y sonido propios | 3 canales distintos por categoría |
| 7 | La cola del Attention Manager es visible | panel con `active` + `queue` + TTL restante |
| 8 | El modo activo y qué filtra es visible | badge + leyenda |
| 9 | Los últimos 10 balloons son consultables | panel "Screen history" |
| 10 | Eventos idénticos consecutivos se agrupan | 5 × `POST /events` → una fila `×5` |
| 11 | Se puede reproducir un ndjson desde la UI | botón "Replay" |
| 12 | Un permiso crítico nunca expira por TTL | guard test (S2.5.8) |
| 13 | Todo template de personality matchea una categoría real | test de contrato (S2.5.8) |

**Regresión obligatoria**: los 254 tests de Fase 2 siguen verdes.

---

## 4. Alcance y no-alcance

### En scope
- Balloon servidor-autoritativo (`ResolvedState.balloon` como única fuente).
- **Política de vida del balloon** (`sticky` / `transient`) declarada en el `stateRule`.
- `stateRules` y templates para las 7 categorías que el `ClaudeAdapter` emite,
  más `error`.
- Sonido por categoría (el campo ya existe; faltan las reglas).
- Panel de Attention (active + queue + TTL) y badge de modo.
- Historial de balloons (ring buffer server-side).
- Agrupación visual de eventos duplicados consecutivos.
- Endpoint `POST /replay` + botón en la UI, gated por `--simulate`.

### Fuera de scope
- **Metabolic State (D14).** Devuelto a Fase 4 — ver S2.5.5.
- **Adapters nuevos** (Calendar, GitHub, Jira). Fase 3.
- **TTS** (A1). Fase 5. El campo `sound` sigue siendo tonos, no voz.
- **Transporte BLE real**. Sigue el stub. Fase 1B.
- **Stack de balloons** para restaurar el mensaje pisado por un crítico. Ver §11.

---

## 5. Decisión de arquitectura

### S2.5.1 — El servidor decide, el cliente pinta

`dashboard.js` pasa a ser un renderer sin lógica. La única línea que toca el
balloon es la de `renderState`. Se elimina `updateScreenInfo` y las llamadas a
`showBalloon` desde `renderSessions` y `addEvent`.

Justificación, en orden de peso:

1. **Portabilidad al firmware.** El CoreS3 recibe `ResolvedState` por BLE. Si la
   decisión vive en el servidor, hay *una* implementación de la política.
   Corroborado: el heartbeat de `claude-desktop-buddy/REFERENCE.md` lleva un solo
   campo `msg` de texto — el firmware espera un balloon **ya resuelto**, no reglas.
2. **Las prioridades ya existen.** Duplicar el arbitraje del `AttentionManager`
   en el cliente es cómo aparecieron los bugs.
3. **D3.** "La state machine mapea Event → {emoción, decorator, LEDs, sonido,
   servo}." El balloon es parte de ese mapeo y hoy es la excepción.
4. **Testabilidad.** La política se testea en Node, no en un browser.

### S2.5.2 — La vida de un balloon la declara su regla

*(Reemplaza la semántica de valores centinela de la rev. 1, que el council rechazó
como BLOQUEANTE. Ver §1.)*

Cada `stateRule` declara **cuánto vive** el balloon que produce:

| `balloonPolicy` | Significado |
|---|---|
| `transient` (**default**) | El balloon muere cuando su evento deja de ser el activo, **por cualquier vía**: resolución, expiración por TTL, drop por modo, watchdog. |
| `sticky` | Sobrevive a la muerte de su evento. Solo lo reemplaza otro balloon. |

Y el **texto** se resuelve así:

| `state.balloon` en la regla | Efecto |
|---|---|
| ausente | **hereda** el balloon actual — texto *y* política |
| `""` | limpia |
| string | reemplaza, tras interpolar |

El `StateMachine` mantiene `#balloon: { text: string; policy: 'sticky' \| 'transient' }`.
En `apply(null)` (background mood), si la política es `transient` se limpia; si es
`sticky` sobrevive.

Verificación contra los seis escenarios:

| Escenario | Resultado |
|---|---|
| `response` (sticky) → idle | persiste ✓ |
| `permission` (transient) → expira por TTL → se promueve otro evento | se limpia ✓ *(el bug de §1, muerto)* |
| `permission` (transient) → `setMode('SLEEP')` lo descarta | se limpia ✓ |
| `permission` (transient) → watchdog | se limpia ✓ |
| `response` (sticky) → `prompt` (regla sin balloon) | hereda texto y política ✓ |
| `permission` → `permission_resolved` (regla con balloon) | reemplaza ✓ |

**El `balloon: ""` en `permission_resolved` deja de ser obligatorio.** Puede
ponerse para el flash de "aprobado", pero si alguien lo olvida no pasa nada: el
default `transient` limpia solo. *Un diseño que te obliga a recordar algo está mal.*

### S2.5.3 — El modo filtra la expresión, no el estado

Un evento `ambient` (prompt, response) no pasa el filtro de `FOCUS`/`SLEEP` en el
`AttentionManager`, así que en esos modos **la pantalla no se actualiza con
respuestas**. Las cards del dashboard sí, porque viajan por el canal SSE
`session`, que no pasa por el bus.

No es un bug: es Calm Tech operando. En FOCUS el robot calla; el dashboard sigue
informando si lo mirás.

### S2.5.4 — Truncado configurable, no cableado

`personality.balloonMaxChars` (default `240`). El firmware necesitará ~60 en una
pantalla de 320×240; el emulador puede permitirse más. El wrap lo hace el
firmware (`speech-balloon.ts:1-239` mide glifos), así que el bridge trunca por
caracteres, no por píxeles. Nunca más se trunca a 25 en el cliente.

### S2.5.5 — Metabolic State (D14) permanece en Fase 4

La rev. 1 lo adelantaba. El council lo devolvió, y el argumento numérico es
concluyente:

> Con los pesos propuestos y las fuentes existentes: 2 sesiones `working` (peso 1)
> + 1 permiso pendiente (peso 5, half-life infinito) = score **7** → `CALM`. Para
> superar el umbral de `CALM` (20) hacen falta cuatro permisos simultáneos, o un
> `error_active` — y `error_active` **no tiene fuente**: ningún adapter emite
> `category: error`.

El motor devolvería `CALM` en operación real. Solo se movería con `curl`. Eso no
es "testeado", es "verde". D14 no está mal; el *timing* lo estaba.

**Criterio para retomarlo**: existan ≥2 fuentes de input independientes (Fase 3
provee Calendar y GitHub) y el score salga de `CALM` en un día de uso real. El
seam queda expuesto: `StateMachine.#backgroundMood()`. El costo de construirlo
después es el mismo — D14 ya trae la fórmula.

### S2.5.6 — El template se interpola con todo el payload

No con un subset fijo de `{project, command, session}` (`state-machine.ts:125-129`).
Habilita `{text}`, `{message}`, `{tokens}` sin tocar código.

### S2.5.7 — `POST /replay` solo con `--simulate`

Republicar eventos al bus en producción reescribiría el estado real. Además el
`file` se resuelve contra `recorder.dir` y se rechaza si escapa.

### S2.5.8 — Las categorías de evento son la clave de todo

El `ClaudeAdapter` pasa a emitir `permission` y `permission_critical` como
categorías distintas (hoy: `permission` + `payload.isCritical`). Así `stateRules`
le da LED rojo al crítico y `templates` le da texto distinto, sin casos especiales
en el código. `payload.isCritical` se mantiene: `dashboard.js:253` lo usa.

**El filo, y su cierre.** `#computeDeadline` (`attention.ts:251-268`) busca el
override por `source` + `category` exactos. Si no se agrega la entrada de
`permission_critical`, el permiso **crítico** cae a `ttlBySeverity.critical` = 30 s
y expira, mientras el benigno conserva su TTL infinito. **Falla invertido.** Es el
escenario que se reprodujo en §1.

Dos tests lo cierran de forma permanente, y son obligatorios:

1. **Guard de TTL**: *para toda categoría que el `ClaudeAdapter` pueda emitir con
   severity `critical`, `#computeDeadline()` devuelve `null`.* Atrapa también la
   próxima categoría que agregue Fase 3.
2. **Contrato template↔categoría**: *para toda categoría que el `ClaudeAdapter`
   emite, cada preset devuelve un template no-`null`, o la categoría está en una
   lista explícita de silencio deliberado.* Sin esto, §2 se repite.

*(Alternativa considerada y descartada: distinguir por severidad `critical` vs
`high`. Cierra el filo del TTL estructuralmente, pero en `SLEEP` el
`AttentionManager` descartaría el permiso benigno con Claude bloqueado esperando.
Se prefirió el filo cerrado por aserción al filo semántico sin cierre.)*

### S2.5.9 — La personalidad gana sobre `stateRules` para el texto

D28: la personalidad es la capa de expresión. `rule.state.balloon` es el default
estructural; si el preset define un template para esa categoría, lo pisa. **Ambos
se interpolan.** La política (`balloonPolicy`) siempre viene de la regla — no es
expresión, es mecánica.

### S2.5.10 — `PersonalityManager.balloon()` devuelve `string | null`

`null` = no hay template. `""` = limpiar. El llamador usa `!== null`. Hoy
`state-machine.ts:130` usa `if (balloon)` y `""` es falsy: no podría limpiar.

### S2.5.11 — El `ResolvedState` emitido siempre lleva `balloon: string`

Posiblemente `""`. La herencia y la política se resuelven dentro del
`StateMachine` y nunca cruzan la frontera. Cliente y firmware no interpretan nada.

### S2.5.12 — `balloonPolicy` vive en el `StateRule`, no en el `ResolvedState`

`state` es lo que se envía al firmware. `balloonPolicy` es política del bridge; el
firmware no la necesita ni la entiende.

```yaml
- match: { source: claude, category: response }
  balloonPolicy: sticky          # ← hermano de `state`, no dentro
  state:
    emotion: HAPPY
    balloon: "[{project}] {text}"
```

### S2.5.13 — El truncado se aplica al string final ya interpolado

No a cada variable. Un `{text}` de 4 KB no revienta el template ni se come el
prefijo `[proyecto]`.

### S2.5.14 — `set_face` y `forceSafeState()` limpian el balloon

- `mcp:set_face` **sin** `payload.balloon` explícito → limpia (`""`, `transient`).
  Un agente que fuerza una cara no debe arrastrar el texto de otro evento.
  Con `payload.balloon` → lo usa, política `transient`.
- `forceSafeState()` emite `balloon: ''` y resetea `#balloon`. Es el estado
  seguro; no puede heredar nada.

*(Ambos caminos estaban sin especificar en la rev. 1 — `state-machine.ts:138-143`
y `:93-95`.)*

### S2.5.15 — `emit()` conserva su firma

`StateMachineDeps.emit: (state: ResolvedState) => void` no cambia. El transporte
BLE necesitará que el estado se le **empuje**, no ir a buscarlo. El bug de las dos
formas llegando a `notifyState` se arregla en el llamador:

```ts
emit: (state) => { transport.send(state); server.notifyState(); }
```

### S2.5.16 — Los patterns de LED son los del firmware

`stack-chan/firmware/stackchan/led/led.ts:60-140` expone `on`, `off`, `blink`,
`rainbow`. **`pulse` no existe.** El enum de zod se restringe a
`solid | blink | rainbow | off` (`solid` mapea a `on()`), y las reglas usan
`blink` donde la rev. 1 usaba `pulse`.

Escribir config contra una capacidad que el hardware no tiene es fabricarse una
migración. El emulador degrada `rainbow` a sólido (no hay CSS); se anota, no
bloquea.

---

## 6. Componentes nuevos

### `src/core/balloon-history.ts`

Ring buffer de los últimos N balloons emitidos. Server-side, porque el servidor ya
es el dueño.

```ts
export interface BalloonEntry { ts: number; text: string; eventId?: string }

export class BalloonHistory {
  constructor(capacity?: number, now?: () => number);   // capacity default 10
  /** No-op si `text` es igual al último, o si es "". */
  push(text: string, eventId?: string): void;
  recent(): readonly BalloonEntry[];                    // más nuevo primero
}
```

---

## 7. Componentes existentes que se extienden

### 7.1 `StateMachine`

- Mantiene `#balloon: {text, policy}` y resuelve la herencia (S2.5.2).
- Interpola el template con todo el payload (S2.5.6).
- `apply(null)` limpia si la política es `transient`.
- Trunca a `personality.balloonMaxChars` (S2.5.4, S2.5.13).
- `set_face` y `forceSafeState()` limpian (S2.5.14).
- El `ResolvedState` emitido siempre lleva `balloon: string` (S2.5.11).

### 7.2 `PersonalityManager`

- `balloon(category, context)` → `string | null`, acepta contexto arbitrario.
- Los 4 presets ganan claves nuevas y **se renombran** las viejas para matchear
  las categorías reales (§2).

### 7.3 `AttentionManager`

Sin cambios de comportamiento. Su `snapshot()` (que ya devuelve `{active, queue,
mode}` con el `deadline`) empieza a **broadcastearse por SSE** — hoy el evento
`state` solo manda `{resolvedState, mode}`.

### 7.4 `BridgeServer`

| Método | Ruta | Gate | Devuelve |
|---|---|---|---|
| `GET` | `/balloons` | — | `BalloonEntry[]` |
| `POST` | `/replay` | `--simulate` | `{published, skipped}` |

El evento SSE `state` pasa a llevar `{resolvedState, mode, active, queue}`.

### 7.5 `dashboard.js`

- Se **elimina** `updateScreenInfo`, su `setInterval`, `permissionBalloonText`, y
  las llamadas a `showBalloon` desde `renderSessions` y `addEvent`.
- `showBalloon` pierde su `durationMs`: el TTL vive en el `AttentionManager`.
- Paneles nuevos: Attention, Screen history, badge de modo con leyenda.
- La lista de eventos agrupa consecutivos idénticos con `×N`.

---

## 8. Flujo de datos (después)

```
hooks / POST /events / MCP
        │
        ▼
    EventBus  ──(dedup por hash, auto-mute)──► drop
        │ accepted
        ▼
  AttentionManager ──(severity vs mode)──────► drop
        │  arbitra: preemption, TTL, cola
        │
        ├── onActiveChange(active) ──► StateMachine
        │                                 │  stateRules + personality
        │                                 │  + política de balloon (S2.5.2)
        │                                 ▼
        │                           ResolvedState  ─► transport.send()  (BLE / stub)
        │                                 │         └► SSE 'state' ─► dashboard (pinta)
        │                                 └──────────► BalloonHistory
        │
        └── onActiveChange(null) ──► apply(null) ──► background mood
                                                      (limpia si transient)
```

El dashboard ya **no** decide nada. Las cards de sesión siguen llegando por el
canal SSE `session`, que es informativo y no pasa por el bus (por eso sobreviven
a `FOCUS`).

---

## 9. Nuevas `stateRules` (config.yaml)

**El orden importa**: primera que matchea gana.

```yaml
stateRules:
  # ── Permisos ───────────────────────────────────────────────────────────
  - match: { source: claude, category: permission_critical }
    state:
      emotion: DOUBTFUL
      decorators: [angry_mark]
      servo: { pitch: 10 }
      leds: [{ row: left, color: red, pattern: blink }]
      sound: permission
      balloon: "{project}: ⚠ {command}"
      # balloonPolicy: transient (default) → muere con el permiso

  - match: { source: claude, category: permission }
    state:
      emotion: DOUBTFUL
      servo: { pitch: 10 }
      leds: [{ row: left, color: amber, pattern: solid }]
      sound: permission
      balloon: "{project}: {command}"

  - match: { source: claude, category: permission_resolved }
    state:
      emotion: HAPPY
      leds: [{ row: left, color: green, pattern: solid }]
      sound: approve
      balloon: ""            # flash de "resuelto"; opcional gracias a S2.5.2

  # ── Ciclo de trabajo de Claude ─────────────────────────────────────────
  - match: { source: claude, category: response }
    balloonPolicy: sticky    # ← sobrevive al idle: es información, no urgencia
    state:
      emotion: HAPPY
      leds: [{ row: right, color: green, pattern: blink }]
      sound: notification
      balloon: "[{project}] {text}"

  - match: { source: claude, category: prompt }
    state:
      emotion: NEUTRAL
      gaze: center
      leds: [{ row: right, color: blue, pattern: blink }]
      # sin balloon → hereda (la respuesta anterior sobrevive)

  - match: { source: claude, category: subagent }
    state:
      emotion: NEUTRAL
      leds: [{ row: right, color: blue, pattern: solid }]
      # sin sound: un subagente no merece interrumpir (Calm Tech)

  - match: { source: claude, category: notification }
    state:
      emotion: NEUTRAL
      leds: [{ row: right, color: amber, pattern: solid }]

  # ── Errores ────────────────────────────────────────────────────────────
  - match: { category: error }
    state:
      emotion: ANGRY
      decorators: [angry_mark]
      leds: [{ row: right, color: red, pattern: blink }]
      sound: error
      balloon: "✕ {message}"

  # ── Defaults por severidad (red de seguridad) ──────────────────────────
  - match: { severity: critical }
    state:
      emotion: ANGRY
      leds: [{ row: right, color: red, pattern: blink }]
      sound: error
  - match: { severity: high }
    state:
      emotion: SAD
      leds: [{ row: right, color: red, pattern: solid }]
      sound: notification
  - match: { severity: medium }
    state:
      emotion: NEUTRAL
      leds: [{ row: right, color: amber, pattern: solid }]
      sound: notification
  - match: { severity: low }
    state: { emotion: NEUTRAL }
  - match: { severity: ambient }
    state: { emotion: NEUTRAL }
```

Y el override que cierra el filo de S2.5.8:

```yaml
attentionManager:
  ttlOverrides:
    - { source: claude, category: permission,          ttl: infinite }
    - { source: claude, category: permission_critical, ttl: infinite }   # ← sin esto, expira a los 30s
```

---

## 10. Nueva config

```yaml
personality:
  preset: companion
  ttsEnabled: false
  balloonMaxChars: 240        # ← nuevo. El firmware querrá ~60.

dashboard:
  enabled: true
  balloonHistorySize: 10      # ← nuevo
```

### Templates de personality

Claves alineadas con las categorías reales (§2). `companion`:

```yaml
templates:
  permission: "{project}: {command}"
  permission_critical: "{project}: ⚠ {command}"
  permission_resolved: ""
  response: "[{project}] {text}"
  error: "✕ {message}"
  session.idle: "{project}: idle"
```

`mascot` no tiene palabras (D28): `response` y `subagent` son `""`, su expresión
es cara + sonido. `critic` usa `response: "{text}"` sin proyecto. `supervisor` es
formal y corto. Las categorías sin template (`prompt`, `subagent`, `notification`
en `companion`) van a la lista de **silencio deliberado** del test de contrato
(S2.5.8) — no son un olvido.

---

## 11. Métricas nuevas (D23)

| Métrica | Tipo |
|---|---|
| `balloon_changes_total` | counter |
| `replay_runs_total` | counter |
| `am_queue_size` | gauge *(ya existe)* |

---

## 12. Sobre el mensaje que pisa un crítico

Cuando un permiso crítico preempta una respuesta, el texto de la respuesta se
reemplaza y no vuelve. **No es una pérdida: es un cambio de ubicación.** El
`BalloonHistory` (§6) lo conserva y el panel "Screen history" lo muestra a un
clic.

Un stack de balloons que restaure el anterior al resolverse el crítico se evaluó y
se descarta: el firmware espera un solo campo `msg`
(`claude-desktop-buddy/REFERENCE.md`), y restaurar un mensaje viejo de hace dos
minutos como si fuera nuevo es peor UX que no restaurarlo. Decisión de producto,
no deuda.

---

## 13. Cuestiones abiertas

1. **`pulse` para Fase 1B.** El emulador lo soporta, el firmware no. Cerrado por
   S2.5.16 (no se usa), pero queda como pedido: ¿implementarlo en Moddable, o
   mapearlo a `blink` lento en el protocolo BLE?

2. **`rainbow` en el emulador.** El enum lo acepta (existe en el firmware) pero
   `dashboard.css` no tiene la clase; degrada a sólido. Cosmético.

3. **`{text}` de varios KB.** Se trunca a `balloonMaxChars` con `…`. Un resumen
   implicaría llamar a un LLM desde el bridge: rechazado por latencia (D23:
   <500 ms para eventos críticos) y por costo.

4. **`category: error` no tiene fuente.** Las `stateRules` y el template existen;
   ningún adapter lo emite. Se ejercita con `POST /events`. La fuente real llega
   con `GitHubAdapter` (CI rojo) en Fase 3 o `ChromeAdapter` en Fase 6. **Esto es
   también lo que hace inviable a D14 hoy** (S2.5.5).

5. **Deuda anotada, fuera de esta fase.** `statesEqual` compara con
   `JSON.stringify` (`state-machine.ts:46`). El orden de claves depende de qué
   ramas de `#resolve` corrieron, así que dos estados semánticamente iguales
   pueden producir strings distintos y disparar una transición espuria. No explota
   hoy porque `gaze` casi no se usa; con `balloon` entrando y saliendo del objeto
   la superficie crece. **Issue aparte, no se mezcla en este PR.**
