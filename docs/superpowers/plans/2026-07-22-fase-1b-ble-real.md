# Fase 1B — BLE real (M6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conectar el bridge Node al CoreS3 real por Nordic UART BLE: `setFace` cambia la cara, heartbeats/acks/safe mode funcionan, sin romper `--simulate`.

**Architecture:** `ProtocolSession` ya habla el protocolo D7 sobre `Transport`. 1B añade `NobleTransport` (central) y un MOD Moddable `buildagotchi_ble` (peripheral UARTServer) que parsea JSON-lines, aplica `ResolvedState`, responde `ack`/`state_applied`/`hb`/`hello`, y emite `event` de touch/botón. Nada de 1A se refactoriza.

**Tech Stack:** `@abandonware/noble`, ProtocolSession existente, Moddable `uartserver`, target `esp32:./platforms/m5stackchan_cores3`.

## Global Constraints

- Node >= 20; TypeScript strict; Vitest; Biome (repo bridge).
- Transport interface unchanged: `connect/disconnect/send/onLine/onStateChange`.
- `--simulate` sigue usando `SimTransport`; BLE real solo sin ese flag.
- Nordic UART UUIDs (REFERENCE.md / Moddable uartserver):
  - Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
  - RX (bridge→fw write) `6e400002-…`
  - TX (fw→bridge notify) `6e400003-…`
- Advertise name: `buildagotchi` (filtro de scan).
- Envelope D7: `{v:1, seq, t, ts, p}` JSON line-delimited `\n`.
- Emulator rule: firmware MOD must do what the robot can do; no browser-only APIs.
- Commits: un commit por tarea; sin `Co-Authored-By` salvo pedido.
- No force-push; no commit de `config.yaml` / secrets.

## File map

| File | Role |
|---|---|
| `NOTES.md` | UUIDs + evidencia 1B |
| `bridge/package.json` | dep `@abandonware/noble` |
| `bridge/src/ble/nus.ts` | UUID constants + name filter |
| `bridge/src/ble/transport-noble.ts` | Transport sobre noble |
| `bridge/test/transport-noble.test.ts` | unit tests con noble mock |
| `bridge/src/index.ts` | elegir Sim vs Noble |
| `bridge/src/config/schema.ts` + example yaml | `ble.deviceNamePrefix` opcional |
| `stack-chan/firmware/mods/buildagotchi_ble/` | MOD peripheral (local, stack-chan gitignored) |
| `firmware/mods/` (nuestro) | opcional: copiar fuentes versionadas si hace falta |

---

### Task 1: UUIDs en NOTES + constantes NUS

**Files:**
- Modify: `NOTES.md` (§ Protocolo BLE)
- Create: `bridge/src/ble/nus.ts`
- Test: `bridge/test/nus.test.ts` (trivial export check) — o skip test y solo typecheck

- [ ] **Step 1:** Rellenar UUIDs en NOTES.md desde REFERENCE.md
- [ ] **Step 2:** Crear `nus.ts` con `NUS_SERVICE`, `NUS_RX`, `NUS_TX`, `DEFAULT_DEVICE_NAME_PREFIX = 'buildagotchi'`
- [ ] **Step 3:** `npm test` / typecheck verde
- [ ] **Step 4:** Commit `Document NUS UUIDs and shared BLE constants`

---

### Task 2: `NobleTransport` + tests con mock

**Files:**
- Create: `bridge/src/ble/transport-noble.ts`
- Create: `bridge/test/transport-noble.test.ts`
- Modify: `bridge/package.json` (add `@abandonware/noble`)

**Behavior:**
- `connect()`: wait noble poweredOn → scan filter by name prefix + NUS service → connect → discover → subscribe TX notify → resolve
- `send(line)`: write to RX char (with `\n` if missing); drop+warn if not connected
- `onLine`: reassemble notify chunks until `\n`
- `disconnect()`: stop scan, disconnect peripheral
- `onStateChange`: disconnected/connecting/connected
- Reconnect is ProtocolSession's job (backoff); transport just exposes connect/disconnect

- [ ] **Step 1:** `npm install @abandonware/noble` (+ `@types` if needed)
- [ ] **Step 2:** Write failing tests with injected noble-like fake
- [ ] **Step 3:** Implement `NobleTransport` with injectable `NobleLike` for tests
- [ ] **Step 4:** Tests green
- [ ] **Step 5:** Commit `Add NobleTransport for real BLE NUS`

---

### Task 3: Wire bridge (simulate vs real)

**Files:**
- Modify: `bridge/src/index.ts`
- Modify: `bridge/src/config/schema.ts`, `config.example.yaml`
- Modify: health `transport.kind`: `'sim' | 'noble' | 'none'`

- [ ] **Step 1:** If `!simulate`, construct `NobleTransport` + `ProtocolSession` (same deps as sim)
- [ ] **Step 2:** Config `ble.deviceNamePrefix` default `buildagotchi`
- [ ] **Step 3:** Tests that don't need hardware still pass (`npm test`)
- [ ] **Step 4:** Commit `Wire NobleTransport when not simulating`

---

### Task 4: Firmware MOD `buildagotchi_ble`

**Files:**
- Create: `stack-chan/firmware/mods/buildagotchi_ble/{mod.js,manifest.json}`
- Also mirror under `firmware/mods/buildagotchi_ble/` in our repo for versioning

**Behavior:**
- Extend `UARTServer`, `deviceName = 'buildagotchi'`
- On RX: buffer until `\n`, JSON.parse envelope
- Handle `hello` → reply hello role=fw + ack clock
- Handle `state` / `state_sync` → apply emotion/decorators/leds/servo/balloon via robot API; send `ack` then `state_applied`
- Handle `hb` → reply `hb`
- Safe mode (D16): if no inbound bridge traffic for 15s → SLEEPY face
- Touch/button → `event` messages (best-effort; button.a may be missing on CoreS3)

- [ ] **Step 1:** Write mod + manifest (include uart ble service json if required by Moddable)
- [ ] **Step 2:** Install via debug host + xsbug + `mcrun -d`
- [ ] **Step 3:** Flash release host; verify advertising `buildagotchi` with bleak
- [ ] **Step 4:** Commit mirrored sources under `firmware/mods/buildagotchi_ble/`

---

### Task 5: E2E hardware verification

- [ ] **Step 1:** `cd bridge && npx tsx src/index.ts` (no `--simulate`), grant Bluetooth TCC if prompted
- [ ] **Step 2:** Log shows link up / hello ok
- [ ] **Step 3:** Trigger permission or `curl` state → face changes on robot
- [ ] **Step 4:** Kill bridge → robot enters SLEEPY within ~15s
- [ ] **Step 5:** Restart bridge → state_sync restores face
- [ ] **Step 6:** Update NOTES.md + DEVLOG.md with evidence
- [ ] **Step 7:** Commit docs

---

## Done when

- Tests 2–4 de SPEC-FASE-1 §1 verificados en hardware (o documentada la gap restante)
- `npm test` + typecheck verdes
- `--simulate` intacto
