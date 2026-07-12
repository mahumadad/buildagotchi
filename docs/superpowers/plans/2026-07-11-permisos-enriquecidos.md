# Permisos enriquecidos con PreToolUse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando Claude Code pide un permiso, mostrar en el dashboard y el robot **qué herramienta y con qué input** lo pide (ej. `Bash: git push origin main`, `Edit: server.ts`), en vez del `command` crudo/ausente de hoy. Sin hook bloqueante y sin relay.

**Architecture:** Se agrega el hook `PreToolUse` (verificado en fase 0: trae `tool_name` + `tool_input` estructurado). El adapter guarda el último `PreToolUse` por sesión y, cuando llega el `Notification permission_prompt` inmediatamente después, enriquece el evento de permiso con un resumen de esa tool. La correlación es temporal por sesión: entre el `PreToolUse` de una tool que requiere permiso y su `Notification`, no hay otro `PreToolUse` (la tool está bloqueada esperando decisión). El resumen es un módulo puro y testeable.

**Tech Stack:** Node/TypeScript, vitest.

## Contexto de fase 0 (verificado 2026-07-11)

Con un hook logger temporal en `~/.claude/settings.json` se capturaron payloads reales:

- `PreToolUse`/`PostToolUse` traen: `session_id`, `cwd`, `prompt_id`, `permission_mode`, `tool_name`, `tool_input`, `tool_use_id`, `transcript_path`. `tool_input` por tool: **Bash** `{command, description}`, **Edit** `{file_path, old_string, new_string, replace_all}`, **Write** `{content, file_path}`, **Read** `{file_path, limit, offset}`.
- `PermissionRequest` **no se dispara en headless** y **no aparece** cuando la sesión corre en `bypassPermissions` (que es como corren las sesiones observadas). Por eso este plan NO usa el relay (spec Parte 1): usa el enriquecimiento, que es de cero riesgo y aplica en cuanto una sesión corre en modo `default` y produce un `Notification permission_prompt`.

Los payloads verificados quedaron en `scratchpad/phase0-verified-payloads.jsonl` para referencia.

## Global Constraints

- **Cero regresión**: sin permiso pendiente, o sin `lastToolUse` capturado, el comportamiento es idéntico al actual (el `command` del payload de `/sim/permission` y del transcript siguen teniendo prioridad como fallback).
- **Truncado** (spec §Truncado): Bash → `command` completo hasta 200 chars; Edit/Write/Read → basename del `file_path`; otras tools → `tool_name` + primeras claves. El `tool_input` completo NUNCA viaja al bus ni al robot.
- **Correlación temporal, documentada**: se usa el último `PreToolUse` de la sesión. Tool calls concurrentes (permisos paralelos) quedan fuera de alcance — se documenta como limitación conocida (el relay con lista de `PendingDecision` del spec los cubriría; no se construye aquí).
- **`criticalCommands`** ahora puede correr sobre `tool_input.command` (Bash), más preciso que el texto del transcript. La regla se mantiene: crítico = long-press en el robot.
- No commitear ni pushear sin autorización explícita del usuario en la sesión.
- Español neutro con "tú" en cualquier texto de cara al usuario; nunca voseo.

---

### Task 1: Helper puro `summarizeToolUse`

**Files:**
- Create: `bridge/src/adapters/tool-summary.ts`
- Test: `bridge/test/tool-summary.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `summarizeToolUse(toolName: string, toolInput: Record<string, unknown>): { command?: string; summary: string }` — Task 2 lo importa con este nombre y firma exactos.

- [ ] **Step 1: Write the failing tests**

```typescript
// bridge/test/tool-summary.test.ts
import { describe, expect, it } from 'vitest';
import { summarizeToolUse } from '../src/adapters/tool-summary.js';

/**
 * Fase 0 verificó la forma de tool_input por tool. Este resumen es lo único
 * que viaja al bus/robot — el tool_input completo (un Write de 500 líneas) no.
 */

describe('summarizeToolUse', () => {
  it('Bash: command is the summary, capped at 200 chars', () => {
    const r = summarizeToolUse('Bash', { command: 'git push origin main', description: 'push' });
    expect(r.command).toBe('git push origin main');
    expect(r.summary).toBe('Bash: git push origin main');
  });

  it('Bash: long command truncates with ellipsis at 200', () => {
    const long = 'echo ' + 'x'.repeat(300);
    const r = summarizeToolUse('Bash', { command: long });
    expect(r.command?.length).toBe(200);
    expect(r.command?.endsWith('…')).toBe(true);
    expect(r.summary.startsWith('Bash: echo ')).toBe(true);
  });

  it('Edit: summary is tool + basename, command is the path', () => {
    const r = summarizeToolUse('Edit', {
      file_path: '/Users/x/proj/src/server.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(r.command).toBe('/Users/x/proj/src/server.ts');
    expect(r.summary).toBe('Edit: server.ts');
  });

  it('Write: summary is tool + basename', () => {
    const r = summarizeToolUse('Write', { file_path: '/tmp/notes.md', content: 'hi' });
    expect(r.summary).toBe('Write: notes.md');
  });

  it('Read: summary is tool + basename', () => {
    const r = summarizeToolUse('Read', { file_path: '/tmp/a/b/c.txt' });
    expect(r.summary).toBe('Read: c.txt');
  });

  it('unknown tool: summary is tool name plus first input keys', () => {
    const r = summarizeToolUse('WebFetch', { url: 'https://x.com', prompt: 'summarize' });
    expect(r.summary).toBe('WebFetch: prompt, url');
    expect(r.command).toBeUndefined();
  });

  it('tool with no usable input: summary is just the tool name', () => {
    const r = summarizeToolUse('SomeTool', {});
    expect(r.summary).toBe('SomeTool');
    expect(r.command).toBeUndefined();
  });

  it('missing/invalid fields never throw', () => {
    // @ts-expect-error probing runtime robustness
    expect(() => summarizeToolUse('Bash', null)).not.toThrow();
    const r = summarizeToolUse('Bash', {});
    expect(r.summary).toBe('Bash');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd bridge && npx vitest run test/tool-summary.test.ts`
Expected: FAIL — `Cannot find module '../src/adapters/tool-summary.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// bridge/src/adapters/tool-summary.ts
// Fase 0 (2026-07-11): forma de tool_input verificada empíricamente.
// Este resumen es lo único que sale al bus/robot; el tool_input crudo no.

const MAX_COMMAND = 200;
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function cap(text: string): string {
  if (text.length <= MAX_COMMAND) return text;
  return `${text.slice(0, MAX_COMMAND - 1)}…`;
}

export function summarizeToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): { command?: string; summary: string } {
  const input = toolInput ?? {};

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = cap(input.command);
    return { command, summary: `${toolName}: ${command}` };
  }

  if (FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return { command: input.file_path, summary: `${toolName}: ${basename(input.file_path)}` };
  }

  const keys = Object.keys(input).sort();
  if (keys.length === 0) return { summary: toolName };
  return { summary: `${toolName}: ${keys.join(', ')}` };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd bridge && npx vitest run test/tool-summary.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add bridge/src/adapters/tool-summary.ts bridge/test/tool-summary.test.ts
git commit -m "Add pure tool-use summarizer for permission enrichment"
```

---

### Task 2: Capturar PreToolUse y enriquecer el permiso

**Files:**
- Modify: `bridge/src/hooks/installer.ts` (agregar `'PreToolUse'` a `HOOK_EVENTS`, línea 11-20)
- Modify: `bridge/src/adapters/claude-adapter.ts` (campo `lastToolUse` en `ClaudeSession`; `toolName`/`summary` en `pendingPermission`; handler `PreToolUse`; enriquecimiento en `Notification`)
- Test: `bridge/test/claude-adapter.test.ts` (agregar casos; NO reescribir los existentes)

**Interfaces:**
- Consumes: `summarizeToolUse` de `./tool-summary.js` (Task 1).
- Produces: el evento `permission`/`permission_critical` gana `payload.tool` (el summary) y su `payload.command` pasa a derivarse de `tool_input` cuando existe. `pendingPermission` gana `toolName?: string` y `summary?: string` (los consume Task 3 vía `sessions()`).

- [ ] **Step 1: Add PreToolUse to the installer**

En `bridge/src/hooks/installer.ts`, `HOOK_EVENTS` (línea 11-20), agregar `'PreToolUse'` con un comentario:

```typescript
const HOOK_EVENTS = [
  'UserPromptSubmit',
  'Stop',
  'SessionEnd',
  'Notification',
  'SubagentStop',
  // PostToolUse fires after Claude Code executes a tool the user just approved —
  // it's how we detect that a pendingPermission was resolved outside the dashboard.
  'PostToolUse',
  // PreToolUse fires before a tool runs; it carries tool_name + tool_input, used
  // to enrich the permission event with what tool/command is being asked (fase 0).
  'PreToolUse',
];
```

- [ ] **Step 2: Write failing tests for the enrichment**

Agregar a `bridge/test/claude-adapter.test.ts` (buscar el bloque de tests de `Notification`/`permission` y añadir junto a ellos; reutilizar los helpers de construcción de adapter/bus que ya usa el archivo):

```typescript
  it('enriches a permission with the preceding PreToolUse (Bash)', () => {
    // adapter + bus setup as in sibling tests; sessionId 'S'
    adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'S',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
    });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
    });
    const evt = published.find((e) => e.category === 'permission' || e.category === 'permission_critical');
    expect(evt?.payload.tool).toBe('Bash: git push origin main');
    expect(evt?.payload.command).toBe('git push origin main');
  });

  it('criticality is judged on the enriched command', () => {
    // criticalCommands includes 'git push' in this adapter's deps
    adapter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: 'S',
      cwd: '/proj',
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
    });
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
    });
    const evt = published.find((e) => e.category === 'permission_critical');
    expect(evt).toBeDefined();
  });

  it('permission without a preceding PreToolUse behaves as before (no tool field)', () => {
    adapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: 'S',
      notification_type: 'permission_prompt',
      command: 'legacy command',
    });
    const evt = published.find((e) => e.category === 'permission');
    expect(evt?.payload.command).toBe('legacy command');
    expect(evt?.payload.tool).toBeUndefined();
  });
```

Ajusta los nombres de helpers/variables (`adapter`, `published`, `criticalCommands`) a los que el archivo ya usa. Run: `cd bridge && npx vitest run test/claude-adapter.test.ts` → los 3 nuevos FALLAN.

- [ ] **Step 3: Add the session field and pendingPermission fields**

En `ClaudeSession` (claude-adapter.ts:71-77), extender `pendingPermission` y agregar `lastToolUse`:

```typescript
  pendingPermission?:
    | {
        eventId: string;
        command?: string;
        isCritical: boolean;
        toolName?: string;
        summary?: string;
      }
    | undefined;
  /** Last PreToolUse seen for this session (tool_name + raw input). Used to
   *  enrich the next permission prompt; overwritten on every tool call. */
  lastToolUse?: { toolName: string; toolInput: Record<string, unknown> } | undefined;
```

- [ ] **Step 4: Add the PreToolUse handler**

En el `switch (hookEventName)` de `handleHookEvent`, agregar un caso (junto a `PostToolUse`):

```typescript
      case 'PreToolUse': {
        const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
        const toolInput =
          payload.tool_input && typeof payload.tool_input === 'object'
            ? (payload.tool_input as Record<string, unknown>)
            : undefined;
        if (toolName) {
          session.lastToolUse = { toolName, toolInput: toolInput ?? {} };
        }
        break;
      }
```

- [ ] **Step 5: Enrich the Notification permission handler**

En el `case 'Notification'` (claude-adapter.ts:260-303), justo antes de calcular `command`, derivar el resumen de `lastToolUse` y darle prioridad. Importar arriba: `import { summarizeToolUse } from './tool-summary.js';`

Reemplazar el bloque de cálculo de `command`/`isCritical`/`event`/`pending` por:

```typescript
          const enrichment = this.#readTranscript(payload);
          const tool = session.lastToolUse
            ? summarizeToolUse(session.lastToolUse.toolName, session.lastToolUse.toolInput)
            : undefined;
          // Priority: explicit payload command (sim/push) → PreToolUse-derived →
          // transcript scan. The PreToolUse path is the fase-0 enrichment.
          const command =
            typeof payload.command === 'string'
              ? payload.command
              : typeof payload.message === 'string'
                ? payload.message
                : (tool?.command ?? enrichment?.command);
          const isCritical = command
            ? this.#deps.criticalCommands.some((c) => command.includes(c))
            : false;
          const event = newEvent({
            source: 'claude',
            category: isCritical ? 'permission_critical' : 'permission',
            severity: 'critical',
            payload: {
              sessionId,
              cwd: session.cwd,
              ...(command !== undefined ? { command } : {}),
              ...(tool?.summary !== undefined ? { tool: tool.summary } : {}),
              isCritical,
            },
          });
          const pending: {
            eventId: string;
            command?: string;
            isCritical: boolean;
            toolName?: string;
            summary?: string;
          } = { eventId: event.id, isCritical };
          if (command !== undefined) pending.command = command;
          if (session.lastToolUse) pending.toolName = session.lastToolUse.toolName;
          if (tool?.summary !== undefined) pending.summary = tool.summary;
          session.pendingPermission = pending;
          this.#bus?.publish(event);
```

Note: `lastToolUse` no se limpia al resolver — el próximo `PreToolUse` lo sobrescribe. Documentar como aceptable (un permiso siempre viene precedido por su propio PreToolUse).

- [ ] **Step 6: Run tests**

Run: `cd bridge && npx vitest run test/claude-adapter.test.ts`
Expected: los 3 nuevos PASAN y los existentes siguen verdes.
Luego full suite: `cd bridge && npm test` (los 2 Unhandled Rejection preexistentes de claude-adapter no cuentan).

- [ ] **Step 7: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add bridge/src/hooks/installer.ts bridge/src/adapters/claude-adapter.ts bridge/test/claude-adapter.test.ts
git commit -m "Enrich permission events with PreToolUse tool and command"
```

---

### Task 3: Mostrar la herramienta en dashboard y balloon + docs

**Files:**
- Modify: `bridge/src/server/public/dashboard.js` (card de permiso, ~línea 365-370: usar `summary`/`toolName` cuando estén)
- Modify: `bridge/src/server/server.ts` (`#sessionsPayload`, ~línea 384-407: incluir `toolName`/`summary` del `pendingPermission` en el payload de sesión que va al dashboard — verificar qué campos expone hoy y añadir estos)
- Modify: `config.example.yaml` (templates de balloon de permiso: usar `{tool}` con fallback)
- Modify: `DEVLOG.md`, `docs/superpowers/specs/2026-07-11-decisiones-interactivas.md` (marcar alcance real)

**Interfaces:**
- Consumes: `pendingPermission.summary`/`toolName` (Task 2), `payload.tool` en el evento.

- [ ] **Step 1: Expose the fields in the sessions payload**

En `server.ts` `#sessionsPayload` (línea ~384-407), donde se serializa `pendingPermission` de cada sesión, incluir los campos nuevos. Leer primero cómo se arma hoy (probablemente copia `{eventId, command, isCritical}`) y añadir `toolName` y `summary` cuando existan. Ajustar el tipo si está declarado.

- [ ] **Step 2: Show tool + summary in the dashboard card**

En `dashboard.js` (~línea 365-370), donde hoy hace:

```javascript
      const cmd = session.pendingPermission.command ?? '(command unavailable)';
      const marker = session.pendingPermission.isCritical ? '⚠ ' : '';
```

preferir el `summary` enriquecido cuando exista, cayendo al command:

```javascript
      const detail = session.pendingPermission.summary ?? session.pendingPermission.command ?? '(command unavailable)';
      const marker = session.pendingPermission.isCritical ? '⚠ ' : '';
```

y usar `detail` donde antes usaba `cmd`. No cambiar nada más de la card.

- [ ] **Step 3: Balloon template uses the tool summary**

En `config.example.yaml`, los templates de permiso. El interpolador (`interpolate.ts`) resuelve `{campo}` desde el payload; `{tool}` ahora existe cuando hubo PreToolUse. Cambiar a un template que prefiera la herramienta y siga funcionando sin ella. Verificar en `interpolate.ts` cómo se comporta un `{campo}` ausente (si deja el literal `{tool}` o lo vacía) y elegir el template en consecuencia:

```yaml
  - match: { source: claude, category: permission_critical }
    state:
      # ...
      balloon: "{project}: ⚠ {command}"   # command sigue presente siempre que tool lo esté

  - match: { source: claude, category: permission }
    state:
      # ...
      balloon: "{project}: {command}"
```

Si `interpolate.ts` soporta un fallback (`{tool|command}` u similar), úsalo para mostrar `{tool}`; si NO lo soporta, **no** inventes sintaxis — deja `{command}` (que ya se enriquece con el comando real del tool_input) y anota en el DEVLOG que mostrar el nombre de la tool en el balloon queda para cuando el interpolador tenga fallbacks. Este step es de verificación + decisión, no de forzar `{tool}`.

- [ ] **Step 4: Verify E2E in the browser**

Con el bridge corriendo, simular el camino de hooks con curl (dado que `/sim/permission` no manda tool_input, se prueba el enriquecimiento posteando los hooks directo):

```bash
# PreToolUse seguido de Notification permission_prompt para la misma sesión
curl -s -X POST localhost:1780/hooks/claude -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"PreToolUse","session_id":"enrich-test","cwd":"/proj","tool_name":"Bash","tool_input":{"command":"git push origin main"}}'
curl -s -X POST localhost:1780/hooks/claude -H 'Content-Type: application/json' \
  -d '{"hook_event_name":"Notification","session_id":"enrich-test","notification_type":"permission_prompt"}'
```

Verificar en el dashboard: la card de la sesión `enrich-test` muestra `Bash: git push origin main`. Confirmar con `read_page`/screenshot. Revisar consola sin errores.

- [ ] **Step 5: Docs**

- `DEVLOG.md`: entrada nueva — qué se hizo (enriquecimiento de permisos con PreToolUse, fase 0 que descartó el relay por bypassPermissions), archivos, verificación, decisión de alcance.
- `docs/superpowers/specs/2026-07-11-decisiones-interactivas.md`: en el encabezado o una nota de estado, registrar que se implementó **solo el enriquecimiento** (no el relay ni AskUserQuestion), con el motivo de fase 0 (sesiones en bypassPermissions; `PermissionRequest` no verificable). El relay y la Parte 2 quedan como trabajo futuro.

- [ ] **Step 6: Commit** (requiere autorización del usuario; si no la hay, reportar diff listo)

```bash
git add bridge/src/server/public/dashboard.js bridge/src/server/server.ts config.example.yaml DEVLOG.md docs/superpowers/specs/2026-07-11-decisiones-interactivas.md
git commit -m "Show permission tool detail in dashboard and document scope"
```
