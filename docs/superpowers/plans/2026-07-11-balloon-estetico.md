# Balloon estético Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el balloon plano del emulador por una burbuja redondeada con cola hacia la boca, colores del tema y wrap multi-línea, según Feature A del spec [2026-07-11-adopcion-firmware-original.md](../specs/2026-07-11-adopcion-firmware-original.md) (rev 2, post-council).

**Architecture:** La geometría del balloon (wrap, tamaño, posición, cola) se extrae a un módulo puro `balloon-layout.mjs` testeable sin canvas, siguiendo el patrón de `screen.mjs`. `face-renderer.js` solo dibuja el layout con los colores de `face.theme`. Nada cambia server-side: el balloon sigue llegando como string en `ResolvedState.balloon` (S2.5.1).

**Tech Stack:** Vanilla JS (módulos ESM en `bridge/src/server/public/`), vitest + jsdom para tests, Canvas 2D (`roundRect`).

## Global Constraints

- El emulador no muestra capacidades que el robot no tendrá: la divergencia del balloon (cola inexistente en el firmware upstream) se ancla en DECISIONS como compromiso del fork y en DEBT como divergencia consciente (spec Feature A §4).
- Wrap con métrica de fuente bitmap: monospace, **8 px por carácter a 12 px** (equivalente a `k8x12-12` del firmware). Criterio spec: con el mismo texto, el número de líneas coincide con el que produciría `k8x12-12` en 320 px.
- Padding del firmware: `paddingX: 18`, `paddingY: 10`, `minHeight: 32` (`stack-chan/firmware/stackchan/renderers-piu/effects/speech-balloon.ts:18-27`).
- Burbuja = `theme.primary`, texto = `theme.secondary` (mismo contrato que el firmware). Nada de colores hardcodeados.
- Ni burbuja ni cola invaden la banda de los ojos: los párpados del emulador empiezan en y≈81 y breath mueve la cara ±3 px → **borde inferior de la cola ≤ 76** (C6 del council).
- Sin marquee: texto largo hace wrap; más de 2 líneas trunca con `…` (no-objetivo del spec).
- Máximo 2 líneas: con `top: 6`, 2 líneas dan burbuja hasta y=58 y cola hasta y=70 ≤ 76. Tres líneas violarían la banda de ojos.
- No commitear ni pushear sin autorización explícita del usuario en la sesión.

---

### Task 1: Módulo puro de layout (`balloon-layout.mjs`)

**Files:**
- Create: `bridge/src/server/public/balloon-layout.mjs`
- Test: `bridge/test/balloon-layout.test.ts`

**Interfaces:**
- Consumes: nada (módulo puro, sin dependencias).
- Produces: `BALLOON` (config), `wrapBalloonText(text, maxChars): string[]`, `layoutBalloon(text, cfg?): {x, y, w, h, lines, tail}` — Task 2 los importa con estos nombres exactos.

- [ ] **Step 1: Write the failing tests**

```typescript
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

  it('bubble and tail never invade the eye band (y <= 76)', () => {
    const worst = layoutBalloon('a'.repeat(500));
    expect(worst.y + worst.h).toBeLessThanOrEqual(64);
    expect(worst.tail.tipY).toBeLessThanOrEqual(76);
  });

  it('tail points toward the mouth and stays under the bubble', () => {
    const l = layoutBalloon('ok');
    expect(l.tail.baseY).toBe(l.y + l.h - 1);
    expect(l.tail.tipY).toBeGreaterThan(l.tail.baseY);
    // base centrada respecto a la boca (160), clampeada dentro de la burbuja
    expect(l.tail.baseX1).toBeGreaterThanOrEqual(l.x + BALLOON.radius);
    expect(l.tail.baseX2).toBeLessThanOrEqual(l.x + l.w - BALLOON.radius);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npx vitest run test/balloon-layout.test.ts`
Expected: FAIL — `Cannot find module '../src/server/public/balloon-layout.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
// bridge/src/server/public/balloon-layout.mjs
// Feature A (spec adopcion-firmware-original rev 2): geometría pura del
// balloon. Métrica k8x12-12 del firmware: 8 px/char a 12 px. La banda de los
// ojos empieza en y≈81 (párpados) y breath mueve ±3 px → cola ≤ 76 (C6).

export const BALLOON = {
  charW: 8,
  lineH: 16,
  paddingX: 18, // firmware speech-balloon.ts:18-27
  paddingY: 10,
  minWidth: 90, // factory speech_bubble.cpp: rango 90..340, capado a 300 en 320px
  maxWidth: 300,
  minHeight: 32,
  radius: 14,
  top: 6,
  maxLines: 2,
  displayW: 320,
  mouth: { x: 160, y: 148 }, // face-renderer.js drawMouth(ctx, 160, 148, ...)
  tailHalfWidth: 8,
  tailLength: 12,
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
  const y = cfg.top;

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
      baseY: y + h - 1,
      tipX: baseCx + Math.sign(cfg.mouth.x - baseCx) * 4,
      tipY: y + h + cfg.tailLength,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bridge && npx vitest run test/balloon-layout.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add bridge/src/server/public/balloon-layout.mjs bridge/test/balloon-layout.test.ts
git commit -m "Add pure balloon layout module with firmware metrics"
```

---

### Task 2: Dibujo en `face-renderer.js` con tema y cola

**Files:**
- Modify: `bridge/src/server/public/face-renderer.js` (función `createBalloonDecorator` líneas 328-359, método `setBalloon` líneas 436-445, render del balloon líneas 501-504)

**Interfaces:**
- Consumes: `layoutBalloon`, `BALLOON` de `./balloon-layout.mjs` (Task 1).
- Produces: nada nuevo hacia afuera — `setBalloon(text)` conserva su firma.

- [ ] **Step 1: Add the import**

En la cabecera de `bridge/src/server/public/face-renderer.js` (tras la línea 1, junto a los imports existentes si los hay; si no hay imports, primera línea):

```javascript
import { BALLOON, layoutBalloon } from './balloon-layout.mjs';
```

- [ ] **Step 2: Replace `createBalloonDecorator` with `drawBalloon`**

Eliminar la función `createBalloonDecorator` completa (líneas 328-359) y poner en su lugar:

```javascript
// Feature A: burbuja redondeada + cola hacia la boca, colores del tema.
// La cola no existe en el firmware upstream — compromiso del fork (DECISIONS).
function drawBalloon(ctx, layout, theme) {
  const [pR, pG, pB] = theme.primary;
  const [sR, sG, sB] = theme.secondary;
  const { x, y, w, h, lines, tail } = layout;
  ctx.save();

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

  ctx.fillStyle = `rgb(${sR},${sG},${sB})`;
  ctx.font = '12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const textTop = y + h / 2 - ((lines.length - 1) * BALLOON.lineH) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, x + w / 2, textTop + i * BALLOON.lineH);
  });
  ctx.restore();
}
```

- [ ] **Step 3: Update `setBalloon` and the render call**

Reemplazar el método `setBalloon` (líneas 436-445) por:

```javascript
  setBalloon(text) {
    if (text && text !== this.#balloon?.text) {
      this.#balloon = { text, layout: layoutBalloon(text) };
    } else if (!text) {
      this.#balloon = null;
    }
  }
```

Reemplazar el bloque de render del balloon (líneas 501-504):

```javascript
    // Balloon (outside breath transform)
    if (this.#balloon) {
      drawBalloon(ctx, this.#balloon.layout, face.theme);
    }
```

- [ ] **Step 4: Run the full suite (regression)**

Run: `cd bridge && npm test`
Expected: todos los tests pasan (los 2 Unhandled Rejection preexistentes de `claude-adapter.test.ts` no cuentan como fallo).

- [ ] **Step 5: Verify in the browser**

Con el bridge corriendo (`npm run dev`, dashboard en `localhost:1780`):
1. Disparar un balloon: `curl -X POST localhost:1780/sim/permission -H 'Content-Type: application/json' -d '{"sessionId":"test"}'` (o el botón "Fake permission prompt" del dashboard).
2. Verificar: burbuja redondeada arriba, cola apuntando hacia la boca, texto centrado, sin invadir los ojos, colores blanco/negro del tema.
3. Probar un texto largo (balloon de contexto o replay) y verificar wrap a 2 líneas sin marquee.

Expected: burbuja visible con cola; ningún error en consola del navegador.

- [ ] **Step 6: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add bridge/src/server/public/face-renderer.js
git commit -m "Draw balloon with rounded bubble, tail and theme colors"
```

---

### Task 3: Anclas de documentación (DECISIONS + DEBT)

**Files:**
- Modify: `DECISIONS.md` (agregar ancla nueva al final de la sección de decisiones, con el siguiente número D libre — verificar el último usado con `grep -o 'D[0-9]*' DECISIONS.md | sort -V | tail -1`)
- Modify: `DEBT.md` (agregar entrada nueva con el siguiente número D- libre — el último conocido es D-15)

**Interfaces:**
- Consumes: nada de código.
- Produces: anclas citables (`D<n>`, `D-<m>`) que el spec y futuros planes referencian.

- [ ] **Step 1: Add the DECISIONS anchor**

Agregar a `DECISIONS.md`, siguiendo el formato de las decisiones existentes (leer 2-3 anclas previas para calcar el estilo), con este contenido:

> **D<n> — El balloon del fork de firmware replica el del emulador.** El
> emulador dibuja burbuja redondeada + cola hacia la boca + tema de 2 colores
> (Feature A, spec 2026-07-11-adopcion-firmware-original rev 2). La cola no
> existe en el firmware upstream (`stack-chan`: 9-slice sin cola; factory:
> flecha fija). Nuestro fork la implementará con la misma geometría
> (`balloon-layout.mjs` es la referencia). Hasta entonces la divergencia vive
> en DEBT. Del mismo council: el mod MCP del firmware upstream
> (`mods/mcp/mod.js`, `set_emotion`/`say_message` en :8080) queda anotado como
> **opción** de canal de debugging cuando llegue el robot — no compromiso.

- [ ] **Step 2: Add the DEBT entry**

Agregar a `DEBT.md`, siguiendo el formato de entradas existentes (dónde está, por qué no explotó, qué la haría explotar, costo del fix):

> **D-<m> — Balloon del emulador diverge del firmware upstream.**
> Dónde: `bridge/src/server/public/balloon-layout.mjs` + `face-renderer.js`
> (burbuja con cola) vs `stack-chan/firmware/.../speech-balloon.ts` (9-slice
> sin cola). Por qué no explotó: no hay hardware todavía; el emulador es el
> único display. Qué la haría explotar: flashear el firmware upstream sin
> portar el balloon — el robot mostraría un balloon distinto al que el
> emulador prometió. Costo del fix: implementar el balloon en el fork
> (geometría ya especificada en `balloon-layout.mjs`); estimado 1-2 días de
> trabajo Moddable/Piu cuando llegue el CoreS3 (D<n>).

- [ ] **Step 3: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add DECISIONS.md DEBT.md
git commit -m "Anchor firmware balloon commitment and emulator divergence"
```
