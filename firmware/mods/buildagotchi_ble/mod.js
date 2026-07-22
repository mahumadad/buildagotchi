/**
 * buildagotchi_ble — Nordic UART peripheral speaking D7 JSON-lines.
 * Uses BLEServer directly (UARTServer subclass was reboot-looping on CoreS3).
 * Host already includes uart bleservices via manifest_service.json.
 */
import BLEServer from 'bleserver'
import Timer from 'timer'

const SAFE_MODE_MS = 15_000
const DEVICE_NAME = 'buildagotchi'

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
  }

  onReady() {
    startAdvertising(this)
    this.armSafeMode()
    trace('[buildagotchi_ble] advertising as buildagotchi\n')
  }

  onConnected() {
    this.stopAdvertising()
    this.armSafeMode()
    trace('[buildagotchi_ble] connected\n')
  }

  onDisconnected() {
    this.tx = null
    this.rxBuffer = ''
    startAdvertising(this)
    this.enterSafeMode('disconnect')
    trace('[buildagotchi_ble] disconnected — advertising\n')
  }

  onCharacteristicNotifyEnabled(characteristic) {
    if (characteristic.name === 'tx') this.tx = characteristic
  }

  onCharacteristicNotifyDisabled(characteristic) {
    if (characteristic.name === 'tx') this.tx = null
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
      // Clear TTS/balloon leftovers that can leave a half-drawn face.
      try {
        robot.setMouthOpen(0)
      } catch (_e) {
        /* ignore */
      }
      try {
        robot.hideBalloon()
      } catch (_e) {
        /* ignore */
      }
      if (typeof state.emotion === 'string' && EMOTIONS[state.emotion]) {
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

  send(t, p) {
    if (this.tx == null) return
    const envelope = {
      v: 1,
      seq: this.outSeq++,
      t,
      ts: Date.now(),
      p: p || {},
    }
    const line = `${JSON.stringify(envelope)}\n`
    try {
      this.notifyValue(this.tx, ArrayBuffer.fromString(line))
    } catch (e) {
      trace(`[buildagotchi_ble] notify error ${e}\n`)
    }
  }
}

export function onRobotCreated(robot) {
  trace('[buildagotchi_ble] start\n')
  try {
    new BuildagotchiServer(robot)
  } catch (e) {
    trace(`[buildagotchi_ble] BLE error ${e}\n`)
  }
}
