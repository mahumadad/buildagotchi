---
name: flash-cores3
description: Instala o actualiza el mod buildagotchi_ble en el CoreS3 (Stack-chan) escribiendo el .xsa directo al slot xs con esptool, sobre el host release. Usar cuando haya que flashear, instalar o actualizar el mod, cuando el robot quede con pantalla gris/blanca tras un flash, o para restaurar el host release. Invocar: /flash-cores3
---

# Flash del mod buildagotchi_ble al CoreS3

El mod vive en una partición aparte (slot `xs`, subtype 0x40); el host release lo carga en boot con `Modules.has('mod')`. **No** se instala con `mcrun` a secas: el host release no acepta mod-install por debugger.

## Entorno (el shell no-interactivo no carga `.zshrc`)
```bash
export MODDABLE=$HOME/.local/share/moddable
export IDF_PATH=$HOME/.local/share/esp32/esp-idf
. $IDF_PATH/export.sh
export PATH="$MODDABLE/build/bin/mac/release:$PATH"
export UPLOAD_PORT=/dev/cu.usbmodem101
```
Working dir: `stack-chan/firmware`.

## Vía recomendada: esptool directo al slot (release, sin debug)
1. **Verificar puerto:** `ls /dev/cu.usbmodem*`. El CoreS3 es `cu.usbmodem101` (Espressif "USB JTAG serial debug unit", VID 303A). `cu.usbmodem811…` es el **monitor LG**, nunca flashear ahí. Si no aparece, el robot no está conectado: pedir que lo conecten.
2. **Sincronizar el mod.** Hay dos copias: `firmware/mods/buildagotchi_ble/` (fuente en git) y `stack-chan/firmware/mods/buildagotchi_ble/` (copia de flasheo). Revisar `diff` y copiar desde la fuente:
   `cp firmware/mods/buildagotchi_ble/mod.js stack-chan/firmware/mods/buildagotchi_ble/mod.js`
3. **Build del `.xsa`** (target obligatorio `esp32:./platforms/m5stackchan_cores3`, NO el default `esp32/m5stack`):
   `mcrun -m -p esp32:./platforms/m5stackchan_cores3 ./mods/buildagotchi_ble/manifest.json`
   Sale en `$MODDABLE/build/bin/esp32/release/buildagotchi_ble/buildagotchi_ble.xsa`. `mcrun -m` puede quedar colgado intentando instalar por debugger después de buildear: matarlo, el `.xsa` ya está (verificar fecha del archivo).
4. **Escribir al slot** (<1 s):
   `python -m esptool --chip esp32s3 -p $UPLOAD_PORT -b 460800 --before default-reset --after hard-reset write_flash 0xfa0000 <ruta .xsa>`
   Offset `0xfa0000` = `factory` (0x10000 + 0xf90000). Si cambia `partitions.csv` del build release (`$MODDABLE/build/tmp/esp32/m5stackchan_cores3/release/stackchan/xsProj-esp32s3/partitions.csv`), recalcular.
5. **Verificar:** el reset lo hace esptool (`hard-reset`). Confirmar cara visible + BLE, y por consola serial si hace falta (también da el reset reason).

## Gotchas
- **"Brick" falso (pantalla gris/blanca, sin BLE) = el mod crasheó al boot**, casi siempre por un `import` de un módulo que el host release **no precarga**. El build da exit 0 igual. No está brickeado (el USB sigue enumerando): quitar el import, rebuild, reflash al slot. Imports verificados OK: `behaviors/face`, `effects/emoticon`, `bleserver`, `piu/MC`, `timer`.
- **Un mod es JS puro**: no puede inyectar código nativo. Módulos con parte C (ej. `resetReason`) no sirven aunque se agreguen al `manifest.json` del mod; requieren recompilar el host completo.
- `mcrun -m` (sin `-d`) en ESP32 solo compila, no transfiere. `mcrun -d` sobre host release = xsbug vacío eterno.
- Si un `write_flash` se corta a medias, el puerto sigue vivo (ROM del S3): re-flashear, es recuperable.

## Fallback: pipeline debug (solo si la vía esptool no sirve)
1. Flash del host DEBUG con esptool desde `$MODDABLE/build/tmp/esp32/m5stackchan_cores3/debug/stackchan/xsProj-esp32s3/build` (bootloader 0x0, partition-table 0x8000, xs_esp32.bin 0x10000).
2. `open xsbug.app` + `serial2xsbug /dev/cu.usbmodem101 115200 8N1 &`.
3. **Reset físico del CoreS3 después** de que serial2xsbug esté arriba; recién ahí `mcrun -d -m -p esp32:./platforms/m5stackchan_cores3 ./mods/buildagotchi_ble/manifest.json`. `mcrun -d` no sale solo: matarlo cuando aparezcan trazas en xsbug.
4. Matar mcrun/serial2xsbug/xsbug y flashear el HOST RELEASE (mismo esptool, dir `release/...`). El mod persiste en el slot.

Problema conocido: el host debug a veces no bootea (`_i2c.c (350) # Break: Error: write failed`, tras `configured PY32 servo power` + `RendererCompat`); en ese caso abortar y restaurar release. En release ese write se ignora.

Historial y contexto: `DEVLOG.md` (2026-07-23 en adelante) y `NOTES.md`.
