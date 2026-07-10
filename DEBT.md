# DEBT — deuda técnica registrada

Cosas que sabemos que están mal y decidimos **no** arreglar en el momento en que
las encontramos, para no mezclar un fix con un cambio de comportamiento.

Cada entrada tiene: dónde está, por qué no explotó todavía, qué la haría explotar,
y cuánto cuesta arreglarla. Si una entrada no puede responder "qué la haría
explotar", no es deuda — es una preferencia estética y no va acá.

Regla: nada de esta lista se arregla dentro de un PR de feature. Cada una es su
propio commit.

---

## D-01 — `statesEqual` compara con `JSON.stringify`

**Dónde**: [`bridge/src/core/state-machine.ts:75`](bridge/src/core/state-machine.ts)

```ts
function statesEqual(a: ResolvedState, b: ResolvedState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
```

**El problema**: `JSON.stringify` preserva el orden de inserción de claves. Dos
`ResolvedState` semánticamente idénticos producen strings distintos si sus claves
se insertaron en distinto orden, y `#transition` los trata como un cambio real:
graba un `state_change`, incrementa `face_changes_total`, emite por SSE y empuja
al `BalloonHistory`.

`#resolve` construye el objeto con spreads condicionales en tres puntos:

```ts
state = { decorators: [], leds: [], balloon: '', ...rule.state };   // orden A
if (e.direction !== undefined) state = { ...state, gaze: e.direction };  // gaze al final
if (personality) state = { ...state, decorators: [...] };
if (e.source === 'mcp:set_face') state = { ...state, emotion: ... };
state = { ...state, balloon: balloon.text };
```

Un evento con `direction` pone `gaze` al final; una regla que ya traía `gaze` lo
tiene en el medio. Mismo estado, dos strings.

**Por qué no explotó**: `gaze` casi no se usa hoy — ninguna `stateRule` de
`config.yaml` lo declara salvo `prompt` (`gaze: center`), y ningún adapter emite
`direction`. Las ramas de `set_face` y `personality` sí corren, pero producen un
orden consistente para un mismo camino.

**Qué lo haría explotar**: Fase 3. `JiraAdapter` emite `direction: left` y
`GitHubAdapter` `direction: right` (ROADMAP §Fase 3). En cuanto una regla
declare `gaze` **y** un evento traiga `direction`, aparecen transiciones
espurias: la cara "cambia" a sí misma, el `BalloonHistory` acumula duplicados, y
el `state_change` del recorder miente sobre cuántas veces cambió el estado.

**Fix**: comparación estructural que no dependa del orden. Lo más barato es
ordenar las claves antes de serializar, o comparar campo por campo (son 7). El
segundo es más rápido y no aloca.

**Costo**: ~30 min con test. El test es fácil de escribir mal: hay que construir
los dos estados por caminos distintos de `#resolve`, no a mano.

---

## D-02 — `readTranscriptTail` lee el archivo completo

**Dónde**: [`bridge/src/adapters/claude-transcript.ts:18`](bridge/src/adapters/claude-transcript.ts)

```ts
content = readFileSync(transcriptPath, 'utf-8');
const allLines = content.split('\n').filter((l) => l.length > 0);
const lines = allLines.slice(-maxLines);   // ← solo quería las últimas 50
```

**El problema**: carga en memoria el jsonl entero para quedarse con las últimas
50 líneas. El `claude-jsonl-scanner.ts` que escribimos en Fase 2.5 hace lo
correcto (`stat` + seek desde el final, 128 KB); este módulo, más viejo, no.

**Por qué no explotó**: se invoca desde `#readTranscript`, que solo corre cuando
llega un hook `Stop` o `Notification` con `transcript_path` — no en un loop. Un
pico de memoria de 70 MB una vez cada varios minutos no se nota.

**Qué lo haría explotar**: una sesión larga (los jsonl llegan a 70+ MB) más un
Claude que emite `Stop` seguido, o varias sesiones haciéndolo a la vez. También
degrada la latencia del hook, que tiene presupuesto de 2 s (`curl -m 2`) antes de
que el script caiga al fallback de state file.

**Fix**: reusar `readTail()` de `claude-jsonl-scanner.ts`. Ya está escrito y
testeado; es extraerlo a un módulo compartido.

**Costo**: ~20 min. Los tests de `claude-transcript.test.ts` deberían pasar sin
cambios — si no pasan, el fix cambió comportamiento y hay que mirar por qué.

---

## D-03 — `pulse` no existe en el firmware

**Dónde**: `bridge/src/server/public/dashboard.css` (`.led.pulse`) vs
`stack-chan/firmware/stackchan/led/led.ts:60-140`.

**El problema**: el emulador soporta `pulse`; el firmware expone `on`, `off`,
`blink`, `rainbow`. S2.5.16 lo cerró sacando `pulse` del enum de zod y de las
`stateRules`, pero la clase CSS sigue ahí y el firmware sigue sin el pattern.

**Por qué no explotó**: nada lo usa. El enum lo rechaza al cargar config.

**Qué lo haría explotar**: nada, mientras nadie lo agregue. Está acá para que la
decisión de Fase 1B sea explícita.

**Fix**: decidir en Fase 1B — ¿implementar `pulse` en Moddable, o mapearlo a un
`blink` lento en el protocolo BLE? Después borrar el CSS muerto o cablearlo.

**Costo**: la decisión, 5 min. La implementación depende de cuál se elija.

---

## D-04 — `rainbow` degrada silenciosamente en el emulador

**Dónde**: `renderLeds()` en `bridge/src/server/public/dashboard.js` hace
`el.classList.add(led.pattern)`, y `dashboard.css` no tiene `.led.rainbow`.

**El problema**: el enum de zod acepta `rainbow` (el firmware lo tiene), pero el
emulador lo pinta como sólido sin avisar.

**Por qué no explotó**: ninguna `stateRule` usa `rainbow` hoy.

**Qué lo haría explotar**: alguien escribe una regla con `rainbow`, la ve
funcionar en el emulador, y descubre en el hardware que se ve distinto. Es el
tipo de divergencia emulador↔firmware que S2.5.1 existe para evitar.

**Fix**: animación CSS de `rainbow` (~15 líneas de `@keyframes` con `hue-rotate`).

**Costo**: 15 min. Cosmético pero cierra el ciclo de "el emulador no miente".

---

## D-06 — Un `response` espera ~30 s detrás del `prompt` de su propia sesión

**Dónde**: `bridge/src/core/attention.ts` (`queueCompare`) + `config.yaml`
(`ttlBySeverity.ambient: 30s`).

**El problema**: `prompt` y `response` son ambos `ambient`. Cuando Claude
termina de responder, el `Stop` hook emite `response`, pero el `prompt` de esa
misma sesión sigue siendo el evento activo — misma severidad, así que no lo
preempta (`severityRank(e) > severityRank(active)` es falso). El `response` se
encola y solo se promueve cuando el `prompt` expira, **30 segundos después**.

Medido contra el bridge corriendo (2026-07-09): `Stop` a t=0, balloon
`[miproyecto] tarea terminada` recién a t≈30 s.

**Por qué no explotó**: la pantalla no miente, llega tarde. Y como `response` es
`sticky` (S2.5.2), una vez que aparece se queda. En uso real el usuario ya leyó
la respuesta en el chat.

**Qué lo haría explotar**: es un dispositivo *ambient*. Mostrar la respuesta
medio minuto tarde contradice el propósito — mirás al robot para saber si Claude
terminó, y te dice que sí treinta segundos después de que terminó. Con varias
sesiones activas el efecto se compone: cada `prompt` ocupa el activo su TTL
completo.

**Fix**: el `prompt` de una sesión deja de tener sentido cuando llega su
`response`. El mecanismo ya existe desde el fix del deadlock: el adapter puede
emitir el `response` con `payload.resolvesEventId` apuntando al `prompt` de esa
sesión, y el `AttentionManager` lo retira. Requiere que el adapter recuerde el
`eventId` del `prompt` por sesión — hoy solo recuerda el del permiso.

**Costo**: ~40 min con test. **No es cosmético**: cambia cuándo la cara refleja
el estado real, que es la propuesta de valor del producto.

---

## D-05 — `dashboard.js:671` — `useSingleVarDeclarator`

**Dónde**: [`bridge/src/server/public/dashboard.js:671`](bridge/src/server/public/dashboard.js)

```js
let yaw, pitch;
```

**El problema**: biome se queja. Es el único error de lint que queda en el
archivo. Preexistente en el código de auto-servo; no lo tocamos en Fase 2.5
porque `biome check --write` sobre el archivo entero también reformatea código
viejo y ensucia el diff.

**Por qué no explotó**: es lint, no runtime.

**Qué lo haría explotar**: nada. Molesta en CI si alguna vez `biome check` se
vuelve bloqueante.

**Fix**: `let yaw; let pitch;` y un `biome check --write` sobre el archivo, en su
propio commit de formato.

**Costo**: 2 min.

---

## Resueltas

Se dejan acá con la fecha para no re-descubrirlas.

- ~~**`updateScreenInfo` duplica la lógica del `AttentionManager` en el
  browser**~~ — resuelto en Fase 2.5 (S2.5.1). Era la causa de cuatro bugs de
  balloon. El servidor es ahora la única fuente.
- ~~**El balloon de un evento `transient` sobrevive a la muerte de su
  evento**~~ — resuelto en Fase 2.5 (S2.5.2). Tres vías del `AttentionManager`
  limpiaban `#active` sin publicar al bus. `balloonPolicy` lo cierra.
- ~~**`PersonalityManager.balloon()` nunca devolvió un string**~~ — resuelto en
  Fase 2.5 (S2.5.10 + test de contrato M13). Los presets usaban
  `permission.pending`, el adapter emitía `permission`. Intersección vacía
  durante dos fases, con tests verdes.
- ~~**`POST /replay` usaba UTC para el nombre del día-log**~~ — resuelto en
  Fase 2.5 (M16). El recorder rota por fecha local; `localDateString()` ahora se
  exporta y la comparten.
- ~~**Aprobar un permiso desde el chat dejaba al robot colgado para siempre**~~ —
  resuelto 2026-07-09, post-Fase 2.5. El hook `PostToolUse` limpiaba
  `session.pendingPermission` en el adapter pero nunca liberaba el evento en el
  `AttentionManager`. Como `permission_critical` tiene TTL infinito (S2.5.8) y
  `permission_resolved` es `ambient` (no puede preemptar un `critical`), el AM
  quedaba en deadlock: cara DOUBTFUL, LED rojo y `⚠ sudo rm -rf /` en pantalla,
  indefinidamente, para un permiso ya aprobado. El camino del dashboard sí
  llamaba `attentionManager.resolve()` (`server.ts:602`); el del hook no.
  El campo `originalEventId` que el adapter emitía **no lo leía nadie**.

  Fix: `AttentionManager.push()` honra `payload.resolvesEventId` — mecanismo
  genérico (D3), no específico de Claude; un "CI green" puede retirar un
  "CI red". Corre **antes** del filtro de modo, o en `SLEEP` un resolver
  `ambient` se descartaría y su target quedaría activo para siempre.

  **La lección**: el bug vivía estrictamente *entre* dos módulos con tests
  verdes. `claude-adapter.test.ts` verificaba que `pendingPermission` quedaba
  `undefined`; `attention.test.ts` verificaba `resolve()`. Ninguno cruzaba la
  costura `hook → adapter → bus → AM`, porque la separación de módulos —
  correcta — hacía que ninguno la "poseyera". Lo encontró el paso 5 del
  checklist manual de SPEC-IMPL-FASE-2.5 §8.1, no la suite.
  Cubierto ahora por `test/permission-resolve-chain.test.ts`, que instancia el
  adapter y el bus reales: mockear cualquiera de los dos reintroduce el punto
  ciego.
