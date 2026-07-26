# DEBT — deuda técnica registrada

Cosas que sabemos que están mal y decidimos **no** arreglar en el momento en que
las encontramos, para no mezclar un fix con un cambio de comportamiento.

Cada entrada tiene: dónde está, por qué no explotó todavía, qué la haría explotar,
y cuánto cuesta arreglarla. Si una entrada no puede responder "qué la haría
explotar", no es deuda — es una preferencia estética y no va acá.

Regla: nada de esta lista se arregla dentro de un PR de feature. Cada una es su
propio commit.

---

## D-03 — `pulse` existe, pero nadie lo ha visto encendido

**Dónde**: `firmware/mods/led-pulse.ts` (nuestro) y `firmware/mods/breath.ts`.

**Estado**: la **decisión** de D-03 está tomada (2026-07-10, Mario): `pulse` se
implementa de verdad en Moddable, no se mapea a un `blink` lento ni se borra.
El efecto está escrito contra la API real de `NeoStrandEffect`, con la misma
forma que `Blink`: un setter `effectValue` que recibe el tiempo dentro del ciclo.
La diferencia es que escala el brillo con un coseno alzado en vez de conmutar
encendido/apagado.

Vive en **nuestro** repo, no en `stack-chan/`: ese directorio es un clon del
upstream, no lo rastrea nuestro git, y cualquier cosa escrita ahí se pierde en el
siguiente `pull`. No hizo falta un fork: `Led extends NeoStrand`, y `setScheme` y
`start` son públicos.

**El problema que queda**: **nunca ha corrido sobre una tira de LEDs**. No hay
CoreS3. Lo único verificado es la aritmética de la curva (`breath.ts`, 8 tests,
mutada contra una onda triangular y contra un brillo constante). El resto —que
`activate` enganche bien con la timeline, que `strand.set` acepte el color, que
100 ms de intervalo basten para que se vea suave— es fe.

**Por qué no explotó**: `pulse` sigue **fuera** del enum `pattern` del bridge, a
propósito. Nada lo puede pedir.

**Qué lo haría explotar**: volver a meter `pulse` en el enum antes de verlo
encendido. Eso devuelve al emulador a proclamar una capacidad que nadie ha
observado, que es literalmente el bug que esta entrada registra desde el principio.

**Fix**: Fase 1B, con el hardware en la mesa. Encenderlo, mirarlo, y solo entonces
añadir `pulse` al enum de zod, al CSS del emulador y a las `stateRules`.

**Costo**: media hora, el día que llegue el robot.

---

## D-12 — el trust check cuenta focos que el usuario no hizo

**Dónde**: `bridge/src/adapters/trust-check.ts`, y antes que ahí, en la
definición de D22.

**El problema**: la métrica cuenta la *transición* de foco hacia Claude. Pero las
apps se roban el foco solas. Observado el 2026-07-10 con `lsappinfo` muestreando
cada segundo: Claude Desktop recupera el frente ~3 s después de que otra app lo
tome, sin intervención del usuario, y Chrome hace lo mismo. Si una de esas
auto-activaciones ocurre más de 30 s después del último blur, el filtro
anti-rebote la deja pasar y se graba un trust check que nadie hizo.

**Por qué no explotó**: la métrica es nueva y el Gate 1 no se ha corrido.

**Qué lo haría explotar**: es el modo de fallo *silencioso* peor posible para
D20. Un trust check inflado dice "el usuario no confía en la cara" y el Gate 1
concluye no seguir con Fase 3. La métrica no se equivoca hacia el lado seguro.

**Fix implementado (2026-07-20)**: opción (a). `TrustCheckAdapter` ahora recibe
`secondsSinceLastInput()` y descarta un focus transition si el último input real
(teclado/mouse/scroll) fue hace más de `inputThresholdSeconds` (default 1 s). La
implementación en macOS usa `CGEventSourceSecondsSinceLastEventType` vía `python3` + ctypes;
falla silenciosamente a "no filtrar" en plataformas sin helper o sin `python3`.

**Qué falta**: calibrar el umbral con datos reales. 1 s es una primera aproximación;
contra una muestra de un día de uso hay que verificar que no descarte transiciones
humanas legítimas (alt-tab rápido, hotkey) y que sí atrape los auto-focus del OS.

**Costo**: el código ya está (~2 h). El día de datos reales para ajustar el umbral
es lo que queda.

---

## D-10 — la pata firmware de D23 no se puede medir sin hardware

**Dónde**: `bridge/src/ble/protocol.ts:321-325`.

**Corrección**: la versión anterior de esta entrada decía que `state_latency_ms`
"solo mide hasta el `ResolvedState`". Es falso. Mide `fw_applied_ts - offset -
bridge_ts`: exactamente la pata del firmware, con corrección de reloj. Lo que no
existía era la pata del bridge, y ya está — la línea `state_change` lleva
`latencyMs` desde el 2026-07-10.

**El problema**: `#handleStateApplied` nunca se ejecuta. El transporte es un stub
que jamás se conecta (`bleHealthy: false` en todo el contexto del recorder), así
que el histograma existe, está bien escrito, y observa cero muestras. La suma de
las dos patas —el presupuesto real de D23, "evento crítico → la cara cambia en el
display"— no se puede calcular hoy.

**Por qué no explotó**: no hay display.

**Qué lo haría explotar**: llega el CoreS3, se cablea el transporte real, y el
histograma empieza a llenarse... en memoria, muriendo en cada reinicio. Igual que
antes, el Gate 1 quiere p95 sobre tres semanas.

**Fix implementado (2026-07-22)**: `#handleStateApplied` ahora graba una línea
`state_change` con `leg: 'firmware'` además de observar el histograma. El
`eventId` que disparó el estado se propaga `emit → sendState → seq→eventId map`,
y `state_applied` (que solo trae `ack_seq`) lo resuelve por ese map (bounded a 32,
sigue al retry sobre su nuevo seq). Sumar las dos patas —join con la línea
bridge-leg por `eventId`— se hace offline. Cubierto por 3 tests nuevos en
`protocol.test.ts`.

**Verificado en hardware (2026-07-22)**: bridge sobre `NobleTransport` conectado al
CoreS3, evento `error` inyectado por `POST /events` → cara ANGRY. Ambas patas
grabaron con el MISMO `eventId`: bridge-leg `latencyMs: 1` (evento→ResolvedState),
firmware-leg `leg:'firmware' latencyMs: 283` (bridge→display). Histograma
`state_latency_ms` p50 283 / p95 305. Presupuesto D23 completo para ese evento ≈284 ms.

**Qué falta**: el p95 real del Gate 1 son tres semanas de datos, no las 3 muestras
de esta verificación. El código y el pipeline de grabado ya están probados; queda
acumular la muestra en uso diario.

**Costo**: hecho y verificado.

---

## D-13 — el bridge valida gestos de cabeza que el firmware no sabe producir

**Dónde**: `bridge/src/server/server.ts:786` (`['tap', 'swipe_fwd', 'swipe_back', 'hold']`)
contra `stack-chan/firmware/stackchan/touch-panel-gesture.ts:3`
(`'press' | 'release' | 'forwardSwipe' | 'backwardSwipe'`).

**El problema**: dos vocabularios distintos para la misma cabeza. `tap` y `hold`
no existen en el firmware. El `GestureRecognizer` corre sobre el Si12T, un sensor
capacitivo de **tres zonas** (izquierda/centro/derecha) — no es la pantalla, que
es otro dispositivo (`M5StackCoreS3Touch`, con `x`/`y` crudos y sin gestos).

Consecuencia concreta: **D6** exige, para un comando destructivo, "hold 2s **o
doble toque**". La variante `hold` no es producible hoy. La de doble toque sí es
derivable de `press`/`release`, porque el gesto trae `ticks`. Pero nadie la ha
escrito, y el bridge acepta un `hold` que nunca llegará.

Además el upstream ya usa los swipes de cabeza para **caricias**
(`default-mods/on-robot-created.ts:436`: forward + backward en ventana corta →
HAPPY con corazones). Cualquier semántica que le demos a los swipes de cabeza
compite con eso.

**Por qué no explotó**: no hay hardware. Los endpoints `/sim/*` producen los
gestos que el bridge inventó, así que el simulador se valida a sí mismo.

**Qué lo haría explotar**: llega el CoreS3, y la guarda de seguridad de los
comandos destructivos —la única que protege un `sudo rm -rf`— no tiene gesto que
la dispare. El simulador seguiría diciendo que funciona.

**Fix**: la parte del bridge está hecha: `handleDeviceInput` ya consume `press`/
`release`/`forwardSwipe`/`backwardSwipe` y deriva `tap` (hasta 300ms) y `hold`
(2s) en el servidor. El simulador envía los mismos eventos crudos. Lo que falta
es Fase 1B: verificar que el CoreS3 envíe `press`/`release` con la resolución
temporal esperada, y decidir si el doble toque debe derivarse en el device en
lugar del bridge. Si el firmware nunca envía `hold`, D6 sigue sin poder usar la
variante "hold 2s" hasta que se implemente en el robot. `swipe_fwd`/`swipe_back`
quedaron reemplazados por `forwardSwipe`/`backwardSwipe` y siguen publicando un
`touch_head` genérico que nadie interpreta.

**Costo**: la alineación del vocabulario ya está hecha (~1h). El doble toque y
long-press en el firmware, Fase 1B: no hay forma de verificarlo sin el sensor.

Es la misma clase de bug que `pulse` (D-03) y que `rainbow` (D-04, resuelto):
escribimos contra un emulador que miente sobre el hardware. Esta vez toca la
seguridad, no la estética.

---

## D-15 — velocity metric deferred (C3)

**Dónde**: no implementado — sería `bridge/src/core/life-stats.ts`.

**Por qué no explotó**: no existe. Es una métrica que el council (C3, 2026-07-10)
demostró que no se puede construir honestamente con los datos actuales.

**Qué la haría explotar**: implementarla sin resolver (a) que `prompt→Stop`
incluye la espera humana en permisos, y (b) que `{sumMs,count}` acumulado de por
vida no es una media móvil — deja de moverse con volumen.

**Qué necesita**: (a) campo `pendingPromptAt` en `ClaudeSession`, (b) exclusión
de turnos con permiso pendiente en medio, (c) ventana deslizante o exponencial
en vez de acumulado.

**Costo**: medio. Requiere cambios en `ClaudeAdapter` (nuevo campo) y un nuevo
cálculo en `LifeStats`.

**Status**: diferido por diseño — no es un bug, no está olvidado.

---

## D-16 — Balloon del emulador diverge del firmware upstream

**Dónde**: `bridge/src/server/public/balloon-layout.mjs` + `face-renderer.js`
(burbuja con cola) vs `stack-chan/firmware/.../speech-balloon.ts` (9-slice
sin cola).

**Por qué no explotó**: no hay hardware todavía; el emulador es el único
display.

**Qué la haría explotar**: flashear el firmware upstream sin portar el
balloon — el robot mostraría un balloon distinto al que el emulador
prometió.

**Costo del fix**: implementar el balloon en el fork (geometría ya
especificada en `balloon-layout.mjs`); estimado 1-2 días de trabajo
Moddable/Piu cuando llegue el CoreS3 (D29).

---

## D-17 — `pet` (fwd+bwd ≤800ms) casi no se dispara en hardware real

**Dónde**: `firmware/mods/buildagotchi_ble/mod.js` (`PET_WINDOW_MS = 800`,
fwd+bwd → `pet`); bridge `head_pet` / idle-expression.

**Qué**: validado 2026-07-22 en CoreS3. `press`/`release` y swipes unidireccionales
llegan bien por BLE. El `pet` sintetizado (forwardSwipe + backwardSwipe en
≤800 ms) **no se logró disparar** en varias rondas: el Si12T suele reportar solo
una dirección por stroke (casi siempre `backwardSwipe`; `forwardSwipe` aparece
poco). Intensidad/zona fina en taps tampoco es usable (mucho `3/3/3`).

**Por qué no explota hoy**: Gate 1 (aprobar permiso) usa tap = `press`/`release`.
`head_pet` sigue siendo nice-to-have / emulador.

**Qué lo haría explotar**: reacciones de caricia en uso diario nunca llegan desde
el robot; solo desde `/sim/touch`.

**Fix (backlog)**: aflojar ventana / aceptar un solo swipe como caricia; o
derivar `pet` de otro patrón (p. ej. hold suave en BACK). No bloquea Gate 1.

**Costo**: bajo–medio; no urgente.

---

## D-18 — La caricia se pierde (no se difiere) cuando hay un evento más urgente

**Dónde**: `attention.ts` (`#computeDeadline` al `push`, expiración de cola en `tick`),
regla `head_pet` con `ttlOverride: 3s`.

**Qué**: `head_pet` tiene severity `low`. Si llega mientras hay un evento de
mayor prioridad activo (p. ej. `context_high`), queda en la cola; su deadline
se computa al encolarse, así que a los 3s se descarta **sin haberse mostrado
nunca**. Verificado en vivo el 2026-07-11: con una sesión real al 100 % de
contexto, una caricia no produjo ningún feedback visible.

**Por qué no explota hoy**: es el comportamiento correcto del AM (no quieres un
corazón obsoleto apareciendo 30 s tarde), y el criterio del spec sólo exige
TTL ≤ 5 s y que no apruebe permisos — ambos se cumplen.

**Qué lo haría explotar**: si el uso muestra que la falta de feedback a una
interacción física se siente rota (tocas al robot y no reacciona porque está
"ocupado"), habría que darle a la caricia una prioridad momentánea o un canal
de reacción propio fuera de la cola de atención.

**Costo del fix**: medio. Requiere decidir si una interacción física del
usuario debe interrumpir el evento activo (nuevo concepto de "reacción
efímera" por encima de la prioridad normal, con su propio TTL corto).

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

- ~~**Un permiso pendiente sobrevivía a la muerte de su sesión**~~ — resuelto
  2026-07-10. El fix del deadlock anterior arregló *una* puerta. `SessionEnd`
  (el usuario cierra el chat) y `#cleanStale` (la sesión caduca a los 35 min)
  borraban la sesión sin liberar su permiso, y el robot quedaba colgado igual.
  Verificado en vivo antes de tocar código.

  Fix: `#retireSession()` es ahora **el único** camino fuera de `#sessions`.
  Una quinta forma de borrar una sesión no puede olvidarse de resolver, porque
  no hay otra forma de borrarla. `test/permission-session-invariant.test.ts`
  asegura el **invariante**, no los casos: tras cualquier evento del adapter,
  ningún permiso activo o encolado pertenece a una sesión que ya no existe.

  **La lección**: arreglar el caso que te reportaron y no la clase a la que
  pertenece es cómo el mismo bug vuelve tres veces.

- ~~**`statesEqual` comparaba con `JSON.stringify`**~~ (era D-01) — resuelto
  2026-07-10. El orden de claves generaba transiciones espurias. Comparación
  campo a campo. Diez tests. El fix rompió un test de M12a que **dependía del
  bug**: aplicaba una regla silenciosa cuyo estado era idéntico al inicial y
  esperaba un `emit` que solo ocurría porque el orden de claves difería.

- ~~**`readTranscriptTail` cargaba el jsonl entero**~~ (era D-02) — resuelto
  2026-07-10. Medido contra un transcript real de 67 MB: **92.8 ms → 0.5 ms**,
  salida idéntica. Corría dentro de un hook con presupuesto de 2 s. Nuevo
  `tail-reader.ts` con ventana que crece (256 KB → 8 MB) para no perder una
  línea más larga que la ventana.

- ~~**`rainbow` degradaba a sólido en el emulador**~~ (era D-04) — resuelto
  2026-07-10, junto con `pattern: 'off'`, que **encendía** el LED. Los dos eran
  divergencias emulador↔firmware, exactamente lo que S2.5.1 existe para evitar.

- ~~**`response` esperaba 30 s detrás de su propio `prompt`**~~ (era D-06) —
  resuelto 2026-07-10. Un `prompt` deja de significar algo cuando llega su
  `response`; ahora lo retira con el mismo `resolvesEventId`. De ~30 s a
  inmediato, cronometrado. Un segundo `prompt` también retira al anterior.

- ~~**El hot-reload del config moría tras el primer guardado atómico**~~ (era
  D-07) — resuelto 2026-07-10. `fs.watch` sobre una ruta de archivo sigue al
  inodo; un guardado atómico (temp + `rename`, lo que hacen vim, VS Code y
  `sed -i`) lo dejaba huérfano. El reload se disparaba **una vez** —para el
  propio rename— y después nada, sin log ni contador de fallos. `loader.ts`
  vigila ahora el **directorio** y filtra por nombre de archivo; el inodo del
  directorio sobrevive al rename.

  La suite llevaba meses verde porque `config-loader.test.ts` escribía siempre
  con `writeFileSync`, in-place, el único camino que funcionaba. El test nuevo
  hace un `rename` real y exige que un **segundo** cambio posterior también
  recargue. Verificado además en el bridge en vivo contando
  `config_reload_duration_ms_count`: 1 → 2 → 3 sobre atómica, in-place y atómica.

  **La lección**: un test que solo ejercita el camino feliz de la API del SO no
  prueba la integración con el SO. Los dos tests de hot-reload que
  SPEC-IMPL §8.2 prometía nunca se escribieron, y nadie lo notó.

- ~~**Un `{placeholder}` sin resolver llegaba a la pantalla del robot**~~ (era
  D-08) — resuelto 2026-07-10. `interpolate()` preserva las claves ausentes a
  propósito, para que un template roto sea ruidoso. El ruido pertenece al log:
  el CoreS3 no tiene forma de explicarse. La `StateMachine` ya no renderiza un
  balloon con placeholders sin resolver — cae a herencia, como una regla
  silenciosa, y emite `warn`. `interpolate()` queda intacto.

  El detonante real: `{text}` sale de `last_assistant_message` del hook `Stop`,
  con fallback a leer el transcript, y esa lectura devuelve `null` con
  `transcriptReadEnabled: false`, una opción soportada. Un test de
  `personality.test.ts` **asertaba el bug**: esperaba `myapp: {command}` en la
  pantalla para un permiso sin `command`. Es el tercer test de este repo que
  documentaba un defecto como si fuera contrato.

- ~~**`tsc` no typechequeaba los tests**~~ (era D-11) — resuelto 2026-07-10.
  `tsconfig.json` incluía solo `src`, y ensancharlo arrastraba `test/` a `dist/`
  por el `rootDir`. Ahora hay un `tsconfig.test.json` que extiende al de siempre
  con `noEmit`, y `npm run typecheck` corre los dos.

  Destapó **30 errores** en 6 archivos. La mayoría eran ruido (`unknown` de
  `res.json()`, `exactOptionalPropertyTypes` sobre un `now: undefined`), pero dos
  eran bugs reales dormidos: `server-attention.test.ts` y `server-replay.test.ts`
  construían el `EventBus` pasándole un `Metrics` donde va un `DedupConfig`, así
  que `windowMs` quedaba `undefined`. Inofensivo solo porque esos archivos no
  ejercitan el dedup.

  Verificado reintroduciendo el error original —una llamada a `resolve()` con dos
  argumentos— y comprobando que el typecheck lo atrapa. La suite seguía verde.

- ~~**El trust check de D22 no existía**~~ (era D-09) — resuelto 2026-07-10.
  Nuevo `TrustCheckAdapter`: cuenta la transición de foco hacia Claude, ignora
  los re-focos dentro de 30 s, y solo cuenta cuando la cara está NEUTRAL o HAPPY
  (si el buddy pide algo, el usuario le está respondiendo, no desconfiando).
  Escribe **directo al Event Recorder**, no al bus: es telemetría sobre el
  usuario, y un evento que el robot atendiera perturbaría el estado que la
  métrica observa.

  **D22 estaba equivocada en su parte más cara**: daba por hecho que hacía falta
  `kTCCServiceAccessibility` y un diálogo de consentimiento, y especificaba una
  rama entera de "si el usuario no lo concede". No hace falta ninguna:
  `lsappinfo` es LaunchServices, API pública, cero permisos. Verificado en la
  máquina real antes de escribir el adapter.

  Nueve tests, y los verifiqué mutando el código: quitar el filtro de 30 s rompe
  uno, contar con la cara DOUBTFUL rompe dos. Un test que no falla cuando rompes
  lo que dice proteger no prueba nada.

  Dejó abierta **D-12**: las apps se roban el foco solas.

- ~~**La latencia del bridge no llegaba al recorder**~~ (era la mitad barata de
  D-10) — resuelto 2026-07-10. La línea `state_change`, que ya se escribía en
  cada transición, ahora lleva `latencyMs`: del timestamp del evento al estado
  resuelto. El p95 se calcula offline sobre toda la ventana de retención, en vez
  de vivir en un histograma que muere en cada reinicio. Clampeado a 0 — un salto
  de NTP o un sleep/wake pueden poner el evento en el futuro, y una muestra
  negativa envenena el p95 sin parecer nunca un error. Medido en vivo: 1 ms.

- ~~**`dashboard.js` no tenía ni un test**~~ (era D-14) — resuelto 2026-07-10, el
  mismo día que se abrió, porque el bug que lo motivó era demasiado barato de
  cubrir como para dejarlo. El render se extrajo a `screen.mjs` —sin `fetch`, sin
  timers— y se testea bajo jsdom. Diez tests, entre ellos el que reintroduce el
  bug: `renderScreenView` **nunca** puede ocultar `.viewport-3d-wrap`.

  Verificado mutando: ocultar el contenedor rompe ese test; no truncar el id de
  sesión rompe otro. La primera versión de ese segundo test **no mordía**, porque
  asertaba un prefijo del id, que aparece con y sin truncado. Segunda vez en el
  día que caigo en lo mismo.

  Lo que sigue sin cubrir es el WebGL: que el canvas conserve su tamaño tras un
  ciclo de vistas solo lo prueba un navegador de verdad. Eso es Playwright, y es
  otra decisión. `tsconfig.test.json` ganó `lib: ["ES2023","DOM"]` y `allowJs`.

---

## D-19 — zumbido de servo por torque continuo

**Dónde**: `firmware/mods/buildagotchi_ble/mod.js`, la pose de reposo en
`onRobotCreated` (`setTorque(true)` + `setPose({p:-0.45})`). `setTorque` solo se
llama en `true` (ahí y en el path de gestos, ~línea 714), **nunca** en `false`.

**Por qué no explotó**: es un "pitido ínfimo" — solo se nota en una habitación en
silencio. Antes de la pose de reposo, en el arranque el torque estaba apagado (servo
mudo, pero la cabeza caída tapando la cara y el botón de reset).

**Qué la haría explotar**: molesta de noche / en silencio; y el servo consume
corriente permanentemente sosteniendo la posición.

**Costo**: bajo, pero con incógnita de hardware. Fix a probar: poner la pose y
**soltar el torque** (`Timer.set(()=>robot.setTorque(false), ~800)`). Los scservo
tienen mucha reducción y **podrían** sostener la cabeza sin torque (no backdrive por
gravedad). Si aguanta → gana-gana (arriba + silencio); si se cae → trade-off
(cabeza-arriba+zumbido vs cabeza-abajo+silencio), elige el usuario. Aplica también al
path de gestos, que deja torque on tras cada nod.

## D-20 — `focusTerminal` levanta la app equivocada (mitigado, no resuelto)

**Dónde**: `bridge/src/core/focus-terminal.ts`. El osascript activa la **primera app
corriendo** de `Code/Cursor/Windsurf/Warp/iTerm2/Terminal` — **ignora el cwd**. Para un
usuario que trabaja en la app de escritorio de Claude, levanta VS Code, que no tiene
nada que ver.

**Por qué no explotó (del todo)**: el cooldown de 8s (D34) cortó el storm de 727×/min
que hacía imposible escribir. Pero cuando dispara, sigue trayendo la ventana equivocada.

**Qué la haría explotar**: cualquier permiso/pregunta resuelto trae VS Code al frente
aunque el usuario esté en otra app.

**Costo**: bajo. Gatearlo o desactivarlo por config (`focusOnResolve: false`), o hacer
que respete de verdad el cwd (matchear la ventana del proyecto).

## D-21 — "avisar cerca de los límites de uso" está bloqueado por los hooks

**Dónde**: no hay código — es un gap de datos. Los límites de uso 5h/semanal
(`rate_limits.five_hour/seven_day.used_percentage`) solo llegan en el JSON de la
**statusline**, no en ningún hook. El bridge se alimenta de hooks.

**Por qué no explotó**: es una feature pedida, no un bug.

**Qué la haría explotar**: el usuario quiere que el buddy le avise cuando se acerca a su
límite de uso — hoy imposible sin un canal nuevo.

**Costo**: medio. Requeriría que algo con acceso al JSON de la statusline (un script CLI,
inviable para un usuario app-only) empuje los `rate_limits` al bridge por `POST /events`,
con throttle. A diseñar.

## D-22 — el balloon del firmware no muestra emoji (sale "??")

**Dónde**: la fuente del balloon es `OpenSans-Regular-16` (bitmap, ASCII básico —
manifest del mod). Cualquier emoji o carácter fuera de ASCII en el texto del balloon
sale como `??`. En `config.yaml`, `life_milestone` usa `"🎉 {streak} días seguidos"`
→ en hardware saldría `"?? días seguidos"`. Verificado en HW 2026-07-25 (un globo de
prueba con 🌈 salió `??`).

**Por qué no explotó**: `life_milestone` (racha de días de uso) casi no se dispara aún;
el resto de los balloons son ASCII.

**Qué la haría explotar**: cualquier balloon con emoji/acentos en hardware real.

**Costo**: bajo si se acepta la limitación — usar solo ASCII en los templates de
balloon (los "emoticons" reales del buddy son los **decorators**, que son gráficos y sí
funcionan: heart, angry_mark, sweat, etc.). Alto si se quiere emoji de verdad: haría
falta una fuente con esos glifos (peso en flash del ESP32). Nota aparte: `rainbow` es
capacidad real del firmware (`lightRainbow`) pero **ninguna stateRule lo usa** — solo se
vio en la demo con una regla temporal.

## D-23 — OOM del heap de XS (RESUELTO 2026-07-26: churn, no leak; heap 256→512KB)

**Firma**: `# Chunk allocation: 456 bytes failed in fixed size heap` → `rst:0xc
(RTC_SW_CPU_RST)`, ~cada 3 min de uptime. Reabrió el bullet de "resueltas" que daba el
OOM por cerrado tras la maratón: NO lo estaba.

**Diagnóstico definitivo (instrumentación de Moddable).** Se compiló y flasheó un host
**instrument** (`mcconfig -i -p esp32:./platforms/m5stackchan_cores3`; el mod release
carga sobre él, BLE up). El build instrument imprime `instruments: <26 valores>` en
serial **en texto plano** (sin xsbug GUI ni `xsbug-log`, que no está instalado). Parseando
la serie temporal: el campo **XS Chunk Heap Used** hace **sawtooth** (sube ~10KB/s y el
GC lo recupera; 5 caídas grandes en 70s, GC count subiendo) contra el techo **constante
262144 (256KB)**. Los picos llegan a **261636/262144** — a ~500 bytes del límite. Cuando
una asignación (los 456 bytes) cae en un pico sin espacio → abort. Por eso es
**intermitente** (solo revienta si un pico coincide con una asignación que no cabe) y por
eso parecía pasar "en idle" (el churn base lo genera el render de la cara del host, no el
mod). **NO es leak de retención** — el GC libera bien. Fuente del churn: render de cara
(Poser, inherente) + balloon marquee (`unit+unit`+slice por tick, D-24).

**Fix (verificado)**: subir `platforms."esp32/m5stackchan_cores3".creation.chunk.initial`
de 262144 a **524288 (512KB)** en `stack-chan/firmware/stackchan/manifest.json`. Como el GC
sí recupera, más margen es el fix real, no un parche que demora: los picos (~262k) quedan
con ~250KB de aire y nunca tocan el techo. El S3 tiene ~8MB libres. Verificado: soak de
**400s** con actividad real de balloon/permiso, **cero `rst:0xc`** (antes reventaba a ~198s),
BLE `connected` sin reconnects. No se re-instrumentó el techo nuevo (build de 15 min por
confianza marginal). Persistencia: commit local en stack-chan (972f600e, es clon upstream
ignorado por nuestro git) + patch trackeado `firmware/patches/chunk-heap-512k.patch`.

## D-24 — marquee balloon aloca `unit+unit`+slice cada tick (higiene)

**Dónde**: `firmware/mods/buildagotchi_ble/mod.js:764-772` (`startBalloonMarquee`). El timer
de scroll hace `const doubled = unit + unit` y `doubled.slice(...)` en CADA tick — para un
balloon de 209 chars son ~840 bytes asignados por tick, sin parar mientras dure el marquee.

**Por qué no explotó**: con el chunk-heap en 512KB (D-23) el churn extra es inofensivo (el
GC lo maneja de sobra). Antes contribuía a los picos que chocaban el techo de 256KB.

**Qué lo haría explotar**: nada crítico hoy; es desperdicio en un hot path de un device con
heap fijo. Bajar el churn da más margen aún y GC más espaciado.

**Costo**: bajo. Precomputar `doubled = unit + unit` una vez en `startBalloonMarquee` (no
cambia entre ticks) y solo hacer el `slice` por tick. Commit propio, no mezclar con otra cosa.

## D-25 — caída periódica del link BLE (~5 min) + discovery de noble que se wedgea

**Dónde**: dos sub-issues, caracterizados con logs limpios del bridge 2026-07-26 (tras
reiniciar el bridge, que resolvió el estado wedged). Es el viejo "bug #2", ahora con
evidencia, NO causado por el fix de heap (D-23): el device queda sano y sin reboots.

**A) Drop periódico.** Con el link sano, cae cada ~5 min: log `link down, uptimeMs:291357,
sendInFlight:false` → el device deja de responder heartbeats por 15s → el watchdog de 15s
del bridge (`heartbeatSeconds:5 × missesBeforeDead:3`, protocol.ts:305) lo declara muerto.
`sendInFlight:false` → camino de heartbeat (no ack-miss). Intervalos VARIABLES medidos por
poller de `/metrics`: 40s / 90s / 180s / 195s / 291s.

**Raíz concluida por razonamiento (2026-07-26, el serial no dio para confirmar directo — ver
abajo): conexión BLE rancia del lado macOS, NO el firmware.** Evidencia decisiva: cuando cae,
un disconnect+reconnect **revive el link en ~2.6s y el device responde al instante** (hello +
hb). Si el firmware se hubiera stalleado/crasheado, no respondería tan rápido tras el
reconnect → el firmware estuvo vivo todo el tiempo. Lo que se pone rancio es la entrega de
notificaciones de CoreBluetooth/noble en conexiones largas (issue conocido de macOS: las
notify se cortan en silencio aunque la conexión siga "up"; solo un reconnect las restaura).
Por eso NO se ve un `disconnect` de noble (mi fix de `onStateChange`, commit 5cdcb12, no
aplica a este caso) y solo el watchdog de heartbeat lo caza a los 15s. **Tunear NimBLE no lo
arreglaría.**

**Fix aplicado (mitigación del lado correcto): reconnect proactivo** (commit 56272b4).
`ble.proactiveReconnectMinutes` (config.yaml local = 2): el bridge recicla el link cada N min
ANTES de que envejezca al estado rancio → cambia un stall aleatorio de ~17s por un blip
controlado de ~2s. Timer de vida-de-sesión que se auto-salta si está reconectando o caído.
**PENDIENTE DE VALIDAR empíricamente**: tras reiniciar el bridge con esto activo, medir si la
tasa de drops aleatorios baja (mirar `link down` vs `proactive BLE reconnect` en el log). Si
la staleness NO es age-based, el proactivo suma blips sin evitar los aleatorios — habría que
subir/bajar el intervalo o descartarlo. Necesita reinicio del bridge (el cfg se lee al
construir `ProtocolSession`, no hot-reload).

**MURO DE OBSERVABILIDAD (anotar para la próxima):** no se pudo confirmar la raíz por serial
porque **el CDC USB nativo del ESP32-S3 no entrega `trace()` de forma fiable a pyserial** —
solo emite sostenido justo tras un boot por hardware limpio, y aun así intermitente; abrir el
puerto en un device ya corriendo suele dar 0 bytes aunque esté vivo (BLE conectado). Se
intentó correlacionar serial-del-device vs drops-del-bridge en un reloj común (scripts
`correlate*.py`) y falló por esto. Para la próxima: instrumentar el BRIDGE (contar notify
inbound en transport-noble `#onNotify`) para ver desde el lado del Mac si el inbound se corta,
sin depender del serial roto; o un tap UART por hardware.

**B) Discovery de noble se wedgea.** La reconexión que debería ser ~2s a veces se vuelve
87s / 18min / "muerto hasta reiniciar el bridge". `reconnect_duration_ms` bimodal (p50 2.1s,
p95 1.074.465ms). Tras muchas horas / decenas de reconnects, el noble de macOS del proceso
deja de redescubrir el device aunque esté anunciándose → contadores del bridge congelados,
`connected:false` permanente. **Reiniciar el bridge lo arregla** (redescubre en ~87s). Esto
es lo que hizo parecer "device colgado/muerto" en la caza del 2026-07-26 — era el bridge, no
el device.

**Qué lo haría explotar**: A hace que el buddy pierda el estado y re-loguee (molesto pero se
recupera); B lo deja inutilizable hasta reiniciar el bridge a mano.

**Estado (2026-07-26):**
- **B — RESUELTO** (commit 219bf0f). `Transport.reset?()` opcional; `NobleTransport.reset()`
  hace `noble.reset()` (+ stopScanning + removeAllListeners) para re-inicializar el binding
  nativo in-process; `ProtocolSession` lo llama cada 4 fallos de reconnect consecutivos
  (`RESET_TRANSPORT_AFTER_ATTEMPTS`). Test en protocol.test.ts. Des-wedgea el scanner sin
  reiniciar el proceso.
- **A — raíz = conexión rancia Mac-side (NO firmware); 3 fixes** (ver el análisis de arriba
  para la evidencia). (1) **Latencia** (commit 5cdcb12): `ProtocolSession` no escuchaba
  `onStateChange`, así un `disconnect` limpio pasaba 15s inadvertido; ahora dispara
  `#onLinkDead` inmediato (~2s en vez de ~17s). NB: no aplica al caso dominante (que NO emite
  `disconnect`), pero es correcto para los limpios. (2) **Reconnect proactivo** (commit
  56272b4): `ble.proactiveReconnectMinutes` recicla el link antes de que envejezca — el fix
  del lado correcto. **PENDIENTE DE VALIDAR** que reduce los drops aleatorios (medir tras
  reinicio del bridge). (3) Descartado tunear NimBLE: la raíz es macOS, no el firmware.
  OJO: los dos watchdogs de 15s (bridge + mod `armSafeMode` mod.js:1015) son simétricos.

**Bug menor relacionado**: `/health` reporta `transport.reconnects` desincronizado de
`ble_reconnects_total` (el health da 0 mientras el metric va en decenas). El health miente.

---

## Resueltas en la maratón de estabilidad (2026-07-25)

- ~~**Tormenta de `timeout.` del bus servo**~~ (estaba en Pendientes del DEVLOG) —
  `getRotation` poleaba los servos en cada frame de render y ninguno respondía → 80ms
  muertos/frame + UART saturado. Deshabilitado el poleo (`Object.defineProperty` porque
  el método del driver es read-only). timeouts 127/30s → 0.

- **Reinicios espontáneos del CoreS3** (PARCIAL — reabierto como D-23) — se atacó una
  causa real (tormenta táctil + evento `sample` cada 150ms): quitado el `sample`,
  `TOUCH_ON` 1→2 (luego 2→3), circuit breaker en `emitTouch`. Pero 2026-07-25 se capturó
  la firma OOM (`Chunk allocation 456 bytes → rst:0xc`) reincidiendo a los ~198s en idle
  puro, sin tormenta táctil. Aquel fix no era la causa completa. Ver **D-23**.

- ~~**Reconexión BLE de minutos**~~ — conexión fantasma del firmware tras un corte sucio
  del Mac (D32). Cerrado: force-disconnect en el safe-mode de heartbeat.

- ~~**Falso 100% de contexto**~~ — ventana cableada en 200k vs 1M real (D31). Cerrado:
  ventana → 1M.

- ~~**Robo de foco (teclado)**~~ — `focusTerminal` sin cooldown (D34). Cerrado con el
  cooldown; queda D-20 (app equivocada).
