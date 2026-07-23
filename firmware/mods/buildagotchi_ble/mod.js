/**
 * buildagotchi_ble — Nordic UART peripheral speaking D7 JSON-lines.
 * Uses BLEServer directly (UARTServer subclass was reboot-looping on CoreS3).
 * Host already includes uart bleservices via manifest_service.json.
 */
import { SimpleFace } from 'behaviors/face'
import BLEServer from 'bleserver'
import Timer from 'timer'

const SAFE_MODE_MS = 15_000
const DEVICE_NAME = 'buildagotchi'
/** Host uart TX/RX characteristic maxBytes (uart.json). */
const NUS_CHUNK = 64
/** Same window as default-mods petting (fwd+bwd swipe ⇒ pet). */
const PET_WINDOW_MS = 800

const EMOTIONS = {
  NEUTRAL: 'NEUTRAL',
  HAPPY: 'HAPPY',
  SAD: 'SAD',
  ANGRY: 'ANGRY',
  SLEEPY: 'SLEEPY',
  DOUBTFUL: 'DOUBTFUL',
  COLD: 'COLD',
  HOT: 'HOT',
}

const LED_RGB = {
  red: [24, 0, 0],
  amber: [24, 12, 0],
  green: [0, 24, 0],
  blue: [0, 0, 24],
  white: [20, 20, 20],
  off: [0, 0, 0],
}

function startAdvertising(server) {
  // Same pattern as fase0_r2 — completeName only (fits ADV; NUS UUID via GATT after connect).
  server.startAdvertising({
    advertisingData: {
      flags: 6,
      completeName: DEVICE_NAME,
    },
  })
}

class BuildagotchiServer extends BLEServer {
  constructor(robot) {
    super()
    this.robot = robot
    this.tx = null
    this.rxBuffer = ''
    this.outSeq = 1
    this.safeTimer = null
    this.lastBalloon = null
    this.faceDirty = true
    /** Outbound event lines queued until CCCD notify is enabled. */
    this.pendingOut = []
  }

  onReady() {
    startAdvertising(this)
    this.armSafeMode()
    trace('[buildagotchi_ble] advertising as buildagotchi\n')
  }

  onConnected() {
    this.stopAdvertising()
    this.armSafeMode()
    // Servo timeout storms can leave one eyelid Contour stale; remount face.
    this.remountFace()
    trace('[buildagotchi_ble] connected\n')
  }

  remountFace() {
    try {
      const renderer = this.robot.renderer
      if (renderer && typeof renderer.setFace === 'function') {
        renderer.setFace(new SimpleFace({}))
        this.faceDirty = false
        this.lastBalloon = null
        trace('[buildagotchi_ble] face remounted\n')
      }
    } catch (e) {
      trace(`[buildagotchi_ble] face remount error ${e}\n`)
    }
  }

  onDisconnected() {
    this.tx = null
    this.rxBuffer = ''
    startAdvertising(this)
    this.enterSafeMode('disconnect')
    trace('[buildagotchi_ble] disconnected — advertising\n')
  }

  onCharacteristicNotifyEnabled(characteristic) {
    if (characteristic.name === 'tx') {
      this.tx = characteristic
      this.flushPendingOut()
    }
  }

  onCharacteristicNotifyDisabled(characteristic) {
    if (characteristic.name === 'tx') this.tx = null
  }

  flushPendingOut() {
    if (this.tx == null || this.pendingOut.length === 0) return
    const queued = this.pendingOut
    this.pendingOut = []
    for (let i = 0; i < queued.length; i++) {
      this.writeChunks(queued[i])
    }
    trace(`[buildagotchi_ble] flushed ${queued.length} queued notifies\n`)
  }

  onCharacteristicWritten(characteristic, value) {
    if (characteristic.name === 'rx') this.onRX(value)
  }

  onRX(data) {
    this.rxBuffer += String.fromArrayBuffer(data)
    let idx = this.rxBuffer.indexOf('\n')
    while (idx !== -1) {
      const line = this.rxBuffer.slice(0, idx).replace(/\r$/, '')
      this.rxBuffer = this.rxBuffer.slice(idx + 1)
      if (line.length > 0) this.handleLine(line)
      idx = this.rxBuffer.indexOf('\n')
    }
  }

  handleLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch (_e) {
      trace(`[buildagotchi_ble] bad json: ${line}\n`)
      return
    }
    if (msg == null || typeof msg !== 'object' || typeof msg.t !== 'string') return
    this.armSafeMode()

    switch (msg.t) {
      case 'hello':
        this.send('hello', {
          role: 'fw',
          fw_version: 'buildagotchi_ble-0.1',
          ts: Date.now(),
        })
        break
      case 'hb':
        this.send('hb', {})
        break
      case 'state':
      case 'state_sync':
        this.applyState(msg.p)
        this.send('ack', { ack_seq: msg.seq })
        this.send('state_applied', {
          ack_seq: msg.seq,
          bridge_ts: msg.ts,
          fw_applied_ts: Date.now(),
        })
        break
      default:
        break
    }
  }

  applyState(state) {
    if (state == null || typeof state !== 'object') return
    const robot = this.robot
    try {
      try {
        robot.setMouthOpen(0)
      } catch (_e) {
        /* ignore */
      }
      if (typeof state.emotion === 'string' && EMOTIONS[state.emotion]) {
        if (this.faceDirty && state.emotion !== 'SLEEPY') {
          this.remountFace()
        }
        robot.setEmotion(EMOTIONS[state.emotion])
        trace(`[buildagotchi_ble] emotion ${state.emotion}\n`)
      }
    } catch (e) {
      trace(`[buildagotchi_ble] setEmotion error ${e}\n`)
    }

    try {
      if (state.servo && typeof state.servo === 'object') {
        const yawDeg = Number(state.servo.yaw) || 0
        const pitchDeg = Number(state.servo.pitch) || 0
        const y = (yawDeg * Math.PI) / 180
        const p = (pitchDeg * Math.PI) / 180
        void robot.setTorque(true)
        void robot.setPose({ rotation: { y, p, r: 0 } }, 0.3)
      }
    } catch (e) {
      trace(`[buildagotchi_ble] servo error ${e}\n`)
    }

    try {
      if (Array.isArray(state.leds)) {
        this.applyLeds(robot, state.leds)
      }
    } catch (e) {
      trace(`[buildagotchi_ble] leds error ${e}\n`)
    }

    try {
      // `balloon` omitted → leave as-is; string (incl. "") → show/hide.
      if ('balloon' in state) {
        this.applyBalloon(robot, state.balloon)
      }
    } catch (e) {
      trace(`[buildagotchi_ble] balloon error ${e}\n`)
    }
  }

  applyBalloon(robot, balloon) {
    const text = typeof balloon === 'string' ? balloon : ''
    if (text === this.lastBalloon) return
    this.lastBalloon = text
    if (text.length === 0) {
      robot.hideBalloon()
      trace('[buildagotchi_ble] balloon hide\n')
      return
    }
    // Match emulator margins (balloon-layout / speech-balloon defaults).
    // Omit width so the 9-slice sizes to the wrapped text.
    robot.showBalloon(text, { left: 16, right: 16, top: 6 })
    trace(`[buildagotchi_ble] balloon ${text.length}c\n`)
  }

  applyLeds(robot, leds) {
    if (leds.length === 0) {
      robot.lightOff('head')
      return
    }
    for (const led of leds) {
      const color = LED_RGB[led.color] || LED_RGB.amber
      const pattern = led.pattern || 'solid'
      if (pattern === 'off') {
        robot.lightOff('head')
      } else if (pattern === 'blink') {
        robot.lightBlink('head', color[0], color[1], color[2], 250)
      } else if (pattern === 'rainbow') {
        robot.lightRainbow('head')
      } else {
        robot.lightOn('head', color[0], color[1], color[2])
      }
    }
  }

  enterSafeMode(reason) {
    trace(`[buildagotchi_ble] safe mode (${reason})\n`)
    try {
      this.robot.setEmotion(EMOTIONS.SLEEPY)
      this.robot.lightOff('head')
      this.applyBalloon(this.robot, '')
      this.faceDirty = true
    } catch (_e) {
      /* ignore */
    }
  }

  armSafeMode() {
    if (this.safeTimer != null) Timer.clear(this.safeTimer)
    this.safeTimer = Timer.set(() => {
      this.safeTimer = null
      this.enterSafeMode('heartbeat')
    }, SAFE_MODE_MS)
  }

  writeChunks(line) {
    if (this.tx == null) return
    try {
      for (let i = 0; i < line.length; i += NUS_CHUNK) {
        this.notifyValue(this.tx, ArrayBuffer.fromString(line.slice(i, i + NUS_CHUNK)))
      }
    } catch (e) {
      trace(`[buildagotchi_ble] notify error ${e}\n`)
    }
  }

  send(t, p) {
    const envelope = {
      v: 1,
      seq: this.outSeq++,
      t,
      ts: Date.now(),
      p: p || {},
    }
    // ASCII JSON — char length == byte length; chunk for NUS maxBytes.
    const line = `${JSON.stringify(envelope)}\n`
    if (this.tx == null) {
      // Keep a short queue so early press/release aren't lost before CCCD.
      if (this.pendingOut.length < 16) this.pendingOut.push(line)
      return
    }
    this.writeChunks(line)
  }

  emitTouch(gesture) {
    this.send('event', { kind: 'touch', detail: { gesture } })
  }

  emitButton(button, action) {
    this.send('event', { kind: 'button', detail: { button, action } })
  }
}

function setupTouch(server, robot) {
  const panel = robot.touchPanel
  if (panel == null) {
    trace('[buildagotchi_ble] no touchPanel\n')
    return
  }
  let lastFwd = null
  let lastBwd = null
  try {
    // More sensitive than defaults — kit was stuck at [0,0,0] with level 3.
    panel.configure({ sensitivityType: 1, sensitivityLevel: 0 })
    trace('[buildagotchi_ble] touch sensitivity high/0\n')
  } catch (e) {
    trace(`[buildagotchi_ble] touch configure error ${e}\n`)
  }
  let sawNonZero = false
  panel.onSample = (sample, _ticks) => {
    if (sawNonZero) return
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] > 0) {
        sawNonZero = true
        trace(`[buildagotchi_ble] touch FIRST non-zero ${JSON.stringify(sample)}\n`)
        return
      }
    }
  }
  panel.onGesture = (gesture) => {
    const type = gesture.type
    if (typeof type !== 'string') return
    trace(`[buildagotchi_ble] gesture ${type}\n`)
    server.emitTouch(type)
    if (type === 'forwardSwipe') lastFwd = gesture.ticks
    else if (type === 'backwardSwipe') lastBwd = gesture.ticks
    if (
      lastFwd != null &&
      lastBwd != null &&
      Math.abs(lastFwd - lastBwd) <= PET_WINDOW_MS
    ) {
      trace('[buildagotchi_ble] gesture pet\n')
      server.emitTouch('pet')
      lastFwd = null
      lastBwd = null
    }
  }
  trace('[buildagotchi_ble] touchPanel hooked\n')
}

function setupButtons(server, robot) {
  const buttons = robot.button
  if (buttons == null) {
    trace('[buildagotchi_ble] no robot.button\n')
    return
  }
  const map = [
    ['a', 'A'],
    ['b', 'B'],
    ['c', 'C'],
  ]
  for (let i = 0; i < map.length; i++) {
    const key = map[i][0]
    const label = map[i][1]
    const btn = buttons[key]
    if (btn == null) {
      trace(`[buildagotchi_ble] no button.${key}\n`)
      continue
    }
    btn.onChanged = function () {
      if (!this.read()) return
      trace(`[buildagotchi_ble] button ${label}\n`)
      server.emitButton(label, 'press')
    }
    trace(`[buildagotchi_ble] button.${key} hooked\n`)
  }
}

export function onRobotCreated(robot) {
  trace('[buildagotchi_ble] start\n')
  try {
    const server = new BuildagotchiServer(robot)
    setupTouch(server, robot)
    setupButtons(server, robot)
  } catch (e) {
    trace(`[buildagotchi_ble] BLE error ${e}\n`)
  }
}
