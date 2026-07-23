# Session log — buildagotchi hardware

Bitácora corta de lo que se hace en cada sesión con el kit / bridge.  
Detalle de problemas → [NOTES.md](../NOTES.md) § Log de problemas.  
Relato largo → [DEVLOG.md](../DEVLOG.md).

**Convención:** al cerrar (o mid-sesión si es largo), añadir una entrada con:
hechos, problemas, commits, siguiente paso.

---

## 2026-07-22 (tarde/noche)

### Hechos
- Fase 0 cerrada en kit CoreS3.
- Fase 1B: bridge noble ↔ MOD `buildagotchi_ble` (NUS D7).
- Balloon en pantalla del robot.
- Remount de cara al conectar BLE.

### Commits
- `0d4c22f` — Fase 1B BLE real
- `01393d7` — balloon en firmware
- `d78dbe1` — remount face on connect

### Problemas (ver tabla en NOTES)
UARTServer reboot-loop; ADV overflow; state_sync faltante; NUS 64 B;
ojo a medias por Contour stale; puerto LG vs CoreS3.

### Siguiente
Touch cabeza → eventos al bridge (Gate 1).

## 2026-07-22 (noche) — touch BLE

### Hechos
- MOD emite `event` touch/button + TX chunking.
- `touchPanel hooked`; botones A/B/C ausentes en CoreS3.
- Código listo en bridge (`handleDeviceInput` press/release → tap).

### Problema → fix
- Si12T default → siempre `[0,0,0]`. Fix: `sensitivityType:1, sensitivityLevel:0`.
- Gestos antes de CCCD notify se perdían. Fix: cola `pendingOut` + flush al enable.
- Botones A/B/C ausentes en CoreS3 (esperado).

### Evidencia E2E
- Serial: `gesture press` / `release` + FIRST non-zero `[3,3,0]`.
- BLE: `event` `{kind:touch, detail:{gesture:press|release}}` (flush de cola).
- Retest estructurado: taps OK (press/release); zonas/intensidad poco discriminantes;
  pets: 0 (solo `backwardSwipe` en strokes). → backlog **D-17**.

### Siguiente
- Probar con bridge real (tap aprueba permiso).
- Gate 1 uso diario.
- Pet/`head_pet` fiable: D-17 (no bloquea).

## 2026-07-22 (noche) — balloon abajo

### Hechos
- Balloon estaba arriba por `top: 6` en el MOD.
- Alineado a defaults upstream SpeechBalloon: `{ left:16, right:16, bottom:12 }` (sin `top`/`width`).
- Reflash + demo: hola / permiso pendiente / wrap largo.

### Feedback
- Usuario: letra muy pequeña, muy cuadrado — no parece original.

## 2026-07-22 (noche) — balloon trial factory

### Hechos
- Trial estilo factory M5Stack (`speech_bubble.cpp`): H=52, W 90–300, OpenSans-24.
- Posición bajada a `top:164` (debajo de la boca ≈148).
- Flecha factory tip-up; luego ×1.5; luego restaurada 28×32 exacta del asset factory.
- Quitada cola del `SpeechBalloon`/`bubble.png` → píldora propia `bubble-pill.png`.
- Fuente: `OpenSans-Regular-16` (mismo tamaño que `lv_font_montserrat_16`; forma ≠ Montserrat).

### Siguiente
- Confirmación visual; si hace falta Montserrat real → empaquetar TTF; commit si OK.

## 2026-07-22 (noche) — presets balloon

### Hechos
- Factory set guardado como `FACTORY_BALLOON` en MOD (`BALLOON_STYLE = 'factory'`).
- Emulator Feature A como `'emulator'`.
- Activo: `'hybrid'` — burbuja r=14 + flecha factory (colita de pez, offset +40) + OpenSans-16 + marquee circular en textos largos.
- Switch: `BALLOON_STYLE = 'factory' | 'emulator' | 'hybrid'`.
- Usuario OK con hybrid (2026-07-22 noche). Nota menor: pixels negros en bordes del 9-slice (aceptable). Marquee 1 línea OK.
