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

### Siguiente
- Commit touch MOD; probar con bridge real (tap aprueba permiso).
- Gate 1 uso diario.
