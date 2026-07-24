# Mapa emulador ↔ firmware (deuda del simulador)

Auditoría 2026-07-23: qué del `ResolvedState` (y del comportamiento del emulador)
llega al robot real y qué no. Método: comparar los consumidores de `resolvedState.*`
en `bridge/src/server/public/dashboard.js` (emulador) contra `firmware/mods/buildagotchi_ble/mod.js`
(`handleState`/`applyLeds`/`applyBalloon`), más las capacidades nativas de
`stack-chan/firmware/stackchan/` (renderers, decorator, sonido).

**Insight central:** el firmware **ya tiene** casi todas las capacidades; el mod
`buildagotchi_ble` **no cablea** varios campos del `ResolvedState`. Cerrar la deuda
es sobre todo *wiring*, no construir. Misma familia que D-03 (pulse) / D-04 (rainbow).

## Campos del ResolvedState

| Campo | Emulador | Firmware (mod) | Capacidad nativa firmware | Veredicto |
|---|---|---|---|---|
| `emotion` | ✅ setEmotion | ✅ `robot.setEmotion` | SimpleFace | OK |
| `leds` | ✅ renderLeds + 3D | ✅ `applyLeds` (+pulse D-03) | PY32Led 12 RGB | OK |
| `balloon` | ✅ setBalloon | ✅ `applyBalloon` (decorator) | `createBalloonDecorator` | OK |
| `servo` (yaw/pitch) | ✅ scene3d.applyServo | ✅ `robot.setPose` | servo scservo/PY32 | OK |
| **`decorators`** | ✅ setDecorators | ✅ **cableado 2026-07-23** (`applyDecorators` → `Emoticon`) | `decorator.ts` + `Emoticon` (`effects/emoticon`) | **CERRADO — verificado en HW** (heart/sweat/angry; thinking/question_mark sin key) |
| **`sound`** | ✅ sound.play | ✅ **cableado 2026-07-23** (`playSound` → `robot.tone`) | `robot.tone(hz,dur)` (AudioOut) | **CERRADO — verificado en HW** (beep de error sonó) |
| **`gaze`** (left/right/center) | ✅ **cableado 2026-07-23** (`setGaze` → post-saccade modifier, ±10 px medido) | ✅ **cableado 2026-07-23** (`gazeBias` en `#modifier` sobre createEyePart, ±12 px) | ojos con gaze en SimpleFace | **CERRADO — wiring probado numéricamente**; verificación visual en robot bloqueada por ruido de la sesión (gaze≠None dura ~300ms antes de ser pisado por prompt/response) |

## Comportamientos idle / de sistema

| Comportamiento | Emulador | Firmware | Veredicto |
|---|---|---|---|
| **Respirar / blink / saccade** (idle liveness) | face-renderer.js (createBreath/Blink/Saccade) | ✅ **`simple-face.ts` los incluye** (breath 6s) | **NO es deuda — el robot ya lo hace nativo** |
| `idle-expression.mjs` | ✅ emulador | ❌ el mod no lo corre (el factory mod sí, ver D-17) | menor |

## Sonidos del emulador (todos mudos en el robot)

`sound-engine.js`: **feedback de gestos** (tap, swipe, hold, buttonA/B/C) + **de estado**
(approve, deny, permission, notification, `modeChange`, error). El robot está **mudo** —
ninguno se reproduce. "Avisaba de decisiones" = sonido `approve`; "cambio de modo" =
sonido `modeChange` (beep 440→660Hz). Ver [[reference_buildagotchi_flash_cores3]] para instalar el fix.

## Decorators: cuáles tienen factory en firmware

`stack-chan/firmware/stackchan/renderers/decorator.ts` expone: `heart`, `angry`,
`sweat`, `bubble`, `pale`, `balloon`. El emulador además usa: `thinking`,
`question_mark`, `sleepy_z`, `hot_steam`. → los primeros son wiring directo;
los segundos **no tienen factory en firmware** (habría que crearlos o mapearlos).

Emoción → decorator automático en el emulador (face-renderer.js:426): HAPPY→heart,
ANGRY→angry_mark, SLEEPY→sleepy_z, COLD→bubble, HOT→hot_steam+sweat.

En `config.yaml` los stateRules usan decorators en 9 reglas: `thinking` (prompt),
`heart` (permission_resolved / head_pet / question_resolved), `sweat` (context_high),
`angry_mark` (error / permission_critical), `question_mark` (question).

## Prioridad sugerida para cerrar

1. **decorators** 🔴 — mayor impacto visual (la cara pierde thinking/heart/sweat/etc.).
   Wiring `state.decorators` → `robot.addDecorator/removeDecorator`. Ojo: solo heart/angry/sweat/bubble/pale
   tienen factory; thinking/question_mark/sleepy_z/hot_steam faltan.
2. **sound** 🟡 — el robot deja de estar mudo (approve/modeChange/notification/error). Confirmar API de audio.
3. **gaze** 🟢 — menor, 1 uso en config.

**Verificar**, no asumir: antes de cerrar cada uno, confirmar en hardware que el
firmware realmente lo hace (la lección de D-03: el emulador miente sobre el HW).
