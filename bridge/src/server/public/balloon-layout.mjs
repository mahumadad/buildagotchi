// bridge/src/server/public/balloon-layout.mjs
// Feature A (spec adopcion-firmware-original rev 2): geometría pura del
// balloon. Métrica k8x12-12 del firmware: 8 px/char a 12 px. La burbuja va
// DEBAJO de la boca (y=148) con la cola subiendo hacia ella, para que
// "parezca que sale de la boca" — los ojos (banda y≈81–108) quedan libres.

export const BALLOON = {
  charW: 8,
  lineH: 16,
  paddingX: 18, // firmware speech-balloon.ts:18-27
  paddingY: 10,
  minWidth: 90, // factory speech_bubble.cpp: rango 90..340, capado a 300 en 320px
  maxWidth: 300,
  minHeight: 32,
  radius: 14,
  maxLines: 2,
  displayW: 320,
  displayH: 240,
  mouth: { x: 160, y: 148 }, // face-renderer.js drawMouth(ctx, 160, 148, ...)
  tailHalfWidth: 8,
  tailLength: 12, // separación entre la boca y el borde superior de la burbuja
};

export function wrapBalloonText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    let w = word;
    while (w.length > maxChars) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(w.slice(0, maxChars));
      w = w.slice(maxChars);
    }
    if (w.length === 0) continue;
    const candidate = line ? `${line} ${w}` : w;
    if (candidate.length <= maxChars) {
      line = candidate;
    } else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export function layoutBalloon(text, cfg = BALLOON) {
  const maxChars = Math.floor((cfg.maxWidth - cfg.paddingX * 2) / cfg.charW);
  let lines = wrapBalloonText(text, maxChars);
  if (lines.length > cfg.maxLines) {
    lines = lines.slice(0, cfg.maxLines);
    const last = lines[cfg.maxLines - 1];
    lines[cfg.maxLines - 1] = `${last.slice(0, maxChars - 1)}…`;
  }
  const longest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(cfg.maxWidth, Math.max(cfg.minWidth, longest * cfg.charW + cfg.paddingX * 2));
  const h = Math.max(cfg.minHeight, lines.length * cfg.lineH + cfg.paddingY * 2);
  const x = Math.round((cfg.displayW - w) / 2);
  // La burbuja cuelga bajo la boca: su borde superior queda `tailLength` px por
  // debajo, y la cola sube desde ahí hasta la boca. La cola nace en el borde
  // superior de la burbuja, no en el inferior.
  const y = cfg.mouth.y + cfg.tailLength;

  const minCx = x + cfg.radius + cfg.tailHalfWidth;
  const maxCx = x + w - cfg.radius - cfg.tailHalfWidth;
  const baseCx = Math.min(Math.max(cfg.mouth.x, minCx), maxCx);

  return {
    x,
    y,
    w,
    h,
    lines,
    tail: {
      baseX1: baseCx - cfg.tailHalfWidth,
      baseX2: baseCx + cfg.tailHalfWidth,
      baseY: y,
      tipX: baseCx + Math.sign(cfg.mouth.x - baseCx) * 4,
      tipY: cfg.mouth.y,
    },
  };
}
