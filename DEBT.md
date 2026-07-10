# DEBT — deuda técnica registrada

Cosas que sabemos que están mal y decidimos **no** arreglar en el momento en que
las encontramos, para no mezclar un fix con un cambio de comportamiento.

Cada entrada tiene: dónde está, por qué no explotó todavía, qué la haría explotar,
y cuánto cuesta arreglarla. Si una entrada no puede responder "qué la haría
explotar", no es deuda — es una preferencia estética y no va acá.

Regla: nada de esta lista se arregla dentro de un PR de feature. Cada una es su
propio commit.

---

## D-03 — `pulse`: decisión pendiente para Fase 1B

**Dónde**: `stack-chan/firmware/stackchan/led/led.ts:60-140`.

**El problema**: el firmware expone `on`, `off`, `blink`, `rainbow`. El emulador
tenía además `pulse`. S2.5.16 lo sacó del enum de zod y de las `stateRules`, y
D-04 borró su CSS. No queda código muerto; queda una **decisión**.

**Por qué no explotó**: nada lo usa. El enum lo rechaza al cargar config.

**Qué lo haría explotar**: nada. Está acá para que la decisión de Fase 1B sea
explícita en vez de improvisada.

**Fix**: decidir en Fase 1B — ¿implementar `pulse` en Moddable, o mapearlo a un
`blink` lento en el protocolo BLE? Es la única entrada de este archivo que no es
un bug.

**Costo**: la decisión, 5 min. La implementación depende de cuál se elija.

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

**Fix**: no hay uno obvio, y por eso es deuda y no un bug que arreglar de paso.
Ideas, en orden de coste: (a) correlacionar con actividad de input real —
`CGEventSourceSecondsSinceLastEventType` da segundos desde el último teclado o
mouse, y un foco sin input en el último segundo no lo hizo un humano; (b)
descartar el foco si la app anterior era también Claude; (c) medir la métrica
solo cuando el bridge no acaba de emitir un evento.

La (a) parece correcta y barata, y necesita medirse antes de creerle.

**Costo**: ~2 h más un día de datos reales para calibrar el umbral.

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

**Fix**: cuando Fase 1B conecte el transporte, `#handleStateApplied` debe grabar
una línea en el recorder además de observar el histograma, y correlacionarla con
el `state_change` por `eventId` — hoy el envelope no lo lleva. Sumar las dos
patas se hace offline.

**Costo**: ~1 h, dentro de Fase 1B. No antes: no hay forma de verificarlo.

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
