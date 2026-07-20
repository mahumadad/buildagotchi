// Port of stack-chan firmware face renderer to HTML Canvas.
// Source: stack-chan/firmware/stackchan/renderers/

import { BALLOON, layoutBalloon, scrollOffsetPx } from './balloon-layout.mjs';
import { createIdleExpressionModifier } from './idle-expression.mjs';

const INTERVAL = 1000 / 10;
const DISPLAY_W = 320;
const DISPLAY_H = 240;
const MARGIN_X = 60;
const MARGIN_Y = 60;

function randomBetween(min, max) {
  return min + (max - min) * Math.random();
}

function normRand(m, s) {
  const a = 1 - Math.random();
  const b = 1 - Math.random();
  const c = Math.sqrt(-2 * Math.log(a));
  return (0.5 - Math.random() > 0 ? c * Math.cos(2 * Math.PI * b) : c * Math.sin(2 * Math.PI * b)) * s + m;
}

function quantize(value, divider) {
  return Math.ceil(value * divider) / divider;
}

function linearInEaseOut(fraction) {
  if (fraction < 0.25) return 1 - fraction * 4;
  return ((fraction - 0.25) ** 2 * 16) / 9;
}

function exponentialEaseOut(fraction) {
  return 1 - Math.pow(2, -10 * fraction);
}

function createFaceContext() {
  return {
    mouth: { open: 0 },
    eyes: {
      left: { open: 1, gazeX: 0, gazeY: 0 },
      right: { open: 1, gazeX: 0, gazeY: 0 },
    },
    breath: 1,
    emotion: 'NEUTRAL',
    theme: {
      primary: [255, 255, 255],
      secondary: [0, 0, 0],
    },
  };
}

// --- Modifiers (from modifier.ts) ---

function createBlinkModifier({ openMin, openMax, closeMin, closeMax }) {
  let isBlinking = false;
  let nextToggle = randomBetween(openMin, openMax);
  let count = 0;
  return (tickMs, face) => {
    let eyeOpen = 1;
    if (isBlinking) {
      eyeOpen = 0.2 + linearInEaseOut(count / nextToggle) * 0.8;
    }
    count += tickMs;
    if (count >= nextToggle) {
      isBlinking = !isBlinking;
      count = 0;
      nextToggle = isBlinking ? randomBetween(closeMin, closeMax) : randomBetween(openMin, openMax);
    }
    face.eyes.left.open *= eyeOpen;
    face.eyes.right.open *= eyeOpen;
    return face;
  };
}

function createBreathModifier({ duration }) {
  let time = 0;
  return (tickMs, face) => {
    time += tickMs % duration;
    face.breath = quantize(Math.sin((2 * Math.PI * time) / duration), 8);
    return face;
  };
}

function createSaccadeModifier({ updateMin, updateMax, gain }) {
  let nextToggle = randomBetween(updateMin, updateMax);
  let saccadeX = 0;
  let saccadeY = 0;
  return (tickMs, face) => {
    nextToggle -= tickMs;
    if (nextToggle < 0) {
      saccadeX = normRand(0, gain);
      saccadeY = normRand(0, gain);
      nextToggle = randomBetween(updateMin, updateMax);
    }
    face.eyes.left.gazeX += saccadeX;
    face.eyes.left.gazeY += saccadeY;
    face.eyes.right.gazeX += saccadeX;
    face.eyes.right.gazeY += saccadeY;
    return face;
  };
}

// --- Face parts (from simple-face.ts) ---

function drawEye(ctx, cx, cy, radius, eye) {
  const offsetX = (eye.gazeX ?? 0) * 2;
  const offsetY = (eye.gazeY ?? 0) * 2;
  ctx.beginPath();
  ctx.arc(cx + offsetX, cy + offsetY, radius, 0, 2 * Math.PI);
  ctx.fill();
}

function drawEyelid(ctx, cx, cy, width, height, side, eye, emotion) {
  const w = width;
  const h = height * (1 - eye.open);
  const x = cx - width / 2;
  const y = cy - height / 2;

  ctx.beginPath();
  switch (emotion) {
    case 'ANGRY':
    case 'SAD': {
      let h1 = y + (height + h) / 2;
      let h2 = y + h;
      if (side === 'left') [h1, h2] = [h2, h1];
      if (emotion === 'SAD') [h1, h2] = [h2, h1];
      ctx.moveTo(x, y);
      ctx.lineTo(x, h1);
      ctx.lineTo(x + w, h2);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      break;
    }
    case 'SLEEPY':
      ctx.rect(x, y, w, height * 0.5 + h * 0.5);
      break;
    case 'HAPPY':
      ctx.rect(x, y, w, h * 0.6);
      ctx.rect(x, y + height * 0.6, w, height * 0.4);
      break;
    case 'DOUBTFUL': {
      if (side === 'left') {
        ctx.rect(x, y, w, h * 0.2);
      } else {
        const base = height * 0.6;
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + base * 0.5 + h);
        ctx.lineTo(x + w, y + base + h);
        ctx.lineTo(x + w, y);
        ctx.closePath();
      }
      break;
    }
    case 'COLD':
      ctx.rect(x, y, w, height * 0.4 + h * 0.4);
      break;
    case 'HOT':
      ctx.rect(x, y, w, height * 0.45 + h * 0.35);
      break;
    default:
      ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

function drawMouth(ctx, cx, cy, mouth, emotion, tick, minW = 50, maxW = 90, minH = 8, maxH = 58) {
  const openRatio = mouth.open;
  let h = minH + (maxH - minH) * openRatio;
  let w = minW + (maxW - minW) * (1 - openRatio);
  let offsetX = 0;

  switch (emotion) {
    case 'HAPPY':
      w *= 1.2;
      h = Math.max(h, 12);
      break;
    case 'SAD':
      w *= 0.6;
      break;
    case 'COLD':
      offsetX = Math.sin(tick * 0.05) * 2;
      w *= 0.7;
      break;
    case 'HOT':
      h = Math.max(h, 20);
      break;
    case 'DOUBTFUL':
      w *= 0.7;
      offsetX = 5;
      break;
  }
  ctx.fillRect(cx - w / 2 + offsetX, cy - h / 2, w, h);
}

// --- Decorators (from decorator.ts) ---

function createHeartDecorator(x, y, w = 40, h = 40) {
  let fraction = 0;
  const xs = w / 40;
  const ys = h / 40;
  return (ctx, _face) => {
    fraction += (2 * Math.PI) / 100;
    const scale = Math.abs(Math.sin(fraction)) / 4 + 0.75;
    ctx.save();
    ctx.translate(x + 20 * xs * scale, y + 20 * ys * scale);
    ctx.scale(scale * xs, scale * ys);
    ctx.translate(-20, -20);
    ctx.beginPath();
    ctx.moveTo(20, 13);
    ctx.bezierCurveTo(18, 8, 14, 5, 10, 5);
    ctx.bezierCurveTo(8, 5, 0, 5, 0, 15);
    ctx.bezierCurveTo(0, 30, 18, 35, 20, 40);
    ctx.bezierCurveTo(22, 35, 40, 30, 40, 15);
    ctx.bezierCurveTo(40, 5, 32, 5, 30, 5);
    ctx.bezierCurveTo(26, 5, 22, 8, 20, 13);
    ctx.fill();
    ctx.restore();
  };
}

function createAngryMarkDecorator(x, y, w = 40, h = 40) {
  let fraction = 0;
  const xs = w / 40;
  const ys = h / 40;
  return (ctx, _face) => {
    fraction += (2 * Math.PI) / 100;
    const scale = Math.abs(Math.sin(fraction)) / 4 + 0.75;
    ctx.save();
    ctx.translate(x + 20 * xs * scale, y + 20 * ys * scale);
    ctx.scale(scale * xs, scale * ys);
    ctx.translate(-20, -20);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(15, 5); ctx.quadraticCurveTo(20, 20, 5, 15);
    ctx.moveTo(25, 5); ctx.quadraticCurveTo(20, 20, 35, 15);
    ctx.moveTo(5, 25); ctx.quadraticCurveTo(20, 20, 15, 35);
    ctx.moveTo(25, 35); ctx.quadraticCurveTo(20, 20, 35, 25);
    ctx.stroke();
    ctx.restore();
  };
}

function createQuestionMarkDecorator(x, y, w = 40, h = 40) {
  const xs = w / 40;
  const ys = h / 40;
  return (ctx, _face) => {
    ctx.save();
    ctx.fillStyle = '#3b82f6';
    ctx.font = `bold ${Math.round(30 * Math.min(xs, ys))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(x + 20 * xs, y + 20 * ys);
    ctx.fillText('?', 0, 0);
    ctx.restore();
  };
}

function createSweatDecorator(x, y, w = 40, h = 40) {
  const interval = 3000;
  const xs = w / 40;
  const ys = h / 40;
  const moveY = ys * 15;
  let time = 0;
  return (ctx, _face, tickMs) => {
    time = (time + tickMs) % interval;
    const fraction = Math.min(time / interval, 1);
    const offsetY = exponentialEaseOut(fraction) * moveY;
    ctx.save();
    ctx.translate(x, y + offsetY);
    ctx.scale(xs, ys);
    ctx.beginPath();
    ctx.moveTo(20, 30);
    ctx.bezierCurveTo(30, 30, 30, 15, 20, 0);
    ctx.bezierCurveTo(10, 15, 10, 30, 20, 30);
    ctx.fill();
    ctx.restore();
  };
}

function createSleepyZDecorator(x, y) {
  let time = 0;
  return (ctx, _face, tickMs) => {
    time = (time + tickMs) % 3000;
    const fraction = time / 3000;
    const alpha = 1 - fraction;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `${14 + fraction * 12}px monospace`;
    ctx.fillText('Z', x + fraction * 20, y - fraction * 25);
    ctx.restore();
  };
}

function createBubbleDecorator(x, y, w = 40, h = 40) {
  const xs = w / 40;
  const ys = h / 40;
  const bubbles = [];
  for (let i = 0; i < 4; i++) {
    bubbles.push({
      x: Math.random() * w,
      vx: 0,
      y: Math.random() * h,
      r: 4 + Math.random() * 3,
    });
  }
  return (ctx, _face, tickMs) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.lineWidth = 2 * xs;
    for (const b of bubbles) {
      const upwardSpeed = 1 - b.r / 12;
      b.vx = b.vx * 0.85 + 0.1 * (Math.random() - 0.5);
      b.x = Math.max(b.r, Math.min(w - b.r, b.x + b.vx));
      b.y += upwardSpeed * 2;
      if (b.y > h - b.r) { b.y = b.r; b.x = w * (1 - Math.random() * 0.2); b.vx = -3; }
      b.r = Math.max(3, Math.min(12, b.r + 0.2 * (Math.random() - 0.5)));
      ctx.beginPath();
      ctx.arc(b.x * xs, (h - b.y) * ys, b.r * xs, 0, 2 * Math.PI);
      ctx.stroke();
    }
    ctx.restore();
  };
}

function createHotSteamDecorator(x, y) {
  let time = 0;
  return (ctx, _face, tickMs) => {
    time = (time + tickMs) % 2000;
    const fraction = time / 2000;
    ctx.save();
    ctx.globalAlpha = 0.7 - fraction * 0.5;
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      const sx = x + i * 12;
      const offset = fraction * 20;
      ctx.beginPath();
      ctx.moveTo(sx, y - offset);
      ctx.quadraticCurveTo(sx + 4, y - offset - 8, sx, y - offset - 16);
      ctx.stroke();
    }
    ctx.restore();
  };
}

// Feature A: burbuja redondeada + cola hacia la boca, colores del tema.
// La cola no existe en el firmware upstream — compromiso del fork (DECISIONS).
// `offsetPx` desplaza el texto (scroll), `pop` es la escala de entrada (0..1)
// anclada a la punta de la cola, y `dy` es el breath de la cara para que la
// cola siga pegada a la boca cuando el robot respira.
function drawBalloon(ctx, layout, theme, { offsetPx = 0, pop = 1, dy = 0 } = {}) {
  const [pR, pG, pB] = theme.primary;
  const [sR, sG, sB] = theme.secondary;
  const { x, y, w, h, lines, tail } = layout;
  ctx.save();

  ctx.translate(0, dy);
  if (pop < 1) {
    ctx.translate(tail.tipX, tail.tipY);
    ctx.scale(pop, pop);
    ctx.translate(-tail.tipX, -tail.tipY);
  }

  ctx.fillStyle = `rgb(${pR},${pG},${pB})`;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, BALLOON.radius);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(tail.baseX1, tail.baseY);
  ctx.lineTo(tail.tipX, tail.tipY);
  ctx.lineTo(tail.baseX2, tail.baseY);
  ctx.closePath();
  ctx.fill();

  // Texto clipeado a la burbuja: el scroll nunca se sale del borde redondeado.
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, BALLOON.radius);
  ctx.clip();
  ctx.fillStyle = `rgb(${sR},${sG},${sB})`;
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textTop = y + BALLOON.paddingY + BALLOON.lineH / 2 - offsetPx;
  lines.forEach((line, i) => {
    ctx.fillText(line, x + w / 2, textTop + i * BALLOON.lineH);
  });
  ctx.restore(); // clip

  ctx.restore();
}

function createThinkingDecorator(x, y) {
  let time = 0;
  const radius = 2.5;
  const spacing = 7;
  return (ctx, face, tickMs) => {
    time = (time + tickMs) % 1200;
    const [pR, pG, pB] = face.theme.primary;
    ctx.fillStyle = `rgb(${pR},${pG},${pB})`;
    for (let i = 0; i < 3; i++) {
      const offset = Math.max(0, Math.sin((time + i * 200) / 200) * 3);
      ctx.beginPath();
      ctx.arc(x + i * spacing, y - offset, radius, 0, 2 * Math.PI);
      ctx.fill();
    }
  };
}

// --- Decorator mapping from bridge state ---

const DECORATOR_MAP = {
  heart: (f) => createHeartDecorator(f.w - 55, 10),
  angry_mark: (f) => createAngryMarkDecorator(f.w - 55, 10),
  sweat: (f) => createSweatDecorator(10, 60),
  sleepy_z: (f) => createSleepyZDecorator(f.w - 40, 30),
  bubble: (f) => createBubbleDecorator(f.w - 50, f.h - 70, 40, 50),
  hot_steam: (f) => createHotSteamDecorator(f.w / 2 - 15, 55),
  // Cerca de la boca, a la derecha: visible sin tapar ni ojos ni burbuja.
  thinking: (f) => createThinkingDecorator(f.w - 110, f.h - 70),
  question_mark: (f) => createQuestionMarkDecorator(f.w - 55, 10),
};

const EMOTION_DECORATORS = {
  HAPPY: ['heart'],
  ANGRY: ['angry_mark'],
  SLEEPY: ['sleepy_z'],
  COLD: ['bubble'],
  HOT: ['hot_steam', 'sweat'],
  DOUBTFUL: [],
  SAD: [],
  NEUTRAL: [],
};

// --- Main renderer ---

export class FaceRenderer {
  #canvas;
  #ctx;
  #modifiers;
  #activeDecorators = [];
  #decoratorKeys = [];
  #balloon = null;
  #emotion = 'NEUTRAL';
  #mouthOpen = 0;
  #animId = null;
  #lastTime = 0;
  #tickCount = 0;
  #idle = false;

  constructor(canvas) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d');
    canvas.width = DISPLAY_W;
    canvas.height = DISPLAY_H;

    this.#modifiers = [
      createBlinkModifier({ openMin: 400, openMax: 5000, closeMin: 200, closeMax: 400 }),
      createBreathModifier({ duration: 6000 }),
      createSaccadeModifier({ updateMin: 300, updateMax: 2000, gain: 0.2 }),
      createIdleExpressionModifier({ isIdle: () => this.#idle }),
    ];
  }

  start() {
    this.#animId = setInterval(() => this.#render(INTERVAL), INTERVAL);
  }

  stop() {
    if (this.#animId) clearInterval(this.#animId);
    this.#animId = null;
  }

  setEmotion(emotion) {
    this.#emotion = emotion;
    const autoDecorators = EMOTION_DECORATORS[emotion] ?? [];
    this.setDecorators(autoDecorators);
  }

  setDecorators(decorators) {
    const keys = decorators.map((d) => d.replace?.(' ', '_') ?? d).sort();
    if (JSON.stringify(keys) === JSON.stringify(this.#decoratorKeys)) return;
    this.#decoratorKeys = keys;
    this.#activeDecorators = keys
      .filter((k) => DECORATOR_MAP[k])
      .map((k) => DECORATOR_MAP[k]({ w: DISPLAY_W, h: DISPLAY_H }));
  }

  setBalloon(text) {
    if (text && text !== this.#balloon?.text) {
      // shownAt arranca el scroll y la animación de entrada (pop).
      this.#balloon = { text, layout: layoutBalloon(text), shownAt: performance.now() };
    } else if (!text) {
      this.#balloon = null;
    }
  }

  setMouthOpen(value) {
    this.#mouthOpen = value;
  }

  setIdle(idle) {
    this.#idle = idle;
  }

  #render(tickMs) {
    this.#tickCount++;
    const ctx = this.#ctx;
    const face = createFaceContext();
    face.emotion = this.#emotion;
    face.mouth.open = this.#mouthOpen;

    for (const mod of this.#modifiers) {
      mod(tickMs, face);
    }

    const breathY = face.breath * 3;

    // Clear
    const [bgR, bgG, bgB] = face.theme.secondary;
    ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
    ctx.fillRect(0, 0, DISPLAY_W, DISPLAY_H);

    ctx.save();
    ctx.translate(0, breathY);

    // Clip to face area
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN_X, MARGIN_Y, DISPLAY_W - MARGIN_X * 2, DISPLAY_H - MARGIN_Y * 2);
    ctx.clip();

    // Layer 1 (primary): eyes + mouth
    const [fgR, fgG, fgB] = face.theme.primary;
    ctx.fillStyle = `rgb(${fgR},${fgG},${fgB})`;
    drawEye(ctx, 90, 93, 8, face.eyes.left);
    drawEye(ctx, 230, 96, 8, face.eyes.right);
    drawMouth(ctx, 160, 148, face.mouth, face.emotion, this.#tickCount);

    // Layer 2 (secondary = bg): eyelids mask over eyes
    ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
    drawEyelid(ctx, 90, 93, 24, 24, 'left', face.eyes.left, face.emotion);
    drawEyelid(ctx, 230, 96, 24, 24, 'right', face.eyes.right, face.emotion);

    ctx.restore(); // clip

    // Decorators
    ctx.fillStyle = `rgb(${fgR},${fgG},${fgB})`;
    ctx.strokeStyle = `rgb(${fgR},${fgG},${fgB})`;
    for (const dec of this.#activeDecorators) {
      dec(ctx, face, tickMs);
    }

    ctx.restore(); // breathY

    // Balloon (outside breath transform — el dy se aplica dentro de drawBalloon
    // para que la cola siga a la boca sin heredar el clip de la cara)
    if (this.#balloon) {
      const elapsed = performance.now() - this.#balloon.shownAt;
      drawBalloon(ctx, this.#balloon.layout, face.theme, {
        offsetPx: scrollOffsetPx(this.#balloon.layout.lines.length, elapsed),
        pop: Math.min(1, elapsed / 180),
        dy: breathY,
      });
    }
  }
}
