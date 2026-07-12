# Adopción del firmware original — balloon, mimic y vida percibida

**Fecha**: 2026-07-11
**Estado**: aprobado (rev 3 — Feature B idle híbrido + gesto `pet`), Feature A
implementada; Feature B en plan de implementación
**Fuentes**: auditoría de `stack-chan/` (Moddable, nuestro target de firmware) y
`StackChan/` + `StackChan-BSP/` (factory firmware de M5Stack), 2026-07-11.

## Objetivo

Adoptar del ecosistema StackChan original las capacidades que suben la
fidelidad visual y la vida percibida del buildagotchi, sin violar la regla del
repo: **el emulador no puede hacer nada que el robot no vaya a hacer**
(README §"The emulator is not the firmware").

## Hallazgos que corrigen supuestos

### La "copia de caras" no es del robot

El CoreS3 **no hace face detection on-device** en ningún firmware (verificado:
no hay ESP-WHO ni ML embebido en ninguno de los dos repos). Lo que se ve en
los demos del factory firmware es:

- La **app Flutter del teléfono** usa la cámara frontal + Google ML Kit
  (`app/lib/util/ml_kit_util.dart`).
- Convierte la cara detectada en **4 señales** (`app/lib/view/util/
  stack_chan_face_view.dart::dataConversionTesting()`): yaw/pitch de la
  cabeza → ángulos de servo, apertura de cada ojo → peso de párpado,
  probabilidad de sonrisa → boca (+ squint de ojos si > 0.3).
- Manda ese JSON por WebSocket o BLE (`ControlAvatar` 0x03 / `ControlMotion`
  0x04) y el robot lo renderiza (`firmware/main/hal/hal_ws_avatar.cpp` →
  `app_avatar.cpp:113-123`).

En el firmware Moddable (nuestro target) lo más cercano es distinto: gaze
tracking con una cámara externa UnitV2 (`mods/face_tracker/`) y mimic
robot-a-robot por mDNS (`mods/mimic_follow/`). Ninguno copia expresiones
humanas.

**Consecuencia para nosotros**: el mimic es un problema del *bridge*, no del
firmware. El bridge corre en la Mac, que tiene cámara. Bridge detecta cara →
computa las mismas 4 señales → las manda como estado (emulador hoy, robot
mañana). El robot solo renderiza — exactamente nuestra arquitectura D-firmware-
decides-nothing.

### El balloon bonito: qué tiene cada firmware

| | Moddable (`stack-chan`, nuestro target) | Factory (M5Stack) | Nuestro emulador hoy |
|---|---|---|---|
| Forma | 9-slice PNG redondeado (`effects/speech-balloon.ts`) | píldora `LV_RADIUS_CIRCLE` (`skins/default/speech_bubble.cpp`) | rect radius 6 |
| **Cola hacia la boca** | **no existe** | flecha triangular, offset fijo `(40,-15)` | no |
| Tamaño | auto-wrap + auto-height según texto | ancho auto 90–340 px, alto fijo 52 | ancho fijo full-width |
| Colores | `theme.primary`/`secondary` de la cara | `primaryColor`/`secondaryColor` del skin | blanco/negro hardcoded |
| Texto largo | wrap multi-línea | marquee circular | marquee |
| Posición | anclas `left/right/top/bottom` (default top-right) | fijo bajo los ojos `(0,89)` | fijo abajo |

El emulador porta el balloon **legacy** del firmware (`renderers/decorator.ts`,
el stack viejo de canvas), no el actual (`renderers-piu/effects/
speech-balloon.ts`). La sensación de "el original es más estético" es real:
estamos imitando la versión obsoleta.

**Dato duro para la cola**: ninguno de los dos firmwares ancla el balloon a la
boca dinámicamente. El factory tiene una flecha con offset fijo. Si queremos
"sale de la boca", lo agregamos nosotros — en emulador **y** en nuestro fork
del firmware (la boca de `SimpleFace` está en `cx:100, cy:88` sobre una caja
de cara de 200×120 en `left:60, top:60`; el anclaje es computable).

## No-objetivos (YAGNI)

- **Video-call / passthrough de cámara** (factory): relay de JPEG sin
  inteligencia, alto costo, cero valor de companion.
- **App store, capa social, joystick ESP-NOW** (factory `server/`, `remote/`):
  otro producto.
- **Avatar packs con sprites** (`mods/image_avatar_lite`): el schema queda
  como referencia; no se implementa hasta que alguien pida caras ilustradas.
- **Marquee del balloon**: superado por wrap + auto-height del balloon actual.

## Diseño

### Feature A — Balloon estético (la prioridad)

Reemplazar el balloon del emulador por uno equivalente al `SpeechBalloon`
actual del firmware Moddable, más la cola:

1. **Geometría**: burbuja redondeada (radio grande, no 6 px), padding
   `paddingX:18, paddingY:10, minHeight:32` (valores del firmware), ancho
   auto según texto con `min/max`, alto que crece con wrap multi-línea
   (algoritmo `countWrappedLines`/`resolveHeight` de `speech-balloon.ts:98-125`).
2. **Cola**: triángulo suave anclado hacia la boca (`cx:100, cy:88` del
   layout de `SimpleFace`, cara de 200×120 en `left:60, top:60`), del mismo
   color de la burbuja. **Geometría concreta (C6, council)**: los ojos ocupan
   la banda vertical y≈70–110 de la pantalla; el balloon se posiciona en la
   franja superior (y < 60) con la cola bajando hacia la boca, o en la franja
   inferior (y > 150) con la cola subiendo. El plan de implementación fija
   los píxeles exactos; el criterio es que ni burbuja ni cola invadan la
   banda de los ojos.
3. **Tema de 2 colores**: burbuja = `theme.primary`, texto =
   `theme.secondary`. El emulador adopta el modelo de paleta del firmware
   (`face-context.ts`): **dos colores semánticos, no colores por parte**.
   Hoy el emulador hardcodea blanco/negro.
4. **Honestidad**: la cola no existe en el firmware upstream. Se ancla en
   DECISIONS que nuestro fork del firmware implementará el mismo balloon
   (geometría + cola + tema), y entra en DEBT como divergencia consciente
   hasta que el firmware exista. Igual que se hizo con `pulse`, pero en la
   dirección opuesta: aquí la divergencia es un compromiso escrito, no un
   accidente.

El wrap del firmware usa la fuente bitmap `k8x12-12`; el emulador debe usar
una métrica monospace equivalente (8×12) para que el wrapping no diverja del
hardware real. Se anota en el plan de implementación como criterio de test.

### Feature B — Vida percibida (modifiers)

El emulador ya tiene blink, breath y saccade (`face-renderer.js:405-409`,
mismos parámetros que el firmware). Se adoptan del factory los que faltan y
tienen equivalente en nuestro stack:

1. **IdleExpressionModifier** (híbrido server-marca / device-anima, rev 3):
   micro-expresión aleatoria cada 2–6 s cuando no hay evento activo (una ceja
   de duda, un ojo entrecerrado). La micro-expresión es **cosmética** — no
   comunica un evento, es "vida", igual que blink/breath/saccade, que ya
   corren client-side (`face-renderer.js:404`) y device-side en el firmware
   factory (autónomos, no empujados por un server). Emitirla como
   `ResolvedState` server-authoritative crearía un firehose BLE cada 2–6 s
   para algo que el firmware genera solo — el mismo anti-patrón que el council
   marcó para el face-mimic (C5). **Decisión**: el servidor sólo expone un
   flag `idle` autoritativo (sabe si el AM tiene evento activo: `active ===
   null` → `backgroundMood`); el cliente/firmware corre la micro-expresión
   como modifier cosmético **gated por ese flag**. El servidor manda el
   *cuándo* (idle sí/no), el device el *cómo* (la animación). Respeta S2.5.1
   —la autoridad de "estoy idle" sigue en el server— sin tráfico BLE extra.
2. **HeadPetModifier**: reacción a caricia. Hoy el tap aprueba permisos y el
   hold duerme; `swipe_fwd`/`swipe_back` quedan **reservados para navegar la
   cola de notifs en Fase 3** (ROADMAP §Fase 3). Para la caricia se agrega un
   gesto dedicado `gesture: 'pet'` al evento `touch_head`, con reacción HAPPY
   + decorator heart y TTL corto vía `stateRules`. **No aprueba ningún
   permiso** (sólo `tap` lo hace). El firmware factory ya distingue la
   caricia; el Moddable expone el touch panel — verificar en Fase 0 qué gestos
   reporta el hardware real (queda en DEBT como capacidad no validada, C7).
3. **SpeakingModifier** (boca sincronizada a audio): **diferido a Fase 5
   (voz)**. Sin TTS no hay nada que sincronizar.

### Feature C — Face-mimic desde el bridge (fase propia, con gate)

La versión buildagotchi del "te copia la cara":

1. El bridge captura la webcam de la Mac y computa las 4 señales del pipeline
   factory (yaw, pitch, ojo izq/der, sonrisa). Candidatos: MediaPipe
   Face Landmarker vía tfjs en un worker, o el port de la fórmula exacta de
   `dataConversionTesting()`.
2. Las señales llegan al robot/emulador que solo renderiza, fiel a
   D-firmware-decides-nothing. **El transporte NO es el `ResolvedState`
   directo (C5, council)**: el pipeline state machine → recorder → BLE está
   diseñado para transiciones discretas; 15 fps por ahí es un firehose que
   además ensucia el event log. El gate debe decidir entre (a) canal lateral
   dedicado tipo `ControlMotion` del factory (fuera del recorder, fuera del
   AM) o (b) estado throttleado con exclusión del recorder. La decisión de
   transporte es parte del resultado del gate, no del plan.
3. Modo explícito (`MIRROR`), activado por el usuario — no cámara siempre
   encendida. Al salir del modo, la cámara se libera.

**Gate de entrada** (antes de cualquier plan): prototipo desechable que
demuestre (a) detección de cara + las 4 señales a ≥15 fps en la Mac con
<20 % de CPU, y (b) una decisión de transporte escrita con números (¿cuántos
mensajes/segundo aguanta el camino elegido? ¿qué pasa con el recorder?). Si
el prototipo no pasa, la feature no entra. Privacidad: los frames nunca salen
del proceso; solo persisten las 4 señales si el usuario lo pide.

### Feature D — Contratos para cuando llegue el robot (solo anclar, no construir)

Dos hallazgos que fijan decisiones futuras, sin código hoy:

1. **MCP en el firmware**: `mods/mcp/mod.js` del Moddable ya expone
   `set_emotion`/`say_message` por MCP en el puerto 8080 del robot. Cuando el
   robot llegue, evaluar si nuestro transporte BLE se complementa con este
   canal para debugging (anclar en DECISIONS como opción, no compromiso).
2. **Wire format del mimic**: si alguna vez interoperamos con hardware
   factory, el formato `ControlAvatar`/`ControlMotion` JSON es el que ese
   hardware espera. Referencia, no dependencia.

## Prioridad recomendada

1. **Feature A (balloon)** — barata, visible cada día, corrige una imitación
   del stack obsoleto. Primera.
2. **Feature B (modifiers)** — pequeña, sube vida percibida. Segunda.
3. **Feature C (mimic)** — la más vistosa pero la más cara; entra solo tras
   pasar su gate de prototipo. Tercera.
4. **Feature D** — solo escritura en DECISIONS. Se hace junto con A.

## Criterios de aceptación

1. El balloon del emulador se dibuja con burbuja redondeada, cola hacia la
   boca, colores del tema, y crece en alto con textos largos (sin marquee).
2. Con el mismo texto, el número de líneas del wrap coincide con el que
   produciría `k8x12-12` en 320 px (test con casos borde: 1 línea, 2 líneas,
   texto con palabra más larga que el ancho).
3. DECISIONS ancla el compromiso del balloon en firmware y la opción MCP;
   DEBT registra la divergencia emulador-firmware del balloon con su costo.
4. El servidor expone un flag `idle` autoritativo (true sólo cuando el AM no
   tiene evento activo). El cliente corre la micro-expresión **sólo** cuando
   `idle === true`; en cuanto llega un evento (balloon/emoción del AM) la
   suprime. La micro-expresión **nunca** altera el `ResolvedState` ni viaja
   por el bus/BLE — es un modifier cosmético como blink/breath.
5. `touch_head` con `gesture: 'pet'` produce reacción HAPPY + heart con TTL
   ≤ 5 s y **no aprueba ningún permiso** (sólo `tap` lo hace). `swipe_fwd`/
   `swipe_back` quedan libres para Fase 3. **El gesto `pet` es emulador-only
   hasta que Fase 0 confirme qué gestos reporta el touch real del CoreS3**
   (C7, council) — se registra en DEBT como capacidad no validada en hardware.
6. El gate del mimic tiene un resultado escrito (fps, CPU y decisión de
   transporte con números) antes de que exista cualquier plan de
   implementación de la Feature C.
