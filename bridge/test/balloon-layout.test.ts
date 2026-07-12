// bridge/test/balloon-layout.test.ts
import { describe, expect, it } from 'vitest';
import { BALLOON, layoutBalloon, wrapBalloonText } from '../src/server/public/balloon-layout.mjs';

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

  it('long text wraps to two lines and grows height', () => {
    const text = 'permiso pendiente en la sesion del bridge de stackchan';
    const l = layoutBalloon(text);
    expect(l.lines.length).toBe(2);
    expect(l.h).toBe(2 * BALLOON.lineH + 2 * BALLOON.paddingY);
  });

  it('text beyond maxLines truncates with ellipsis', () => {
    const text = 'a'.repeat(500);
    const l = layoutBalloon(text);
    expect(l.lines.length).toBe(BALLOON.maxLines);
    expect(l.lines[BALLOON.maxLines - 1].endsWith('…')).toBe(true);
  });

  it('wrap parity: line count matches k8x12-12 metrics at max width', () => {
    // maxChars = floor((300 - 36) / 8) = 33
    const text = 'x'.repeat(34); // 34 chars > 33 → exactly 2 lines
    const l = layoutBalloon(text);
    expect(l.lines.length).toBe(2);
  });

  it('bubble hangs below the mouth, clear of the eye band, inside the screen', () => {
    const worst = layoutBalloon('a'.repeat(500));
    // top edge sits below the mouth (148); eyes/eyelids live at y≈81–108
    expect(worst.y).toBeGreaterThan(BALLOON.mouth.y);
    // even the tallest bubble stays on screen
    expect(worst.y + worst.h).toBeLessThanOrEqual(BALLOON.displayH);
  });

  it('tail rises from the top of the bubble to the mouth', () => {
    const l = layoutBalloon('ok');
    // base on the bubble's top edge, tip at the mouth (above the base)
    expect(l.tail.baseY).toBe(l.y);
    expect(l.tail.tipY).toBe(BALLOON.mouth.y);
    expect(l.tail.tipY).toBeLessThan(l.tail.baseY);
    // base centrada respecto a la boca (160), clampeada dentro de la burbuja
    expect(l.tail.baseX1).toBeGreaterThanOrEqual(l.x + BALLOON.radius);
    expect(l.tail.baseX2).toBeLessThanOrEqual(l.x + l.w - BALLOON.radius);
  });
});
