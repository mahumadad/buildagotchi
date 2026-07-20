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
  visibleLines: 2, // ventana visible; las líneas extra se revelan con scroll
  maxLines: 12, // tope de seguridad — el servidor ya trunca a 240 chars (~8 líneas)
  displayW: 320,
  displayH: 240,
  mouth: { x: 160, y: 148 }, // face-renderer.js drawMouth(ctx, 160, 148, ...)
  tailHalfWidth: 8,
  // La punta de la cola apunta al borde INFERIOR de la boca (boca cerrada:
  // 148 + 8/2 = 152), no a su centro — apuntar al centro enterraba la punta
  // dentro del rectángulo de la boca.
  tailTipOffset: 8,
  // Separación boca → borde superior de la burbuja. Con 12px la burbuja quedaba
  // a 8px de la boca cerrada y se solapaba con la boca abierta (hasta y=177).
  // Máximo posible: displayH - mouth.y - altura máx. de burbuja (52) = 40.
  tailLength: 28,
};

// Ritmo del scroll vertical del texto (ver scrollOffsetPx). Puro: depende solo
// de elapsedMs, así se testea sin canvas.
export const BALLOON_SCROLL = {
  startHoldMs: 1200, // pausa para leer la primera ventana antes de moverse
  lineSlideMs: 250, // desliz de una línea (a 10fps son 2-3 frames, estética steppy)
  lineHoldMs: 800, // pausa entre línea y línea
  endHoldMs: 2500, // pausa en la última ventana antes de volver al inicio
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
  // Ya NO se trunca a la ventana visible: las líneas extra se muestran con
  // scroll (scrollOffsetPx). Solo se capa al tope de seguridad maxLines.
  if (lines.length > cfg.maxLines) {
    lines = lines.slice(0, cfg.maxLines);
    const last = lines[cfg.maxLines - 1];
    lines[cfg.maxLines - 1] = `${last.slice(0, maxChars - 1)}…`;
  }
  const visibleLines = Math.min(lines.length, cfg.visibleLines);
  const longest = Math.max(...lines.map((l) => l.length));
  const w = Math.min(cfg.maxWidth, Math.max(cfg.minWidth, longest * cfg.charW + cfg.paddingX * 2));
  // La altura cubre solo la ventana visible — la burbuja no crece con el scroll.
  const h = Math.max(cfg.minHeight, visibleLines * cfg.lineH + cfg.paddingY * 2);
  const x = Math.round((cfg.displayW - w) / 2);
  // La burbuja cuelga bajo la boca: su borde superior queda `tailLength` px por
  // debajo, y la cola sube desde ahí hasta el borde inferior de la boca. La
  // cola nace en el borde superior de la burbuja, no en el inferior.
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
    visibleLines,
    tail: {
      baseX1: baseCx - cfg.tailHalfWidth,
      baseX2: baseCx + cfg.tailHalfWidth,
      baseY: y,
      tipX: baseCx + Math.sign(cfg.mouth.x - baseCx) * 4,
      tipY: cfg.mouth.y + cfg.tailTipOffset,
    },
  };
}

/**
 * Desplazamiento vertical (px) del texto dentro de la burbuja, en función del
 * tiempo desde que apareció. La ventana visible de `visibleLines` líneas se
 * desliza línea a línea hasta el final, aguanta `endHoldMs` y vuelve al
 * inicio de golpe (a 10fps el salto no se percibe como corte).
 */
export function scrollOffsetPx(totalLines, elapsedMs, cfg = BALLOON, scroll = BALLOON_SCROLL) {
  const extra = totalLines - cfg.visibleLines;
  if (extra <= 0) return 0;
  const cycleMs =
    scroll.startHoldMs +
    extra * scroll.lineSlideMs +
    (extra - 1) * scroll.lineHoldMs +
    scroll.endHoldMs;
  let t = elapsedMs % cycleMs;
  if (t < scroll.startHoldMs) return 0;
  t -= scroll.startHoldMs;
  for (let i = 1; i <= extra; i++) {
    if (t < scroll.lineSlideMs) {
      const f = t / scroll.lineSlideMs;
      const eased = 1 - (1 - f) ** 2; // ease-out cuadrático
      return (i - 1 + eased) * cfg.lineH;
    }
    t -= scroll.lineSlideMs;
    if (i < extra && t < scroll.lineHoldMs) return i * cfg.lineH;
    if (i < extra) t -= scroll.lineHoldMs;
  }
  return extra * cfg.lineH; // endHold
}
