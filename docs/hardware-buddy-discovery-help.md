# Ayuda: mi dispositivo BLE no aparece en el panel "Hardware Buddy" de Claude Desktop

## Qué intento hacer
Conectar un robot ESP32-S3 propio (M5Stack CoreS3, firmware Moddable SDK) al panel **Hardware Buddy / Bluetooth for makers** de **Claude Desktop** (la API de referencia `github.com/anthropics/claude-desktop-buddy`). Quiero que aparezca en **Developer → Open Hardware Buddy → Connect** para que Claude le mande estados y aprobar permisos desde el dispositivo.

## Qué SÍ funciona (verificado)
- **Claude Desktop v1.24012.1 (macOS)** tiene el panel "Hardware Buddy y Dispositivos Maker" (Developer Mode activado). Claude tiene permiso de Bluetooth de macOS activado.
- **El robot anuncia correctamente el Nordic UART Service.** Confirmado con un scan de `@abandonware/noble` desde la MISMA Mac:
  ```
  name="buddy"
  serviceUuids=[6e400001b5a3f393e0a9e50e24dcca9e]   ← el UUID exacto del NUS que usa la API
  connectable=true
  rssi=-42   (señal fuerte)
  ```
- El servicio GATT del robot usa los UUIDs estándar del NUS: service `6e400001-...`, RX `6e400002-...`, TX `6e400003-...`.
- Un central propio (Node + noble) **conecta y habla con el robot sin problema**.

## El problema
**El robot NUNCA aparece en la lista "Connect" del panel Hardware Buddy de Claude Desktop.** Tampoco aparece por nombre en Ajustes de Bluetooth de macOS. Un scanner BLE estándar (noble en la misma Mac, un teléfono) SÍ lo ve.

## Todo lo que probé (sin éxito)
- **Advertising:**
  - UUID del NUS en el paquete primario + nombre en el scan-response (igual que la referencia: `addServiceUUID` + `setScanResponse(true)`).
  - Nombre corto ("buddy", <8 chars) + UUID **ambos en el paquete primario** (para que quepan en 31 bytes).
  - Ambas variantes: noble las descubre perfecto; Claude no lista ninguna.
- **Seguridad / pairing:**
  - LE Secure Connections + MITM + Bonding, IOCapability DisplayOnly (igual que la referencia).
  - Just Works: encryption + bonding, sin MITM, NoInputNoOutput.
  - En UN intento con DisplayOnly, macOS mostró SOLO (sin que yo hiciera nada, tras un reinicio del device) un diálogo pidiendo passkey — o sea macOS/Claude intentó emparejar una vez — pero el device nunca mostró el passkey y se reseteó. Después dejó de aparecer.
- **Limpieza de estado:**
  - El device borra todos los bondings en cada boot (`SM.deleteAllBondings`).
  - Toggle de Bluetooth de macOS off/on.
  - Reinicio de Claude Desktop (Cmd-Q + reabrir).
  - No hay nada "buildagotchi"/"buddy" en Ajustes → Bluetooth para "Olvidar".
- **flags:6** (LE General Discoverable, BR/EDR not supported) en el advertising.

## Entorno
- macOS Darwin 25.4 (macOS 26), Apple Silicon.
- Dispositivo: ESP32-S3 (M5Stack CoreS3), firmware Moddable SDK, BLEServer.
- Confirmado por noble (mismo Mac) que el advertising es correcto y connectable.

## Preguntas concretas
1. **¿Sobre QUÉ filtra exactamente el scanner del panel Hardware Buddy** al poblar la lista "Connect"? ¿Service UUID? ¿nombre / prefijo de nombre? ¿manufacturer data? ¿appearance? Un device que anuncia el NUS UUID (6e400001), connectable, señal fuerte, NO aparece.
2. **¿El device necesita anunciar algo ADEMÁS del NUS UUID** para ser listado — p.ej. manufacturer data específico, un appearance value, un nombre con cierto formato?
3. **¿El device necesita completar el bonding (LE Secure Connections) para APARECER en la lista**, o solo para conectar? (Probé MITM+bonding y Just Works.)
4. **¿Hay un archivo de config/caché de Claude Desktop en macOS** que guarde devices Hardware Buddy conocidos/fallidos y que pueda estar bloqueando este device tras un pairing fallido? ¿Dónde está y cómo se limpia? (Reiniciar Claude no bastó.)
5. **¿El scanner del Hardware Buddy hace scan pasivo o activo?** (Determina si lee el scan-response, p.ej. el nombre.)
6. **¿La API BLE para makers está limitada a versiones/canales/cuentas específicas** de Claude Desktop más allá de activar Developer Mode? (v1.24012.1 muestra el panel.)
7. **¿Hay issues conocidos del panel Hardware Buddy no listando un device** que otros centrales BLE (noble / nRF Connect) descubren bien en la misma Mac?
8. ¿Hay logs de Claude Desktop (macOS) donde se vea el resultado del scan BLE / por qué descarta un device? ¿Dónde?
