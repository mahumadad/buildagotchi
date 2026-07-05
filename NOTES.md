S# NOTES — Fase 0 (Discovery)

Plantilla para registrar la evidencia real del kit y del entorno.
Llenar mientras se ejecuta [SETUP.md](SETUP.md) y los pasos de Fase 0 del
[ROADMAP.md](ROADMAP.md).

**Regla**: si algo no se pudo verificar, anotar *"no verificado"* en vez de
inventar. Si algo funciona pero raro, describir el "raro". Este archivo es
evidencia — sirve para las decisiones posteriores, no para lucirse.

---

## Versiones instaladas

Llenar tras Sección A del SETUP.

- **macOS**: `___`
- **Chip Mac**: `___` (Apple Silicon / Intel — importante para algunos builds)
- **Xcode CLT**: `___`
- **Homebrew**: `___`
- **Node**: `___`
- **Python**: `___`
- **ModdableSDK commit**: `___` (git rev-parse HEAD en $MODDABLE)
- **ESP-IDF versión**: `___` (git describe --tags en $IDF_PATH)
- **stack-chan commit**: `___` (git rev-parse HEAD en stack-chan/)

---

## Setup del SDK

- [ ] A1 — Prerrequisitos macOS instalados
- [ ] A2 — ModdableSDK instalado y `mcconfig -h` responde
- [ ] A3 — Simulador Mac (helloworld) corrió OK
- [ ] A4 — ESP-IDF instalado y `get_idf && idf.py --version` responde
- [ ] A5 — Build helloworld para `esp32/m5stack_cores3` compila sin errores
- [ ] A6 — Deps específicas de stack-chan cubiertas

**Problemas encontrados en el setup** (versión que no compila, comando que no
existe, cosa que estaba desactualizada en docs):

```
(anotar)
```

---

## Primer boot del kit

Llenar cuando llegue el CoreS3 y esté flasheado (Sección B).

### B1 — Reconocimiento

- **Path serial de la CoreS3**: `___` (ej: `/dev/cu.usbmodem1101`)
- **Driver necesario**: `___` (o "ninguno")
- **Reconocido tras cable**: primer intento / tras reset / tras cambio de cable

### B2 — Flash del firmware stock

- **Comando exacto usado**: `___`
- **Duración del build**: `___`
- **Tamaño final del binario**: `___` (aparece al final del flash)
- **Warnings notables**: `___`
- **Errores encontrados**: `___` (o "ninguno")

### B3 — Primer boot

- [ ] Pantalla enciende
- [ ] Cara renderiza (¿qué emoción de partida?): `___`
- [ ] Servos se mueven al arranque: `___` (describir movimiento)
- [ ] LEDs patrón inicial: `___`
- [ ] Speaker emite sonido: `___`
- [ ] Sin panics en `idf.py monitor`: `___`

**Log del monitor** (primeros 30s tras boot, cualquier cosa útil):

```
(pegar)
```

---

## Validación de riesgos

### R2 — ESP32-S3 con todo activo (mod "gordo")

Correr un mod que ejercite BLE + audio + servos + LEDs + display + touch en
paralelo, durante 5+ min.

- **Mod usado**: `___` (ej: `ai_stackchan`, `chat_audioio`)
- **Config usada**: `___` (API keys temporales, WiFi, etc.)

Observado durante ~5 min:

- [ ] BLE advertising activo (verificar con LightBlue o similar desde iPhone/Mac)
- [ ] Mic captura audio correctamente
- [ ] Speaker reproduce sin cortes
- [ ] Servos responden en tiempo real
- [ ] LEDs animan en paralelo
- [ ] Cara sigue renderizando fluido
- [ ] Touch cabeza responde
- [ ] Sin reinicios / panics / brownouts

**Sorpresas** (todo lo que no esperabas):

```
(anotar)
```

**Techo observado**: ¿hay alguna combinación que definitivamente derrape?

```
(anotar)
```

### R7 — Latencia BLE vs WiFi para audio

Medir round-trip PTT → primer chunk audible de respuesta.

- **Método de medición**: `___` (cronómetro, logs, oscilloscopio, etc.)
- **BLE audio latencia** (si el firmware lo soporta): `___` ms
- **WiFi HTTP audio latencia**: `___` ms
- **Veredicto**: ¿BLE es viable para audio o hay que ir por WiFi?

```
(escribir conclusión)
```

---

## Inventario real de capacidades

Confirmar contra el inventario que hicimos en la investigación previa
(está en DECISIONS.md). Poner ✅ si funciona, ⚠️ si funciona parcial,
❌ si no funciona, ❓ si no pudiste probar.

### Servos

- [ ] Pan (X) responde a `robot.setPose({rotation:{y:...}})`
- [ ] Tilt (Y) responde a `robot.setPose({rotation:{p:...}})`
- **Rango real medido**: X: `___`, Y: `___`
- **Ruido audible / vibración**: `___`
- **Notas**: `___`

### Pantalla / cara

- [ ] Renderer `simple-face` funciona
- [ ] Todas las emociones cambian: NEUTRAL / HAPPY / SAD / ANGRY / SLEEPY / DOUBTFUL / COLD / HOT
- [ ] Motions vivos activos (blink, breath, saccade)
- [ ] Decorators funcionan (heart, sweat, tear, sleepy Z, angry mark)
- [ ] Speech balloon renderiza texto
- **Frame rate observado**: `___`
- **Notas**: `___`

### LEDs (12 RGB)

- [ ] Fila izquierda (0-5) direccionable individualmente
- [ ] Fila derecha (6-11) direccionable individualmente
- [ ] `lightOn`, `lightOff`, `lightBlink`, `lightRainbow` funcionan
- [ ] Colores se ven fieles a lo especificado
- **Notas**: `___`

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

- [ ] Advertising visible desde otro dispositivo (LightBlue, nRF Connect)
- [ ] Conexión establece
- [ ] Nordic UART Service disponible (o ejemplo equivalente)
- **RSSI a 1m**: `___`
- **Notas**: `___`

### WiFi

- [ ] Conecta a la red configurada
- [ ] HTTP request outbound funciona
- **Notas**: `___`

### IMU (bonus, si tocaste)

- [ ] Acelerómetro reporta datos
- [ ] Se detecta "shake"
- **Notas**: `___`

---

## Protocolo BLE de claude-desktop-buddy (REFERENCE.md)

Notas de lectura del protocolo — cosas que hay que replicar en Moddable en
Fase 1.

**UUIDs** (Nordic UART Service):
- Service: `___`
- TX characteristic (bridge → firmware): `___`
- RX characteristic (firmware → bridge): `___`

**Formato de mensajes**:

```
(pegar el shape principal del snapshot y de permission)
```

**Frecuencia**:
- Snapshot: `___` (cada X segundos o solo en cambios)
- Keepalive: `___` s

**Comandos que el firmware debe soportar**:

```
(listar)
```

**Cosas que hay que extender** (D3 event model, D7 seq/ack + heartbeat +
state_sync, D16 safe mode, D17 error budget, D23 state_applied ack):

```
(anotar mientras leés)
```

**Trampas identificadas** (cosas que la spec no cubre bien y hay que decidir):

```
(anotar)
```

---

## Sorpresas y decisiones a revisar

Todo lo que aparezca en Fase 0 que contradiga o refine algo de
[DECISIONS.md](DECISIONS.md).

### Sorpresas encontradas

```
(anotar libremente)
```

### Decisiones que hay que revisar en DECISIONS.md

- **D___**: `___` (qué cambiar y por qué)

### Riesgos nuevos identificados (candidatos a R9, R10, ...)

- **R___ candidato**: `___`

---

## Veredicto de Fase 0

Después de completar todo lo anterior, escribir un párrafo corto respondiendo:

1. **¿El kit hace lo que dijimos que hace?** (sí / mayormente / no y por qué)
2. **¿Hay algún riesgo del R1-R8 que sea peor de lo estimado?**
3. **¿Hay que ajustar el diseño de Fase 1 antes de arrancar?**
4. **¿Estás listo para arrancar Fase 1?**

```
(escribir aquí)
```
