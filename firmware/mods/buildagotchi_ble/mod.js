/**
 * buildagotchi_ble — Nordic UART peripheral speaking D7 JSON-lines.
 * Uses BLEServer directly (UARTServer subclass was reboot-looping on CoreS3).
 * Host already includes uart bleservices via manifest_service.json.
 */
import { SimpleFace } from 'behaviors/face'
import BLEServer from 'bleserver'
import { Behavior, Container, Content, Skin, Style, Text, Texture } from 'piu/MC'
import Timer from 'timer'

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
