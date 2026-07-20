// bridge/test/balloon-layout.test.ts
import { describe, expect, it } from 'vitest';
import {
  BALLOON,
  BALLOON_SCROLL,
  layoutBalloon,
  scrollOffsetPx,
  wrapBalloonText,
} from '../src/server/public/balloon-layout.mjs';

/**
 * Feature A del spec adopcion-firmware-original (rev 2). La geometría es pura
 * para poder testear el wrap contra la métrica de k8x12-12 (8px/char) sin
 * canvas — si el wrap diverge del firmware, el emulador miente sobre cuántas
 * líneas verá el robot.
 */

describe('wrapBalloonText', () => {
  it('one short line stays one line', () => {
    expect(wrapBalloonText('hola', 33)).toEqual(['hola']);
  });

  it('wraps at word boundaries', () => {
    // maxChars 10: 'hola mundo cruel' → 'hola mundo' / 'cruel'
    expect(wrapBalloonText('hola mundo cruel', 10)).toEqual(['hola mundo', 'cruel']);
  });

  it('breaks a word longer than the line', () => {
    expect(wrapBalloonText('abcdefghijkl', 5)).toEqual(['abcde', 'fghij', 'kl']);
  });

  it('empty text yields a single empty line', () => {
    expect(wrapBalloonText('', 33)).toEqual(['']);
  });
});

describe('layoutBalloon', () => {
  it('short text: min width, single-line height, centered', () => {
    const l = layoutBalloon('ok');
    expect(l.w).toBe(BALLOON.minWidth);
    // una línea: lineH + 2*paddingY = 36 (> minHeight 32, que nunca gana aquí)
    expect(l.h).toBe(BALLOON.lineH + 2 * BALLOON.paddingY);
    expect(l.x).toBe(Math.round((320 - l.w) / 2));
    expect(l.lines).toEqual(['ok']);
  });

  it('long text wraps to the visible window and keeps the extra lines for scroll', () => {
    const text = 'permiso pendiente en la sesion del bridge de stackchan y hay que aprobarlo ya';
    const l = layoutBalloon(text);
    expect(l.lines.length).toBeGreaterThan(BALLOON.visibleLines);
    expect(l.visibleLines).toBe(BALLOON.visibleLines);
    // la altura cubre solo la ventana visible — el scroll revela el resto
    expect(l.h).toBe(BALLOON.visibleLines * BALLOON.lineH + 2 * BALLOON.paddingY);
  });

  it('text beyond the safety cap truncates with ellipsis', () => {
    const text = 'a'.repeat(2000);
    const l = layoutBalloon(text);
    expect(l.lines.length).toBe(BALLOON.maxLines);
    expect(l.lines.at(-1)?.endsWith('…')).toBe(true);
  });

  it('wrap parity: line count matches k8x12-12 metrics at max width', () => {
    // maxChars = floor((300 - 36) / 8) = 33
    const text = 'x'.repeat(34); // 34 chars > 33 → exactly 2 lines
    const l = layoutBalloon(text);
    expect(l.lines.length).toBe(2);
  });

  it('bubble hangs below the mouth, clear of the eye band, inside the screen', () => {
    const worst = layoutBalloon('a'.repeat(2000));
    // top edge sits below the mouth (148); eyes/eyelids live at y≈81–108
    expect(worst.y).toBeGreaterThan(BALLOON.mouth.y);
    // even the tallest bubble stays on screen
    expect(worst.y + worst.h).toBeLessThanOrEqual(BALLOON.displayH);
  });

  it('tail rises from the top of the bubble to just below the mouth', () => {
    const l = layoutBalloon('ok');
    // base on the bubble's top edge, tip at the mouth's lower edge (above the base)
    expect(l.tail.baseY).toBe(l.y);
    expect(l.tail.tipY).toBe(BALLOON.mouth.y + BALLOON.tailTipOffset);
    expect(l.tail.tipY).toBeLessThan(l.tail.baseY);
    // la boca cerrada termina en 148 + 8/2 = 152: la punta no entra en la boca
    expect(l.tail.tipY).toBeGreaterThanOrEqual(152);
    // base centrada respecto a la boca (160), clampeada dentro de la burbuja
    expect(l.tail.baseX1).toBeGreaterThanOrEqual(l.x + BALLOON.radius);
    expect(l.tail.baseX2).toBeLessThanOrEqual(l.x + l.w - BALLOON.radius);
  });
});

describe('scrollOffsetPx', () => {
  // 5 líneas con ventana de 2 → 3 desplazamientos de línea
  const lines = 5;
  const extra = lines - BALLOON.visibleLines; // 3

  it('stays at 0 while the text fits the visible window', () => {
    expect(scrollOffsetPx(BALLOON.visibleLines, 999_999)).toBe(0);
    expect(scrollOffsetPx(1, 999_999)).toBe(0);
  });

  it('holds at 0 during the initial pause', () => {
    expect(scrollOffsetPx(lines, 0)).toBe(0);
    expect(scrollOffsetPx(lines, BALLOON_SCROLL.startHoldMs - 1)).toBe(0);
  });

  it('slides one line per step until the last window', () => {
    const s = BALLOON_SCROLL;
    // mitad del primer desliz: ease-out cuadrático de 0.5 → 0.75 líneas
    const mid = scrollOffsetPx(lines, s.startHoldMs + s.lineSlideMs / 2);
    expect(mid).toBeCloseTo(0.75 * BALLOON.lineH, 5);
    // línea completada + pausa
    const held = scrollOffsetPx(lines, s.startHoldMs + s.lineSlideMs + 1);
    expect(held).toBe(BALLOON.lineH);
    // última ventana: extra líneas desplazadas
    const end = s.startHoldMs + extra * s.lineSlideMs + (extra - 1) * s.lineHoldMs + 1;
    expect(scrollOffsetPx(lines, end)).toBe(extra * BALLOON.lineH);
  });

  it('loops back to the start after the end pause', () => {
    const s = BALLOON_SCROLL;
    const cycle = s.startHoldMs + extra * s.lineSlideMs + (extra - 1) * s.lineHoldMs + s.endHoldMs;
    // justo al completar el ciclo vuelve a 0 (salto instantáneo)
    expect(scrollOffsetPx(lines, cycle)).toBe(0);
    // y el segundo ciclo se comporta como el primero
    expect(scrollOffsetPx(lines, cycle + s.startHoldMs + s.lineSlideMs + 1)).toBe(BALLOON.lineH);
  });
});
