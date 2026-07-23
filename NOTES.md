# NOTES — Fase 0 (Discovery)

Plantilla para registrar la evidencia real del kit y del entorno.
Llenar mientras se ejecuta [SETUP.md](SETUP.md) y los pasos de Fase 0 del
[ROADMAP.md](ROADMAP.md).

**Regla**: si algo no se pudo verificar, anotar *"no verificado"* en vez de
inventar. Si algo funciona pero raro, describir el "raro". Este archivo es
evidencia — sirve para las decisiones posteriores, no para lucirse.

**Sesión 2026-07-22**: toolchain OK → host release flasheado → boot Wi‑Fi OK →
smoke MOD de servo/LED corrió (con muchos `timeout.` de servo). Falta checklist
visual del usuario (cara/servos/LEDs) y R2/R7 completos.

---

## Versiones instaladas

Llenar tras Sección A del SETUP.

- **macOS**: `26.4.1` (Build 25E253)
- **Chip Mac**: `arm64` (Apple Silicon)
- **Xcode CLT**: `/Library/Developer/CommandLineTools`
- **Homebrew**: `6.0.12`
- **Node**: `v26.3.0`
- **Python**: `3.14.6` (Homebrew); ESP-IDF usa venv `idf6.0_py3.14_env`
- **ModdableSDK commit**: `23b4d6b` (tag `8.3.1`) en `~/.local/share/moddable`
- **ESP-IDF versión**: `v6.0` en `~/.local/share/esp32/esp-idf`
- **stack-chan commit**: `e33094a4` (subdir `stack-chan/`)

Instalación vía `xs-dev` (recomendado por stack-chan), no clone manual a
`~/Projects/moddable`. Env persistido en `~/.zshrc`:
`MODDABLE`, `PATH` (+ mcconfig), `IDF_PATH`, alias `get_idf`.

---

## Setup del SDK

- [x] A1 — Prerrequisitos macOS instalados
- [x] A2 — ModdableSDK instalado y `mcconfig` responde (`xs-dev setup`)
- [ ] A3 — Simulador Mac (helloworld) corrió OK — *no verificado* (saltado; ESP32 ok)
- [x] A4 — ESP-IDF instalado (`xs-dev setup --device=esp32`, doctor muestra esp32)
- [x] A5 — Build host para `esp32:./platforms/m5stackchan_cores3` completa sin errores
- [x] A6 — Deps stack-chan: `npm i` en `firmware/`; hace falta `node_modules/.bin` en PATH para `tsc`

**Problemas encontrados en el setup** (versión que no compila, comando que no
existe, cosa que estaba desactualizada en docs):

```
- SETUP.md apunta a ~/Projects/moddable + ESP-IDF v5.x; realidad 2026-07-22:
  Moddable 8.3.1 pide ESP-IDF v6.0. xs-dev instala en ~/.local/share/{moddable,esp32}.
- `mcconfig -t deploy` sin build previo: "Please build before deploy".
- Build falla si `tsc` no está en PATH → export PATH="$PWD/node_modules/.bin:$PATH".
- Warning benigno: no modules match .../typings/btutils
- pyserial: xs-dev avisó que no pudo instalarlo en el Python de sistema;
  ya está en el venv de IDF 6.0.
```

---

## Primer boot del kit

Llenar cuando llegue el CoreS3 y esté flasheado (Sección B).

### B1 — Reconocimiento

- **Path serial de la CoreS3**: `/dev/cu.usbmodem101`
  (`303A:1001` Espressif "USB JTAG/serial debug unit", MAC `68:EE:8F:D7:40:A8`)
- **Falso positivo a ignorar**: `/dev/cu.usbmodem811NTVSCT9432` = LG "USB Controls"
- **Driver necesario**: ninguno (USB-Serial/JTAG nativo)
- **Reconocido tras cable**: sí, al conectar el CoreS3 directo al Mac

### B2 — Flash del firmware stock

- **Comando exacto usado**:
  ```
  export MODDABLE=$HOME/.local/share/moddable
  export PATH="$PWD/node_modules/.bin:$MODDABLE/build/bin/mac/release:$PATH"
  export IDF_PATH=$HOME/.local/share/esp32/esp-idf
  export UPLOAD_PORT=/dev/cu.usbmodem101
  . "$IDF_PATH/export.sh"
  cd stack-chan/firmware
  # IMPORTANTE: sin -d (release). Con -d el host se cuelga esperando xsbug.
  mcconfig -m -p esp32:./platforms/m5stackchan_cores3 -t build \
    "$PWD/stackchan/manifest_m5stackchan_cores3.json"
  python -m esptool --chip esp32s3 -p $UPLOAD_PORT -b 460800 \
    --before default-reset --after hard-reset write-flash \
    --flash-mode dio --flash-freq 80m --flash-size 16MB \
    0x0 .../bootloader.bin 0x8000 .../partition-table.bin 0x10000 .../xs_esp32.bin
  ```
- **Duración del build**: ~113 s debug / ~163 s release (IDF cache)
- **Tamaño final del binario**: release `xs_esp32.bin` = 3 741 456 bytes; hash verified
- **Warnings notables**: `typings/btutils` no match; ninja jobserver pipe warning
- **Errores encontrados**: debug build (`-d`) bootea pero espera xsbug (`<?xs-00000000?>`).
  Release OK. Primer intento falló por puerto LG equivocado.

### B3 — Primer boot

- [x] Pantalla enciende — confirmado por usuario (2026-07-22)
- [x] Cara renderiza (emoción de partida): cara visible (detalle de emoción no anotado)
- [x] Servos se mueven al arranque: usuario vio que **bajó** (tilt) en smoke 2026-07-22; pan no confirmado; 77× `timeout.` en serial
- [x] LEDs patrón inicial: confirmado visual + serial (`red` → `blink green` → `rainbow` → `lightOff`)
- [ ] Speaker emite sonido: *no verificado*
- [x] Sin panics en monitor: sí (smoke llegó a `complete`; 77× `timeout.` de servo)

**Log del monitor** (tras flash release + smoke MOD):

```
ESP-ROM:esp32s3-20210327
[main] start wasm=false
WiFi connect → Connected to: The Promised WLAN KP
Got IP address: 10.70.121.164
[main] loading default mod
[main] onLaunch shouldRobotCreate=true
[scservo] serial port=1 tx=6 rx=7 baud=1000000
[py32] version: 0x41
[m5stackchan-servo] configured PY32 servo power pin 0
[m5stackchan-servo] servo power on (true)
[main] robot created
[M5StackChan CoreS3 smoke] start
[M5StackChan CoreS3 smoke] servo: torque on / neutral / yaw-pitch / torque off
[M5StackChan CoreS3 smoke] LED: lightOn red / lightBlink green / lightRainbow
(+ muchos "timeout." intercalados — probable bus servo / idle)
```

---

## Validación de riesgos

### R2 — ESP32-S3 con todo activo (mod "gordo")

Correr un mod que ejercite BLE + audio + servos + LEDs + display + touch en
paralelo, durante 5+ min.

- **Mod usado**:
  1. `mods/m5stackchan_smoke` — servo + LED (primer boot)
  2. `mods/fase0_r2` (local) — BLE advertise + LED cycle + head motion + WiFi + cara
- **Config usada**: `manifest_m5stackchan_cores3.json` (driver `m5stackchan`)

Observado (~90 s instrumentado + smoke previo + **5 min** serial sin panic):

- [x] BLE advertising activo — Mac/`bleak` ve `buildagotchi-r2`
  (addr `D3812F91-…`, RSSI ≈ −42…−51 dBm, 26 hits en ~25 s)
- [ ] Mic captura audio correctamente — *no verificado* (sin mod de audio)
- [ ] Speaker reproduce sin cortes — *no verificado*
  (`beacon_advertiser` upstream sin WAVs en `assets/`; crash al cargar)
- [x] Servos responden en tiempo real — tilt visible en smoke; `fase0_r2` manda
  poses y/p cada 4 s; pan también en poses serial
- [x] LEDs animan en paralelo — smoke + ciclo RGB de `fase0_r2` (0 LED errors);
  confirmado visual por usuario 2026-07-22
- [x] Cara sigue renderizando fluido — cara visible con WiFi+BLE+servos+LEDs;
  cabeza en movimiento confirmada visual por usuario 2026-07-22
- [x] Touch cabeza responde — press/release por BLE (Si12T high/0 + event queue, 2026-07-22)
- [x] Sin reinicios / panics / brownouts (ventana instrumentada)
- [ ] `robot.button.a` — **ausente** en runtime (`no button.a`); botones físicos
  del CoreS3 no mapean al API `robot.button` con esta config

**Sorpresas** (todo lo que no esperabas):

```
- PY32 responde (version 0x41) y enciende power de servos.
- Bus de servos spamea "timeout." durante smoke; la cabeza igual se mueve.
- `beacon_advertiser` / assets vacíos (.gitkeep) → crash
  "cannot coerce undefined to object" al usar TTS/speeches.
- Host debug (`-d`) espera xsbug; para standalone usar release.
- Instalar mods: hace falta host debug + `xsbug` + `serial2xsbug` + `mcrun -d`.
- BLE + WiFi + servos + LEDs + display conviven sin derrape en ~90 s+.
```

**Techo observado**: ¿hay alguna combinación que definitivamente derrape?

```
Audio duplex (mic+speaker+BLE+WiFi) aún no ejercitado — pendiente de mod con
assets o TTS local válido. Resto del combo R2 (sin audio) OK.
```

### R7 — Latencia BLE vs WiFi para audio

Medir round-trip PTT → primer chunk audible de respuesta.

- **Método de medición**: no corrido — falta pipeline PTT/STT/TTS con assets/API
- **BLE audio latencia** (si el firmware lo soporta): *no medido*
- **WiFi HTTP audio latencia**: *no medido*
- **BLE para comandos** (proxy de viabilidad): advertising OK a ~−45 dBm a
  distancia de escritorio; adecuado para UART/comandos (D7), no prueba audio
- **Veredicto**:
  ```
  Audio round-trip BLE vs WiFi: no verificado en esta sesión.
  Evidencia parcial: BLE stack del S3 anuncia bajo carga (WiFi conectado +
  servos + LEDs + cara) sin caerse → soporta el diseño "BLE=control,
  WiFi=audio/media" de ROADMAP. Medir PTT queda para cuando haya TTS local
  con WAVs o Voicevox/OpenAI configurado.
  ```

---

## Inventario real de capacidades

Confirmar contra el inventario que hicimos en la investigación previa
(está en DECISIONS.md). Poner ✅ si funciona, ⚠️ si funciona parcial,
❌ si no funciona, ❓ si no pudiste probar.

### Servos

- [x] Pan (X) responde a `robot.setPose({rotation:{y:...}})` — poses `fase0_r2`
- [x] Tilt (Y) responde a `robot.setPose({rotation:{p:...}})` — usuario vio bajada
- **Rango real medido**: X: *no medido formal*, Y: pequeño offset smoke −0.06
- **Ruido audible / vibración**: *no anotado*
- **Notas**: muchos `timeout.` de ack SCServo; movimiento igual ocurre

### Pantalla / cara

- [x] Renderer cara funciona (cara visible post-flash)
- [ ] Todas las emociones cambian: NEUTRAL / HAPPY / SAD / ANGRY / SLEEPY / DOUBTFUL / COLD / HOT
- [ ] Motions vivos activos (blink, breath, saccade)
- [ ] Decorators funcionan (heart, sweat, tear, sleepy Z, angry mark)
- [x] Speech balloon renderiza texto *(MOD `showBalloon` desde `ResolvedState.balloon`, 2026-07-22)*
- **Frame rate observado**: `___`
- **Notas**: cara OK bajo carga R2

### LEDs (12 RGB)

- [ ] Fila izquierda (0-5) direccionable individualmente
- [ ] Fila derecha (6-11) direccionable individualmente
- [x] `lightOn`, `lightOff`, `lightBlink`, `lightRainbow` funcionan (smoke + ciclo R2)
- [ ] Colores se ven fieles a lo especificado
- **Notas**: smoke MOD + `fase0_r2` lightOn cycle

### Touch capacitivo cabeza (3 zonas)

- [ ] `wasClicked()` responde
- [ ] `wasSwipedForward()` responde
- [ ] `wasSwipedBackward()` responde
- [ ] `wasPressed()` (long press) responde
- **Falsos positivos observados**: `___`
- **Notas**: `___`

### Display touch (320×240)

- [ ] `onTouchBegan/Moved/Ended` recibe eventos
- [ ] Coordenadas precisas
- **Notas**: `___`

### Botones (a/b/c/power)

- [ ] Los 4 botones se detectan
- **Mapping físico observado**: (¿cuál es cuál?)

### Micrófonos

- [ ] Captura a 24kHz funciona
- [ ] Ambos mics accesibles (o solo uno)
- **Nivel de ruido base**: `___`
- **Notas**: `___`

### Speaker

- [ ] Playback de WAV funciona
- [ ] TTS de Moddable (`useTTS`) con lip-sync
- **Volumen máximo**: `___`
- **Distorsión notable**: `___`

### BLE

- [x] Advertising visible desde Mac (`bleak`) como `buildagotchi` (mod `buildagotchi_ble`)
- [x] Conexión establece (bleak + `@abandonware/noble`)
- [x] Nordic UART Service (RX write / TX notify) — hello, hb, state, ack, state_applied
- **RSSI a ~escritorio**: ≈ −41…−45 dBm
- **Notas**: ADV solo `completeName` (nombre+UUID128 no caben en 31 B). Scan del
  bridge por nombre, no por service UUID. `UARTServer` subclass reboot-loopeaba
  en CoreS3 → usar `BLEServer` directo (host ya incluye `uart` bleservices).

### WiFi

- [x] Conecta a la red configurada (`The Promised WLAN KP` → `10.70.121.164`)
- [ ] HTTP request outbound funciona — *no verificado explícitamente*
- **Notas**: credenciales ya estaban en el kit

### IMU (bonus, si tocaste)

- [ ] Acelerómetro reporta datos
- [ ] Se detecta "shake"
- **Notas**: `___`

---

## Protocolo BLE de claude-desktop-buddy (REFERENCE.md)

Notas de lectura del protocolo — cosas que hay que replicar en Moddable en
Fase 1.

**UUIDs** (Nordic UART Service — confirmados 2026-07-22 contra
`claude-desktop-buddy/REFERENCE.md` y Moddable `uartserver.js`):
- Service: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX (bridge → firmware, write): `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX (firmware → bridge, notify): `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

**Nota de naming:** en NUS, "RX" es desde el punto de vista del peripheral
(lo que el central escribe). El bridge escribe en RX y se suscribe a TX.

**Formato de mensajes (buildagotchi D7, no el snapshot de Claude Desktop):**

```
{ "v": 1, "seq": N, "t": "hello"|"state"|"state_sync"|"ack"|"state_applied"|"hb"|"event",
  "ts": <ms>, "p": { ... } }\n
```

**Frecuencia**:
- Heartbeat bridge↔fw: cada `ble.heartbeatSeconds` (default 5s); 3 misses = dead
- state: solo en cambio real; state_sync siempre al (re)conectar

**Advertise name (1B):** `buildagotchi` (prefix filter en NobleTransport)

**Comandos / tipos `t` que el firmware debe soportar:**

```
hello, state, state_sync, hb  (inbound)
ack, state_applied, hb, hello, event  (outbound)
```

**Cosas que hay que extender** (D3 event model, D7 seq/ack + heartbeat +
state_sync, D16 safe mode, D17 error budget, D23 state_applied ack):

```
Firmware MOD buildagotchi_ble: aplicar ResolvedState a robot API;
safe mode SLEEPY a 15s sin tráfico; event touch/button best-effort.
```

**Trampas identificadas** (cosas que la spec no cubre bien y hay que decidir):

```
- robot.button.a ausente en CoreS3 con config actual — eventos botón vía otra API.
- Host debug espera xsbug; release para standalone.
- Audio assets de mods upstream vacíos — no bloquear 1B.
```

---

## Smoke test Q4 — @abandonware/noble en macOS (M0, 2026-07-06)

Corrido antes de Fase 0 (no requiere kit — solo el stack BLE de la Mac).

- **Entorno**: Node v26.3.0, macOS Darwin 25.4.0 (Apple Silicon).
- **Instalación**: `npm install @abandonware/noble` → OK (v1.9.2-26). El
  binding nativo carga sin compilar (prebuilds via node-gyp-build). El
  riesgo "no compila en Node moderno" **no se materializó**.
- **Estado del adapter**: `noble.state` queda en `unknown` y `stateChange`
  no dispara corriendo desde un shell no-interactivo — falta el permiso TCC
  de Bluetooth para el proceso host. Esperado (Q1): el consent dialog
  necesita sesión de usuario interactiva.
- **Veredicto**: noble es viable como transport 1B. Pendiente para M6:
  correr el scan desde la app con permiso Bluetooth concedido (Terminal o
  el LaunchAgent) y verificar advertising real. El plan B (helper Swift/
  CoreBluetooth) queda en reserva, no se activa.

---

## Sorpresas y decisiones a revisar

Todo lo que aparezca en Fase 0 que contradiga o refine algo de
[DECISIONS.md](DECISIONS.md).

### Sorpresas encontradas

```
- Target correcto: esp32:./platforms/m5stackchan_cores3 +
  manifest_m5stackchan_cores3.json (driver m5stackchan, LEDs PY32).
- No usar -d para smoke standalone: el host debug espera xsbug y no pinta.
- /dev/cu.usbmodem* del monitor LG se confunde fácil con el CoreS3;
  filtrar por vid 303A (Espressif).
- WiFi del kit ya tenía credenciales; conectó a "The Promised WLAN KP"
  sin configurar en esta sesión.
- Smoke de servos avanza con rain of "timeout." — investigar bus/IDs.
```

### Decisiones que hay que revisar en DECISIONS.md

- **D___**: `___` (qué cambiar y por qué)

### Riesgos nuevos identificados (candidatos a R9, R10, ...)

- **R___ candidato**: download-mode / USB Serial-JTAG del CoreS3 puede requerir
  gesto físico; documentar el procedimiento una vez hallado.

---

## Veredicto de Fase 0

Después de completar todo lo anterior, escribir un párrafo corto respondiendo:

1. **¿El kit hace lo que dijimos que hace?** (sí / mayormente / no y por qué)
2. **¿Hay algún riesgo del R1-R8 que sea peor de lo estimado?**
3. **¿Hay que ajustar el diseño de Fase 1 antes de arrancar?**
4. **¿Estás listo para arrancar Fase 1?**

```
1. Kit sí: cara, servos (tilt+pan), LEDs, WiFi, BLE advertise bajo carga.
2. R2 sin audio: OK. Audio/mic/speaker y touch/botones API quedan abiertos.
3. R7 audio no medido; diseño BLE=control / WiFi=media sigue razonable.
4. Fase 1B (noble + protocolo) puede arrancar; no bloquear por R7 audio.
   Medir PTT cuando haya TTS con assets.
```

---

## Fase 1B — BLE real (2026-07-22)

### Entregables

| Pieza | Path |
|---|---|
| NUS constants | `bridge/src/ble/nus.ts` |
| NobleTransport | `bridge/src/ble/transport-noble.ts` |
| Wire run | `bridge/src/index.ts` (`--simulate` → Sim; else Noble) |
| Firmware MOD | `firmware/mods/buildagotchi_ble/` (+ mirror en `stack-chan/...`) |

### Evidencia hardware

- MOD boot: `[buildagotchi_ble] advertising as buildagotchi` (sin RTC reboot loop).
- Advertise: `bleak` ve `buildagotchi` ~−43 dBm.
- Protocolo (bleak → NUS): `hello` ↔ fw hello; `state` → `ack` + `state_applied`
  para HAPPY / ANGRY / SAD; disconnect arma safe mode (SLEEPY ~15 s).
- Bridge real: `npx tsx bridge/src/index.ts run --config ./config.yaml` →
  `noble connected` + `ble link up`; `/health` →
  `transport.kind=noble, connected=true`.
- Tests: `vitest` nus + transport-noble → 7 passed.

### Confirmación visual (usuario)

- [x] Cara cambió con los `state` HAPPY/ANGRY/SAD *(ciclo bleak 1B; confirmado usuario)*
- [x] Tras matar el bridge / desconectar BLE → SLEEPY *(confirmado)*
- [x] Reiniciar bridge → `state_sync` restaura cara *(confirmado usuario 2026-07-22)*
- [x] Balloon texto + clear sin sleepy *(confirmado)*
- [x] Remount face al connect restaura dos ojos *(confirmado)*

---

## Log de problemas (hardware / BLE)

Bitácora viva. Cada incidente nuevo: fecha, síntoma, causa, fix.  
El relato de sesión va también a [DEVLOG.md](DEVLOG.md).

| Fecha | Síntoma | Causa | Fix / estado |
|---|---|---|---|
| 2026-07-22 | Flash/esptool al monitor LG | `cu.usbmodem811…` ≠ CoreS3 | Usar `cu.usbmodem101` (303A) |
| 2026-07-22 | Cara negra / no arranca solo | Host `-d` espera xsbug | Release / sin debug host |
| 2026-07-22 | Reboot loop al abrir UARTServer | Bug/crash stack BLE+UARTServer en CoreS3 | MOD con `BLEServer` |
| 2026-07-22 | No aparece en scan BLE | ADV overflow name+UUID128 | Solo `completeName` |
| 2026-07-22 | Link up, cara SLEEPY | Sin `state_sync` inicial | Seed + sync post-hello |
| 2026-07-22 | Solo boca / cara rota | Write NUS > 64 B truncado | Chunking noble |
| 2026-07-22 | “Sin balloon” = sleepy | Disconnect → D16 | Esperado; clear≠disconnect |
| 2026-07-22 | Un ojo a medias | Eyelid Contour stale + servo timeouts | Remount `SimpleFace` on connect |
| 2026-07-22 | Serial USB mudo | JTAG tras xsbug | Reset físico / replug |
| 2026-07-22 | Touch cabeza siempre `[0,0,0]` | Si12T sensibilidad default baja | `configure({sensitivityType:1,sensitivityLevel:0})` — FIRST non-zero + press |
| *(abierto)* | Rain `timeout.` scservo | Bus/IDs/power | Investigar; remount mitiga cara |
