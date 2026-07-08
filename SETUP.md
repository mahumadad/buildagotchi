# SETUP — ModdableSDK + toolchain ESP32-S3 en macOS

Guía práctica para arrancar Fase 0 del proyecto ([ROADMAP.md](ROADMAP.md)).
No sustituye a la doc oficial; complementa con notas específicas de nuestro
proyecto y advertencias sobre trampas típicas.

**Docs oficiales que hay que tener abiertas al lado**:
- Moddable — instalación mac + esp32: <https://github.com/Moddable-OpenSource/moddable/blob/public/documentation/Moddable%20SDK%20-%20Getting%20Started.md#mac>
- stack-chan README: <https://github.com/stack-chan/stack-chan>
- stack-chan firmware: <https://github.com/stack-chan/stack-chan/tree/main/firmware>

**Nota sobre la doble identidad de directorio**: el repo público se llama
`buildagotchi` en GitHub, pero el checkout local histórico está en
`~/Dev/personal/Stackchan/`. Todos los paths de esta guía asumen ese local; si
lo clonás fresco, ajustá `~/Dev/personal/Stackchan/` a donde lo pusiste.

Si algo de esta guía contradice la doc oficial, la oficial gana. Las versiones se
mueven; anotá lo que uses en [NOTES.md](NOTES.md).

---

## Sección A — Setup del SDK (podés hacerlo antes de que llegue el kit)

### A1. Prerrequisitos macOS

Asegurate de tener Xcode Command Line Tools y Homebrew:

```bash
xcode-select --install                          # instalador GUI si falta
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew --version                                  # debe responder
```

Herramientas comunes que Moddable + ESP-IDF necesitan:

```bash
brew install python git cmake ninja dfu-util ccache
python3 --version                               # >= 3.9 recomendado
```

Node/TS (para el bridge después; ya lo tenés seguro, pero verificá):

```bash
node --version                                  # >= 20 recomendado
npm --version
```

### A2. Instalar ModdableSDK

**No lo pongo en Dev/personal/Stackchan/** — el SDK vive fuera del repo del
proyecto. Sugerencia: `~/Projects/moddable`.

```bash
mkdir -p ~/Projects && cd ~/Projects
git clone https://github.com/Moddable-OpenSource/moddable.git
cd moddable
```

Anotá el commit hash en [NOTES.md](NOTES.md) → *"Versiones instaladas"*.

Configurar variable de entorno (agregala a `~/.zshrc`):

```bash
export MODDABLE=~/Projects/moddable
export PATH=$PATH:$MODDABLE/build/bin/mac/release
```

Recargá el shell (`source ~/.zshrc`) y verificá:

```bash
echo $MODDABLE
```

Construir las herramientas de Moddable para Mac (una vez, tarda):

```bash
cd $MODDABLE/build/makefiles/mac
make
```

Al terminar, `mcconfig` y `mcrun` deberían responder:

```bash
mcconfig -h
```

Si no responde, revisá el PATH y volvé a `source ~/.zshrc`.

### A3. Prueba con el simulador de Mac (sin hardware)

Antes de tocar ESP32, verificá que el SDK funciona con un ejemplo simple:

```bash
cd $MODDABLE/examples/helloworld
mcconfig -d -m -p mac
```

Debería abrir una ventana con "Hello, world" o similar. Si esto no anda, **no
sigas** hasta resolverlo — probablemente falla el PATH o Xcode.

Cerrá la ventana cuando termines.

### A4. Instalar toolchain ESP32-S3 (ESP-IDF)

Moddable usa ESP-IDF para builds de ESP32. **La versión importa** — Moddable
suele soportar una versión específica; leer la doc oficial (link arriba) para
saber cuál usar en el momento.

Directorio sugerido: `~/esp32/esp-idf`.

Al día de escribir esta doc, Moddable soporta ESP-IDF v5.x. Confirmá el número
concreto en la doc oficial antes de clonar.

```bash
mkdir -p ~/esp32 && cd ~/esp32
git clone -b vX.Y.Z --recursive https://github.com/espressif/esp-idf.git
cd esp-idf
./install.sh esp32s3
```

Agregar al `~/.zshrc`:

```bash
export IDF_PATH=~/esp32/esp-idf
alias get_idf='. $IDF_PATH/export.sh'
```

`get_idf` activa el entorno de ESP-IDF en la shell actual — hay que correrlo
antes de cualquier build de ESP32. **No lo pongas siempre activo**: pisa Python
y otras utilidades.

Verificar:

```bash
source ~/.zshrc
get_idf
idf.py --version                                # debe imprimir la versión
```

### A5. Prueba de build ESP32-S3 sin flashear

Sin el kit todavía, podés al menos verificar que la toolchain compila:

```bash
get_idf                                          # activar ESP-IDF en esta shell
cd $MODDABLE/examples/helloworld
mcconfig -d -m -p esp32/m5stack_cores3
```

Si el build termina sin errores (aunque no haya nada conectado para flashear),
significa que la toolchain está lista. Si falla en la fase de compilación,
resolvé antes de esperar el kit.

Al final del build, verás algo tipo *"Failed to open serial port"* — es
esperado sin hardware.

### A6. Instalar dependencias del stack-chan firmware

El firmware upstream (<https://github.com/stack-chan/stack-chan>) puede requerir
deps adicionales (ej. TypeScript runtime de Moddable). Cloná el repo dentro de
tu checkout local (queda gitignored — es referencia, no vendoring) y seguí su
README:

```bash
cd ~/Dev/personal/Stackchan
git clone https://github.com/stack-chan/stack-chan.git
# leer stack-chan/README.md y stack-chan/firmware/README.md
# seguir sus instrucciones específicas; anotar cualquier paso extra en NOTES.md
```

---

## Sección B — Cuando llegue el kit

### B1. Reconocer el CoreS3

Conectar el CoreS3 por USB-C. Verificar que macOS lo ve:

```bash
ls /dev/cu.usbmodem* /dev/cu.SLAB_USBtoUART* /dev/cu.wchusbserial* 2>/dev/null
```

Debería aparecer al menos un dispositivo. Anotar el path exacto en NOTES.md — lo
vas a usar como `-p esp32/m5stackchan_cores3 UPLOAD_PORT=/dev/cu.xxx`.

Si no aparece nada, típico problema de driver:
- Para CH340/CH341: instalar driver desde WCH.
- Para CP210x: driver de Silicon Labs.
- Para el chip nativo de la CoreS3: normalmente no necesita driver en macOS reciente.

### B2. Flashear firmware stack-chan stock

Desde `Stackchan/stack-chan/firmware/stackchan`, target `m5stackchan_cores3`:

```bash
get_idf                                          # ESP-IDF activo
cd ~/Dev/personal/Stackchan/stack-chan/firmware/stackchan
mcconfig -d -m -p esp32/m5stackchan_cores3
```

Flags:
- `-d` = debug (con logs)
- `-m` = make (compila desde cero)
- `-p esp32/m5stackchan_cores3` = target del board (manifest específico del kit)

Cuando termina, el firmware queda flasheado y arranca. Deberías ver la cara.

### B3. Primer boot — checklist mínimo

Antes de tocar mods específicos, verificá que arranca:

- [ ] La pantalla enciende y muestra una cara.
- [ ] Los servos hacen algún movimiento inicial (calibración/greeting).
- [ ] LEDs de la base parpadean o hacen algún patrón.

Si algo no arranca, revisá la salida serial:

```bash
# En otra terminal, con get_idf activo:
idf.py -p /dev/cu.xxx monitor
```

Buscar errores tipo `Guru Meditation`, `panic`, `assertion failed`.

Anotar todo en [NOTES.md](NOTES.md) → *"Estado de primer boot"*.

### B4. Probar mods de ejercicio

Para validar R2 (ESP32-S3 con todo activo simultáneamente), correr un mod que
ejercite varias capacidades. `stack-chan/firmware/mods/` tiene ejemplos como
`chat_audioio`, `ai_stackchan`, `look_around`, `light`.

Elegí uno "gordo" (ej. `ai_stackchan` si lo podés configurar con una API key
temporal) y anotá:

- [ ] BLE activo (advertising) mientras suenan el mic y speaker.
- [ ] Servos responden mientras se renderiza la cara animada.
- [ ] LEDs cambian mientras se procesa audio.
- [ ] Sin reinicios ni panics durante 5 minutos de uso.

Si algo derrapa (crash, freeze, brownout, lag notorio), es evidencia dura para
R2 — no seguir con el diseño detallado hasta entender el techo real.

### B5. Medir latencias base (R7)

Objetivo: confirmar que audio duplex por BLE tiene la latencia esperada
(alta) y que WiFi es la ruta correcta para streams.

Si el mod `chat_audioio` o `ai_stackchan` hace PTT + STT + TTS, medir round-trip
"botón apretado → primera palabra hablada" con cronómetro/log. Repetir con y
sin WiFi si es posible.

Números esperados (para calibrar):
- BLE audio: >1s round-trip → confirma que hay que usar WiFi.
- WiFi HTTP: 300-800ms round-trip → viable.

Anotar en [NOTES.md](NOTES.md) → *"Latencias medidas"*.

---

## Trampas comunes en macOS

- **"command not found: mcconfig"** después de reiniciar shell: `$MODDABLE/build/bin/mac/release` no está en el PATH. Verificá `~/.zshrc` y `source`.
- **Error "python: command not found"** durante build: ESP-IDF prefiere `python3`. Ver <https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/> troubleshooting.
- **Permission denied en `/dev/cu.xxx`**: `sudo dseditgroup -o edit -a $USER -t user wheel` (rara vez necesario en Mac), o simplemente ejecutar con `sudo`.
- **Build falla con "SDKConfig mismatch"**: `rm -rf build/tmp` en el directorio del proyecto Moddable y reintentar.
- **Moddable no encuentra IDF**: `get_idf` no fue corrido en la shell actual, o `$IDF_PATH` está mal seteado.
- **CoreS3 no aparece en `/dev/cu.*`**: probar cable USB distinto (los "solo carga" no exponen serial). Reset físico del board.
- **Freezes con Big Sur/Monterey y CH34x drivers**: usar el driver Notarized más reciente de WCH; los viejos causan kernel panics.

---

## Cuando estés listo para el bridge (Fase 1)

El bridge Node/TS aún no se toca en Fase 0. Cuando llegue el momento:

- Directorio: `Dev/personal/Stackchan/bridge/`
- Stack (ver [SPEC-FASE-1.md](SPEC-FASE-1.md) §3 para la fuente de verdad):
  Node 20+, TypeScript strict, `@abandonware/noble` (BLE), **Fastify** (server),
  `zod` (schemas), Keychain vía `security(1)` (credentials, sin dep nativa), `yaml`, `pino` (logs), Vitest (tests),
  Biome (lint/format), `tsx` (dev), `tsc → dist/` para prod (S1.5).
- Arrancar con `npm init` y estructura de adapters desde el día 1 (ver Fase 1 en [ROADMAP.md](ROADMAP.md) y milestones M0-M6 en [SPEC-FASE-1.md](SPEC-FASE-1.md)).

Pero eso viene después de validar Fase 0.
