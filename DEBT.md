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

## D-09 — el trust check de D22 no existe

**Dónde**: en ninguna parte. `grep -r trust_check bridge/src` no devuelve nada.

**El problema**: D22 define la métrica con precisión —contar cuántas veces al día
el usuario enfoca Claude Code mientras el buddy está en NEUTRAL/HAPPY, vía
Accessibility API— e incluso describe el diálogo de permiso de macOS y el filtro
anti-falsos-positivos de 30 s. No hay una línea de código. Nadie emite
`category: trust_check` y no existe ningún lector de foco de ventana en `src/`.
La decisión está escrita como si estuviera implementada.

**Por qué no explotó**: el Gate 1 nunca se ha corrido. Necesita hardware.

**Qué lo haría explotar**: llega el CoreS3, se usan tres semanas, y al evaluar
resulta que la métrica que D20 llama "confío en la cara" no tiene datos. Tres
semanas de medición inservibles para ese criterio.

**Fix**: un adapter que lea la app en foco (`NSWorkspace.frontmostApplication`
basta; no hace falta `kTCCServiceAccessibility` para el bundle id) y emita el
evento sintético. D22 ya especifica el filtro de 30 s y el burn-in de 3 días.
Si el permiso no se concede, la métrica se deshabilita con warning — D22 dice
que no es bloqueante.

**Costo**: ~medio día. Debe estar listo **antes** de que llegue el hardware, no
después: es una precondición del Gate 1, no un extra.

---

## D-10 — la latencia del Gate 1 no sobrevive a un reinicio

**Dónde**: `bridge/src/server/metrics.ts` (histogramas en memoria) contra
`recorder.ts` (el ndjson).

**El problema**: existen `state_latency_ms` y `reconnect_duration_ms`, pero viven
en memoria y solo se exponen por `GET /metrics`. Reiniciar el bridge los borra y
nada llega al ndjson. El Gate 1 pide p95 sobre tres semanas.

Peor: el presupuesto de D23 es "evento crítico → **la cara cambia en el display**,
e2e bridge→firmware→display", y `state_latency_ms` solo mide hasta el
`ResolvedState` dentro del proceso. Le falta la pata del firmware.

**Por qué no explotó**: nadie ha medido p95 todavía.

**Qué lo haría explotar**: lo mismo que D-09 — evaluar el Gate 1 y no tener serie
histórica.

**Fix**: dos mitades independientes. (a) Persistir la latencia por evento en la
línea `state_change` del recorder, que ya se escribe; el p95 se calcula después,
offline. (b) La pata firmware→display necesita hardware y un ack de la CoreS3;
va en Fase 1B, junto a D-03.

**Costo**: (a) ~1 h. (b) depende de Fase 1B.

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
