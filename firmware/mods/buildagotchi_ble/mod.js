/**
 * buildagotchi_ble — Nordic UART peripheral speaking D7 JSON-lines.
 * Uses BLEServer directly (UARTServer subclass was reboot-looping on CoreS3).
 * Host already includes uart bleservices via manifest_service.json.
 */
import { SimpleFace } from 'behaviors/face'
import BLEServer from 'bleserver'
import { Emoticon } from 'effects/emoticon'
import { Behavior, Container, Content, Skin, Style, Text, Texture } from 'piu/MC'
import Timer from 'timer'

// D-17/stability: why the ESP32 last reset (Power-On, Panic, Task WDT, Brownout…).
// Read lazily via a dynamic-ish require so a missing/unlinked `resetReason`
// module can't crash the whole mod at import time (a static import of it left
// the CoreS3 booting to a blank screen — the module built but wasn't in the
// release host's runtime). Resolved once at boot, echoed in every hello.
let RESET_REASON = 'unavailable'

/**
 * Presets:
 * - 'factory'  — píldora + flecha (guardado)
 * - 'emulator' — Feature A r=14 + triángulo + k8x12
 * - 'hybrid'   — burbuja r=14 + flecha factory + OpenSans-16 + marquee
 */
const BALLOON_STYLE = 'hybrid'

const textureCache = {}
function cachedTexture(name) {
  if (!textureCache[name]) textureCache[name] = new Texture(name)
  return textureCache[name]
}

/** Tinted bitmap (flecha factory o cola emulador). */
const BalloonMark = Content.template(($) => ({
  left: $.left,
  top: $.top,
  width: $.width,
  height: $.height,
  Behavior: class extends Behavior {
    paint(content, primary) {
      content.skin = new Skin({
        texture: cachedTexture($.texture),
        color: [primary || '#ffffff'],
        x: 0,
        y: 0,
        width: $.width,
        height: $.height,
      })
    }
    onDisplaying(content) {
      this.paint(content, '#ffffff')
    }
    onFaceContext(content, face) {
      this.paint(content, face?.theme?.primary)
    }
  },
}))

/** Burbuja 9-slice + texto (factory pill / emulator round / hybrid). */
const ThemeBubble = Container.template(($) => ({
  name: 'ThemeBubble',
  left: $.left,
  top: $.top,
  width: $.width,
  height: $.height,
  clip: true,
  Behavior: class extends Behavior {
    ensure(content, text, primary, secondary) {
      content.empty()
      const bubbleColor = primary || '#ffffff'
      let textColor = secondary || '#000000'
      if (textColor === bubbleColor) textColor = '#000000'
      const slice = $.slice
      content.add(
        new Content(null, {
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          skin: new Skin({
            texture: cachedTexture($.texture),
            color: [bubbleColor],
            x: 0,
            y: 0,
            width: slice.w,
            height: slice.h,
            left: slice.left,
            right: slice.right,
            top: slice.top,
            bottom: slice.bottom,
          }),
        }),
      )
      // Marquee: never set left+right on Text — that box-wraps wide glyph windows
      // onto a 2nd line. Give a huge width + parent clip so it stays one line.
      if ($.marquee) {
        content.add(
          new Text(null, {
            left: $.paddingX,
            top: $.textTop,
            width: 2000,
            height: 22,
            string: text ?? '',
            style: new Style({
              font: $.font,
              color: textColor,
              horizontal: 'left',
            }),
          }),
        )
      } else {
        content.add(
          new Text(null, {
            left: $.paddingX,
            right: $.paddingX,
            top: $.textTop,
            height: 22,
            string: text ?? '',
            style: new Style({
              font: $.font,
              color: textColor,
              horizontal: $.horizontal || 'center',
            }),
          }),
        )
      }
    }
    onDisplaying(content) {
      // Use the single-line window ($.text), never fullText — fullText wraps and looks ugly.
      this.ensure(content, $.text ?? $.fullText, '#ffffff', '#000000')
    }
    onFaceContext(content, face) {
      const bubbleColor = face?.theme?.primary || '#ffffff'
      let textColor = face?.theme?.secondary || '#000000'
      if (textColor === bubbleColor) textColor = '#000000'
      const bg = content.first
      const body = bg?.next
      if (bg && body) {
        // Repaint colors only — do not reset marquee window string.
        const slice = $.slice
        bg.skin = new Skin({
          texture: cachedTexture($.texture),
          color: [bubbleColor],
          x: 0,
          y: 0,
          width: slice.w,
          height: slice.h,
          left: slice.left,
          right: slice.right,
          top: slice.top,
          bottom: slice.bottom,
        })
        body.style = new Style({
          font: $.font,
          color: textColor,
          horizontal: $.horizontal || 'center',
        })
        return
      }
      this.ensure(content, $.text ?? $.fullText, bubbleColor, textColor)
    }
  },
}))

const SAFE_MODE_MS = 15_000
const DEVICE_NAME = 'buildagotchi'
/** Host uart TX/RX characteristic maxBytes (uart.json). */
const NUS_CHUNK = 64
/** Same window as default-mods petting (fwd+bwd swipe ⇒ pet). */
const PET_WINDOW_MS = 800
/**
 * SAFETY: how long to ignore the touch panel after moving the head. A servo
 * move (e.g. the pitch nod on a pending permission) jostles the capacitive
 * Si12T — at high sensitivity that reads as a phantom press/release, which the
 * bridge would take as a head-tap and auto-approve the very permission being
 * shown. Suppressing touch until the head settles closes that servo↔touch loop.
 *
 * 1200ms was too short: measured 2026-07-24, phantom touch_head arrived
 * ~2.6s post-servo (probably head reasenting after the pitch nod). 3500ms
 * covers that with margin. Trade-off: a real tap in the first 3.5s after a
 * head move is ignored — acceptable, since it's exactly the window when the
 * user would naturally wait to see what changed.
 */
const TOUCH_SETTLE_MS = 3_500

/**
 * state.decorators (from the bridge stateRules) → firmware Emoticon key. The
 * emulator renders every decorator; the firmware Emoticon effect only has these
 * five keys. `thinking` and `question_mark` have no firmware emoticon yet, so
 * they're dropped (would need their own effect) — the emulator still shows them.
 */
const DECORATOR_KEY_MAP = {
  heart: 'heart',
  sweat: 'sweat',
  angry_mark: 'angry',
  tear: 'tear',
  sleepy_z: 'sleepy',
}

/**
 * state.sound → a tone sequence, mirroring the emulator's sound-engine.js so the
 * robot stops being mute. Each entry is [hz, durationMs, delayMs]. Played via
 * `robot.tone()` (AudioOut); a no-op if the platform has no speaker configured.
 */
const SOUND_MAP = {
  approve: [[523, 80, 0], [659, 80, 90], [784, 120, 180]],
  deny: [[440, 100, 0], [330, 150, 110]],
  permission: [[880, 60, 0], [1047, 60, 80], [880, 60, 160], [1047, 80, 240]],
  notification: [[784, 80, 0], [1047, 120, 100]],
  error: [[200, 80, 0], [200, 80, 120], [200, 80, 240]],
  modeChange: [[440, 150, 0]],
}

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

/**
 * SAVED preset — factory M5Stack (speech_bubble.cpp), tuned below mouth.
 * Switch with BALLOON_STYLE = 'factory'.
 */
const FACTORY_BALLOON = {
  displayW: 320,
  top: 164,
  height: 52,
  minWidth: 90,
  maxWidth: 300,
  textMx: 20,
  charW: 9,
  minOffsetX: 66,
  maxOffsetX: 0,
  mapMaxWidth: 340,
  font: 'OpenSans-Regular-16',
  arrowW: 28,
  arrowH: 32,
  arrowOffsetX: 40,
  arrowTopInset: 9,
  texture: 'bubble-pill.png',
  slice: { w: 96, h: 64, left: 32, right: 32, top: 32, bottom: 32 },
  textTop: 14,
  markTexture: 'bubble-arrow.png',
}

/**
 * Emulator Feature A — bridge/.../balloon-layout.mjs
 * roundRect r=14 + triangle tail to mouth; k8x12 metrics.
 */
const EMULATOR_BALLOON = {
  displayW: 320,
  charW: 8,
  lineH: 16,
  paddingX: 18,
  paddingY: 10,
  minWidth: 90,
  maxWidth: 300,
  minHeight: 32,
  radius: 14,
  visibleLines: 2,
  maxLines: 12,
  mouthX: 160,
  mouthY: 148,
  tailHalfWidth: 8,
  tailTipOffset: 8,
  tailLength: 28,
  font: 'k8x12-12',
  texture: 'bubble-round.png',
  slice: { w: 48, h: 48, left: 14, right: 14, top: 14, bottom: 14 },
  markTexture: 'bubble-tail.png',
  markW: 16,
  markH: 20,
}

/**
 * Hybrid (preferido): burbuja r=14 del emulador + colita de pez factory
 * (default_bubble_arrow, offset x+40) + OpenSans-16 + marquee circular
 * como LV_LABEL_LONG_MODE_SCROLL_CIRCULAR del factory.
 */
const HYBRID_BALLOON = {
  displayW: 320,
  top: 164,
  height: 52,
  minWidth: 90,
  // Almost full-bleed; factory allows 340 but screen is 320
  maxWidth: 312,
  // Tight padding — text hugs bubble edges.
  textMx: 5,
  charW: 8,
  minOffsetX: 66,
  maxOffsetX: 0,
  mapMaxWidth: 340,
  font: 'OpenSans-Regular-16',
  textTop: 14,
  texture: 'bubble-round.png',
  slice: { w: 48, h: 48, left: 14, right: 14, top: 14, bottom: 14 },
  arrowW: 28,
  arrowH: 32,
  arrowOffsetX: 40,
  arrowTopInset: 9,
  markTexture: 'bubble-arrow.png',
  marqueeGap: '    ',
  // Slower than before (45ms was ~22 chars/s). LVGL circular scroll is leisurely.
  marqueeMs: 130,
  marqueeStartHoldMs: 1200,
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin
  const t = (value - inMin) / (inMax - inMin)
  return outMin + t * (outMax - outMin)
}

function wrapBalloonText(text, maxChars) {
  const words = String(text).split(/\s+/).filter((w) => w.length > 0)
  const lines = []
  let line = ''
  for (let i = 0; i < words.length; i++) {
    let w = words[i]
    while (w.length > maxChars) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(w.slice(0, maxChars))
      w = w.slice(maxChars)
    }
    if (w.length === 0) continue
    const candidate = line ? `${line} ${w}` : w
    if (candidate.length <= maxChars) line = candidate
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function factoryBalloonLayout(text) {
  const f = FACTORY_BALLOON
  const measured = Math.ceil(String(text).length * f.charW) + f.textMx * 2
  const width = Math.min(f.maxWidth, Math.max(f.minWidth, measured))
  const offsetX = Math.round(
    mapRange(width, f.minWidth, f.mapMaxWidth, f.minOffsetX, f.maxOffsetX),
  )
  let left = Math.round((f.displayW - width) / 2 + offsetX)
  if (left < 0) left = 0
  if (left + width > f.displayW) left = f.displayW - width
  const full = String(text)
  return {
    left,
    top: f.top,
    width,
    height: f.height,
    text: full,
    fullText: full,
    paddingX: f.textMx,
    textTop: f.textTop,
    font: f.font,
    texture: f.texture,
    slice: f.slice,
    horizontal: 'center',
    marquee: false,
    mark: {
      left: Math.round(f.displayW / 2 + f.arrowOffsetX - f.arrowW / 2),
      top: f.top - f.arrowTopInset,
      width: f.arrowW,
      height: f.arrowH,
      texture: f.markTexture,
    },
  }
}

function emulatorBalloonLayout(text) {
  const c = EMULATOR_BALLOON
  const maxChars = Math.floor((c.maxWidth - c.paddingX * 2) / c.charW)
  let lines = wrapBalloonText(text, maxChars)
  if (lines.length > c.maxLines) {
    lines = lines.slice(0, c.maxLines)
    const last = lines[c.maxLines - 1]
    lines[c.maxLines - 1] = `${last.slice(0, maxChars - 1)}…`
  }
  const visibleLines = Math.min(lines.length, c.visibleLines)
  const longest = Math.max.apply(
    null,
    lines.map((l) => l.length),
  )
  const w = Math.min(c.maxWidth, Math.max(c.minWidth, longest * c.charW + c.paddingX * 2))
  const h = Math.max(c.minHeight, visibleLines * c.lineH + c.paddingY * 2)
  const x = Math.round((c.displayW - w) / 2)
  const y = c.mouthY + c.tailLength
  const minCx = x + c.radius + c.tailHalfWidth
  const maxCx = x + w - c.radius - c.tailHalfWidth
  let baseCx = c.mouthX
  if (baseCx < minCx) baseCx = minCx
  if (baseCx > maxCx) baseCx = maxCx
  const tipY = c.mouthY + c.tailTipOffset
  const shown = lines.slice(0, visibleLines).join('\n')
  return {
    left: x,
    top: y,
    width: w,
    height: h,
    text: shown,
    fullText: shown,
    paddingX: c.paddingX,
    textTop: c.paddingY,
    font: c.font,
    texture: c.texture,
    slice: c.slice,
    horizontal: 'center',
    marquee: false,
    mark: {
      left: Math.round(baseCx - c.markW / 2),
      top: tipY,
      width: c.markW,
      height: c.markH,
      texture: c.markTexture,
    },
  }
}

/** Max chars of `sample` that fit in `availPx` with the given Style. */
function fitCharsToWidth(style, sample, availPx) {
  if (!sample || availPx <= 0) return 1
  let lo = 1
  let hi = sample.length
  let best = 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const w = style.measure(sample.slice(0, mid)).width ?? mid * 8
    if (w <= availPx) {
      best = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

function hybridBalloonLayout(text) {
  const h = HYBRID_BALLOON
  const fullText = String(text).replace(/\s+/g, ' ').trim()
  const style = new Style({ font: h.font, color: '#000' })
  const textPx = style.measure(fullText).width ?? fullText.length * h.charW
  // Long copy: use max width so the marquee window is as wide as the bubble.
  const needsMarquee = textPx + h.textMx * 2 > h.maxWidth
  const width = needsMarquee
    ? h.maxWidth
    : Math.min(h.maxWidth, Math.max(h.minWidth, Math.ceil(textPx) + h.textMx * 2))
  const offsetX = Math.round(
    mapRange(width, h.minWidth, h.mapMaxWidth, h.minOffsetX, h.maxOffsetX),
  )
  let left = Math.round((h.displayW - width) / 2 + offsetX)
  if (left < 0) left = 0
  if (left + width > h.displayW) left = h.displayW - width
  const avail = width - h.textMx * 2
  // Fill the text band edge-to-edge: size window by real glyph metrics.
  const probe = fullText.length >= 40 ? fullText : `${fullText}${'n'.repeat(40)}`
  const maxChars = Math.max(1, fitCharsToWidth(style, probe, avail))
  // Always one line: if it doesn't fit the band, marquee — never wrap.
  const oneLine = !needsMarquee && fullText.length <= maxChars
  const marquee = !oneLine
  const windowText = marquee ? fullText.slice(0, maxChars) : fullText
  return {
    left,
    top: h.top,
    width,
    height: h.height,
    text: windowText,
    fullText,
    paddingX: h.textMx,
    textTop: h.textTop,
    font: h.font,
    texture: h.texture,
    slice: h.slice,
    horizontal: marquee ? 'left' : 'center',
    marquee,
    marqueeMaxChars: maxChars,
    mark: {
      // Factory flecha: tip hacia boca, offset x+40 desde centro pantalla
      left: Math.round(h.displayW / 2 + h.arrowOffsetX - h.arrowW / 2),
      top: h.top - h.arrowTopInset,
      width: h.arrowW,
      height: h.arrowH,
      texture: h.markTexture,
    },
  }
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
    this.balloonBubble = null
    this.balloonArrow = null
    this.balloonMarqueeTimer = null
    this.faceDirty = true
    // D-03: handle for the breathing (pulse) LED timer, cleared on any other LED command.
    this.pulseTimer = null
    // SAFETY: while true, touch is ignored — the head just moved (servo) and the
    // panel readings are phantom. Set on every setPose, cleared after it settles.
    this.touchSuppressed = false
    this.touchSuppressTimer = null
    // Current expression decorator (Emoticon), added/removed as state.decorators change.
    this.decoratorEffect = null
    this.decoratorKey = null
    // Last sound played, so a re-emitted state doesn't replay the tone.
    this.lastSound = null
    // state.gaze ('left'|'right'|'center'|null) → pixel bias overlaid on top of
    // the saccade modifier (see installGazeModifier). Read on every render tick.
    this.gazeBias = 0
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
        this.balloonBubble = null
        this.balloonArrow = null
        this.stopBalloonMarquee()
        this.installGazeModifier() // fresh SimpleFace has fresh filters; re-add
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
          resetReason: RESET_REASON,
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
          // The remount drops all decorators, so the handle is stale; force re-add.
          this.decoratorEffect = null
          this.decoratorKey = null
        }
        robot.setEmotion(EMOTIONS[state.emotion])
        trace(`[buildagotchi_ble] emotion ${state.emotion}\n`)
      }
    } catch (e) {
      trace(`[buildagotchi_ble] setEmotion error ${e}\n`)
    }

    try {
      this.applyDecorators(robot, state.decorators)
    } catch (e) {
      trace(`[buildagotchi_ble] applyDecorators error ${e}\n`)
    }

    try {
      const snd = typeof state.sound === 'string' ? state.sound : null
      if (snd && snd !== this.lastSound) this.playSound(robot, snd)
      this.lastSound = snd
    } catch (e) {
      trace(`[buildagotchi_ble] playSound error ${e}\n`)
    }

    try {
      // gaze bias in gazeX units (multiplied by 2 inside createEyePart). Radius=8,
      // so ±5 shifts the pupil 10px — obvious ("stares to the side") without
      // losing the pupil off the eye. Tuned up from 3 after first hardware test.
      const g = state.gaze
      this.gazeBias = g === 'left' ? -6 : g === 'right' ? 6 : 0
      if (g) trace(`[buildagotchi_ble] gaze bias=${this.gazeBias} (${g})\n`)
    } catch (_e) { /* ignore */ }

    try {
      if (state.servo && typeof state.servo === 'object') {
        const yawDeg = Number(state.servo.yaw) || 0
        const pitchDeg = Number(state.servo.pitch) || 0
        const y = (yawDeg * Math.PI) / 180
        const p = (pitchDeg * Math.PI) / 180
        void robot.setTorque(true)
        void robot.setPose({ rotation: { y, p, r: 0 } }, 0.3)
        this.suppressTouch()
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

  stopBalloonMarquee() {
    if (this.balloonMarqueeTimer != null) {
      try {
        Timer.clear(this.balloonMarqueeTimer)
      } catch (_e) {
        /* ignore */
      }
      this.balloonMarqueeTimer = null
    }
  }

  startBalloonMarquee(layout) {
    this.stopBalloonMarquee()
    if (!layout.marquee) return
    const unit = `${layout.fullText}${HYBRID_BALLOON.marqueeGap}`
    const cycle = unit.length
    const maxChars = layout.marqueeMaxChars
    const holdMs = HYBRID_BALLOON.marqueeStartHoldMs
    const tickMs = HYBRID_BALLOON.marqueeMs
    let offset = 0
    let elapsed = 0
    // Seed first window at left edge (offset 0) before scrolling.
    const body0 = this.balloonBubble?.first?.next
    if (body0) body0.string = unit.slice(0, maxChars)
    this.balloonMarqueeTimer = Timer.repeat(() => {
      const body = this.balloonBubble?.first?.next
      if (!body) return
      elapsed += tickMs
      if (elapsed < holdMs) return
      offset = (offset + 1) % cycle
      const doubled = unit + unit
      body.string = doubled.slice(offset, offset + maxChars)
    }, tickMs)
  }

  clearBalloonDecorators(robot) {
    this.stopBalloonMarquee()
    try {
      robot.hideBalloon()
    } catch (_e) {
      /* ignore */
    }
    if (this.balloonBubble) {
      try {
        robot.renderer?.removeDecorator(this.balloonBubble)
      } catch (_e) {
        /* ignore */
      }
      this.balloonBubble = null
    }
    if (this.balloonArrow) {
      try {
        robot.renderer?.removeDecorator(this.balloonArrow)
      } catch (_e) {
        /* ignore */
      }
      this.balloonArrow = null
    }
  }

  applyBalloon(robot, balloon) {
    const text = typeof balloon === 'string' ? balloon : ''
    if (text === this.lastBalloon) return
    this.lastBalloon = text
    this.clearBalloonDecorators(robot)
    if (text.length === 0) {
      trace('[buildagotchi_ble] balloon hide\n')
      return
    }
    const style = BALLOON_STYLE
    let layout
    if (style === 'hybrid') layout = hybridBalloonLayout(text)
    else if (style === 'emulator') layout = emulatorBalloonLayout(text)
    else layout = factoryBalloonLayout(text)
    try {
      this.balloonBubble = new ThemeBubble({
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        text: layout.text,
        fullText: layout.fullText ?? layout.text,
        paddingX: layout.paddingX,
        textTop: layout.textTop,
        font: layout.font,
        texture: layout.texture,
        slice: layout.slice,
        horizontal: layout.horizontal || 'center',
        marquee: !!layout.marquee,
      })
      robot.renderer?.addDecorator(this.balloonBubble)
      this.balloonArrow = new BalloonMark({
        left: layout.mark.left,
        top: layout.mark.top,
        width: layout.mark.width,
        height: layout.mark.height,
        texture: layout.mark.texture,
      })
      robot.renderer?.addDecorator(this.balloonArrow)
      this.startBalloonMarquee(layout)
    } catch (e) {
      trace(`[buildagotchi_ble] balloon error ${e}\n`)
      this.clearBalloonDecorators(robot)
    }
    trace(
      `[buildagotchi_ble] balloon ${style} ${text.length}c w=${layout.width} h=${layout.height} marquee=${!!layout.marquee}\n`,
    )
  }

  // D-03: breathing ("pulse") on the head LED. It's a PY32Led (12 RGB), driven by
  // on()/#fill+refreshLeds() — NOT NeoStrand, so led-pulse.ts's setScheme path
  // does not apply. We vary brightness with a raised cosine (breath.ts curve) at
  // 100ms via a Timer; #stopPulse must run before any other LED command so the
  // breathing doesn't fight blink/rainbow/solid. Verified on hardware 2026-07-23.
  startPulse(robot, color) {
    this.stopPulse()
    const led = robot.led && robot.led.head
    if (!led) {
      robot.lightOn('head', color[0], color[1], color[2]) // fallback: solid
      return
    }
    const dur = 2000
    let t = 0
    this.pulseTimer = Timer.repeat(() => {
      const phase = (2 * Math.PI * (t % dur)) / dur
      const k = (1 - Math.cos(phase)) / 2
      led.on(Math.round(color[0] * k), Math.round(color[1] * k), Math.round(color[2] * k))
      t += 100
    }, 100)
  }

  stopPulse() {
    if (this.pulseTimer != null) {
      Timer.clear(this.pulseTimer)
      this.pulseTimer = null
    }
  }

  // Wire state.decorators to the firmware Emoticon effect (heart/sweat/angry/…).
  // The buildagotchi mod calls setEmotion directly, bypassing the host's own
  // emotion→emoticon effect, so without this the robot shows no decorators even
  // though the emulator does. One emoticon at a time (mirrors the host default-mod).
  applyDecorators(robot, decorators) {
    const list = Array.isArray(decorators) ? decorators : []
    let key = null
    for (const d of list) {
      if (DECORATOR_KEY_MAP[d]) {
        key = DECORATOR_KEY_MAP[d]
        break
      }
    }
    if (key === this.decoratorKey) return // unchanged
    if (this.decoratorEffect != null) {
      robot.renderer?.removeDecorator(this.decoratorEffect)
      this.decoratorEffect = null
    }
    this.decoratorKey = key
    if (key != null) {
      try {
        this.decoratorEffect = new Emoticon({ key, name: 'decorator' })
        robot.renderer?.addDecorator(this.decoratorEffect)
        trace(`[buildagotchi_ble] decorator ${key}\n`)
      } catch (e) {
        trace(`[buildagotchi_ble] decorator error ${e}\n`)
        this.decoratorEffect = null
        this.decoratorKey = null
      }
    }
  }

  // Wire state.gaze to a bias overlaid on the SimpleFace eyes AFTER the saccade
  // modifier runs, so the pupils drift toward left/right/center instead of only
  // doing the idle random saccade. The face model already has gazeX/gazeY on
  // each eye (eye radius 8, offset ×2 → gazeX ±3 gives a visible pupil shift).
  // Runs on the renderer.filters array (public, mutable) — no upstream fork.
  installGazeModifier() {
    try {
      const renderer = this.robot.renderer
      const filters = renderer?.filters
      if (!Array.isArray(filters)) return
      // Idempotent: don't stack copies if remountFace re-runs before we clear.
      const marker = '__buildagotchi_gaze__'
      for (let i = filters.length - 1; i >= 0; i--) {
        if (filters[i] && filters[i][marker]) filters.splice(i, 1)
      }
      const self = this
      const modifier = (_tick, face) => {
        const bias = self.gazeBias
        if (bias !== 0) {
          if (face.eyes.left) face.eyes.left.gazeX = bias
          if (face.eyes.right) face.eyes.right.gazeX = bias
        }
        return face
      }
      modifier[marker] = true
      filters.push(modifier) // runs AFTER saccade → overrides it when bias≠0
      trace(`[buildagotchi_ble] gaze modifier installed (filters=${filters.length})\n`)
    } catch (e) {
      trace(`[buildagotchi_ble] installGazeModifier error ${e}\n`)
    }
  }

  // Play a state.sound tone sequence via robot.tone() (no-op without a speaker).
  playSound(robot, name) {
    const seq = SOUND_MAP[name]
    if (!seq) return
    for (const step of seq) {
      const hz = step[0]
      const dur = step[1]
      const delay = step[2]
      const beep = () => {
        try {
          void robot.tone(hz, dur)
        } catch (_e) {
          /* no speaker / busy */
        }
      }
      if (delay > 0) Timer.set(beep, delay)
      else beep()
    }
  }

  // SAFETY: ignore the touch panel until the head settles after a servo move.
  suppressTouch() {
    this.touchSuppressed = true
    if (this.touchSuppressTimer != null) Timer.clear(this.touchSuppressTimer)
    this.touchSuppressTimer = Timer.set(() => {
      this.touchSuppressed = false
      this.touchSuppressTimer = null
    }, TOUCH_SETTLE_MS)
  }

  applyLeds(robot, leds) {
    // Any new LED command supersedes a running breath (D-03).
    this.stopPulse()
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
      } else if (pattern === 'pulse') {
        this.startPulse(robot, color)
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
      // Stability (bug #2): 15s with no inbound (the bridge sends a heartbeat
      // every 5s) means the central dropped the link ungracefully — the device
      // never got onDisconnected, so it holds a ghost connection and never
      // re-advertises. The bridge then scans and finds NO device for minutes
      // (verified: "No BLE device matching prefix buildagotchi"). If we still
      // think we're connected (tx set), force our own disconnect: onDisconnected
      // re-advertises and the bridge reconnects in seconds, not minutes.
      if (this.tx != null) {
        try {
          this.disconnect()
          trace('[buildagotchi_ble] heartbeat lost — forced disconnect to re-advertise\n')
        } catch (e) {
          trace(`[buildagotchi_ble] force disconnect error ${e}\n`)
        }
      }
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
    // Circuit breaker: a phantom-touch storm at the sensitivity threshold can
    // emit events fast enough to exhaust the XS fixed heap (observed: a touch
    // flood → "Chunk allocation failed" → rst:0xc software reset). Cap the
    // sustained emit rate — 20 events / 5s. A real user tapping never
    // approaches this, so normal use (incl. the double-tap) is unaffected.
    const now = Date.now()
    if (now - (this.touchWindowStart || 0) > 5000) {
      this.touchWindowStart = now
      this.touchWindowCount = 0
    }
    this.touchWindowCount = (this.touchWindowCount || 0) + 1
    if (this.touchWindowCount > 20) {
      if (this.touchWindowCount === 21) trace('[buildagotchi_ble] touch storm — dropping events\n')
      return
    }
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
    // Si12T sensitivity. Level 3 (the driver default) read a flat [0,0,0] on
    // this kit — nothing registered. Level 0 (max) went too far the other way:
    // measured 2026-07-24, it free-runs at [3,3,3] (all three zones saturated)
    // for tens of seconds with nobody near the robot, ~15 phantom readings per
    // minute, which the panel turns into ~1 phantom tap/min. At that setting a
    // real finger and idle drift produce the identical value, so no amount of
    // bridge-side filtering can tell them apart. Level 1 is the next step down
    // in sensitivity — re-measure with GET /debug/touch-samples after changing.
    panel.configure({ sensitivityType: 1, sensitivityLevel: 1 })
    trace('[buildagotchi_ble] touch sensitivity high/1\n')
  } catch (e) {
    trace(`[buildagotchi_ble] touch configure error ${e}\n`)
  }
  // --- Own touch detection (D-17 debounce) --------------------------------
  // The firmware TouchPanel runs its own GestureRecognizer and hands us
  // press/release/swipe via onGesture. On this Si12T that recognizer chatters:
  // a single deliberate finger press produced a forwardSwipe plus stray
  // release/press pairs (measured 2026-07-24). A stray press with no matching
  // release then sat "pressed" until the 2s hold fired and put the robot to
  // SLEEP mid-demo; the moving centroid turned taps into phantom swipes.
  //
  // So we ignore onGesture entirely and derive press/release ourselves from the
  // raw onSample stream, with two guards: `touched` requires a zone at or above
  // TOUCH_ON, and releasing requires TOUCH_OFF_SAMPLES consecutive empty reads
  // (~150ms) so a momentary [0,0,0] glitch in the middle of a hold doesn't emit
  // a false release. No direction / centroid is considered, so a touch never
  // becomes a swipe. `emitTouch('press'|'release')` feeds the bridge's own
  // tap/hold recogniser exactly as before.
  const TOUCH_ON = 2 // any zone >= this is contact; 2 (not 1) rejects the near-
  // threshold noise flapping that flooded touch events and exhausted the heap
  const TOUCH_OFF_SAMPLES = 3 // consecutive empty reads before we trust a release
  let touched = false
  let emptyRun = 0
  panel.onSample = (sample, ticks) => {
    if (server.touchSuppressed) return // SAFETY: head moving → phantom readings
    const peak = Math.max(sample[0] || 0, sample[1] || 0, sample[2] || 0)
    const contact = peak >= TOUCH_ON

    if (contact) {
      emptyRun = 0
      if (!touched) {
        touched = true
        trace('[buildagotchi_ble] touch press\n')
        server.emitTouch('press')
      }
    } else if (touched) {
      emptyRun++
      if (emptyRun >= TOUCH_OFF_SAMPLES) {
        touched = false
        emptyRun = 0
        trace('[buildagotchi_ble] touch release\n')
        server.emitTouch('release')
      }
    }
  }
  // onGesture left unset: the firmware recognizer's swipe/press/release are the
  // chatter source; we do not consume them. `lastFwd`/`lastBwd` (pet detection)
  // are unused for now — head_pet can be revisited once a clean swipe exists.
  void lastFwd
  void lastBwd
  trace('[buildagotchi_ble] touchPanel hooked (own debounce)\n')
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
    server.installGazeModifier() // hook into the initial face's filters
    setupTouch(server, robot)
    setupButtons(server, robot)
    // Rest pose: the host boots the neck at its pitch home (angle 0), which
    // leaves the head drooping down — it hides the face and blocks the reset
    // button. Lift it at startup. The pitch axis runs 0..90° in one direction
    // and maps as servoAngle = -p, so a negative p tilts the head up;
    // ~-0.45 rad ≈ 26° (level-ish, tuned by eye).
    try {
      robot.setTorque(true)
      robot.setPose({ rotation: { y: 0, p: -0.45, r: 0 } }, 0.4)
    } catch (e) {
      trace(`[buildagotchi_ble] rest pose error ${e}\n`)
    }
    // Stability: these servos never answer a position READ, so robot.updatePose()
    // burns two 40ms serial timeouts on every render tick — a permanent storm of
    // "timeout." from scservo.ts, hammering the UART the whole time the robot is
    // up. The reads never succeed anyway (the pose just keeps its last value), so
    // failing fast is behaviourally identical and frees the bus and the tick.
    try {
      const driver = robot.driver
      if (driver && typeof driver.getRotation === 'function') {
        // Plain assignment throws "not writable": the method lives on the
        // driver's prototype and XS makes it read-only, and an assignment
        // consults the inherited descriptor. defineProperty installs an own
        // property on the instance without consulting it.
        Object.defineProperty(driver, 'getRotation', {
          value: () => Promise.resolve({ success: false }),
          writable: true,
          configurable: true,
        })
        trace('[buildagotchi_ble] servo position polling disabled\n')
      }
    } catch (e) {
      trace(`[buildagotchi_ble] driver patch error ${e}\n`)
    }
    // Stability: the host joins Wi-Fi at boot and, on any drop, keeps
    // reconnecting in the background forever (network-service.ts:62). The buddy
    // talks over BLE only, and Wi-Fi + BLE share the ESP32-S3's single 2.4GHz
    // radio, so that idle Wi-Fi activity contends with the link. Shut it down.
    // globalEnv IS globalThis (main.ts), so the live NetworkService is reachable
    // as globalThis.network with no new import (a top-level import that the host
    // can't resolve is the false-brick failure mode — avoid it).
    try {
      const net = globalThis.network
      if (net && typeof net.close === 'function') {
        net.close()
        trace('[buildagotchi_ble] wifi shut down\n')
      } else {
        trace('[buildagotchi_ble] no globalThis.network to close\n')
      }
    } catch (e) {
      trace(`[buildagotchi_ble] wifi shutdown error ${e}\n`)
    }
  } catch (e) {
    trace(`[buildagotchi_ble] BLE error ${e}\n`)
  }
}
