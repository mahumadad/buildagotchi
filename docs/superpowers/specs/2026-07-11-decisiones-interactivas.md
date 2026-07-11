# Decisiones interactivas — permisos reales y preguntas visibles

**Fecha**: 2026-07-11
**Estado**: aprobado (rev 2 — post-council), pendiente de plan de implementación

> **Nota de estado (2026-07-11, post-implementación parcial):** de este spec
> solo se implementó el **enriquecimiento de permisos con `PreToolUse`**
> (Tasks 1-3: `summarizeToolUse`, campos `toolName`/`summary` en
> `pendingPermission`, y su superficie en dashboard/balloon — ver DEVLOG
> 2026-07-11 "Decisiones interactivas: solo el enriquecimiento (fase 0)").
> **La Parte 1 (relay real vía hook `PermissionRequest`, con
> `decision.behavior` para responder de verdad) y la Parte 2
> (`AskUserQuestion` visible) NO se implementaron.** Motivo: las sesiones de
> Claude Code corren en `bypassPermissions`, así que el hook
> `PermissionRequest` que la Parte 1 necesita nunca se dispara en este setup
> — no hay nada que relayar. Verificar el mecanismo en modo interactivo real
> (fuera de `bypassPermissions`) es un prerequisito no resuelto antes de
> construir el relay. Ambas partes quedan como trabajo futuro, sin plan de
> implementación todavía.

## Objetivo

Cuando Claude Code pide una decisión al usuario —un permiso de herramienta o
una pregunta de opción múltiple (`AskUserQuestion`)— el buildagotchi debe:

1. **Mostrar la decisión con su contenido real** (qué tool, qué comando, qué
   pregunta, qué opciones) en el dashboard y en el robot, no solo "permiso
   pendiente".
2. **Responder de verdad lo que se pueda responder**: los permisos. Hoy el
   approve del dashboard es cosmético; con esto pasa a resolver el prompt real.
3. **Preparar la migración al CoreS3**: la interfaz bridge↔vistas se diseña
   como si todo fuera respondible, para que el salto futuro al Agent SDK (modo
   host) cambie el adaptador, no las vistas.

## Hechos verificados (2026-07-11)

Investigación contra la documentación oficial de Claude Code
(`code.claude.com/docs/en/hooks.md`, `agent-sdk/permissions.md`, `channels.md`):

| Mecanismo | Leer contenido | Responder programáticamente |
|---|---|---|
| Hook `PermissionRequest` | sí — `tool_name` + `tool_input` completos | **sí** — `decision.behavior: "allow"\|"deny"` suprime el prompt del terminal |
| Hook `PreToolUse` con matcher `AskUserQuestion` | sí — `tool_input.questions[]` con opciones | **no** — aunque el hook devuelva `allow`, la UI interactiva se muestra igual (documentado: "always fall through to the callback, even when an allow rule matches") |
| Hook `PostToolUse` de `AskUserQuestion` | sí — `tool_response` trae la respuesta elegida | n/a (ya respondida) |
| Channels (research preview) | permisos binarios | solo permisos; `AskUserQuestion` explícitamente excluido |
| Agent SDK `canUseTool` | todo | **todo** — incluye `answers` de AskUserQuestion; requiere ser el host |

Y contra nuestro código:

- `resolvePermission` (`claude-adapter.ts:344`) **solo limpia estado interno**
  del bridge. No responde el prompt de Claude Code. El usuario igual tiene que
  contestar en el terminal (por eso existe `focusTerminal`).
- La detección actual de permisos es indirecta: escaneo de JSONL + hook
  `Notification`. No trae `tool_input`.

## No-objetivos (YAGNI)

- **No responder `AskUserQuestion` desde el dashboard/robot**: no existe
  mecanismo oficial en modo monitor (CLI). Se difiere al modo host (Agent SDK).
  No se construye ningún workaround (inyección de texto, channels, etc.).
- **No migrar a Agent SDK en esta fase**: es un cambio de arquitectura
  (buildagotchi pasaría de observar sesiones a hospedarlas). Se deja la seam.
- **No auto-aprobar nada**: el bridge nunca decide solo. Toda respuesta
  programática viene de una acción física del usuario (head/botón/dashboard).
- **No eliminar el camino JSONL/Notification existente**: queda como fallback
  para sesiones sin el hook nuevo instalado.

## Diseño

### Parte 1 — Permisos reales vía hook `PermissionRequest`

**Flujo:**

1. Se agrega `PermissionRequest` a los hooks instalados por `cli.ts init
   --hooks`. El hook script hace `POST /permission-request` al bridge con el
   payload completo (`session_id`, `tool_name`, `tool_input`, `cwd`).
2. El bridge publica un evento `permission` (o `permission_critical`, según
   `criticalCommands`) **enriquecido**: `payload.toolName`, `payload.toolInput`
   (resumido, ver §Truncado). Dashboard y robot lo muestran.
3. El hook script **espera la decisión** (long-poll contra
   `GET /permission-request/:id/decision`, timeout configurable). El endpoint
   usa el mismo Bearer token del Keychain que el resto de la superficie
   externa (C4, council).
4. Si el usuario decide desde dashboard/head/botón dentro de la ventana →
   el hook imprime `{"hookSpecificOutput": {"hookEventName":
   "PermissionRequest", "decision": {"behavior": "allow"|"deny"}}}` y termina.
   **El prompt del terminal nunca aparece**: la decisión del robot es la real.
5. Si expira la ventana → el hook termina sin output → Claude Code muestra el
   prompt normal en el terminal. El bridge mantiene el evento pendiente y lo
   resuelve por los caminos actuales (`PostToolUse`/JSONL). Degradación
   gradual, cero riesgo.

**La tensión central (decisión de producto):** mientras el hook espera, el
prompt del terminal no se muestra. Ventana larga = el robot puede responder
pero el usuario sentado frente al terminal espera; ventana corta = terminal
fluido pero el robot no llega.

Opciones evaluadas:

- **(a) Ventana corta fija (3–5 s)** — el robot casi nunca llega a tiempo.
  Mata el propósito.
- **(b) Ventana larga fija (30–60 s)** — usuario en el terminal espera 30 s
  mirando nada. Inaceptable como default.
- **(c) Ventana configurable con default moderado (recomendada)** — default
  **10 s**: suficiente para girar la cabeza y tocar al robot que ya está
  sonando/iluminado, corto para no desesperar en el terminal. Config
  `claude.permissionRelayWindowSeconds` (0 = deshabilitado, hook responde
  vacío inmediato y todo queda como hoy). El `timeout` del hook en
  `settings.json` debe ser ventana + margen (p. ej. ventana 10 → timeout 15).

Nota: `trust-check` ya sabe si Claude Desktop está frontmost; una v2 podría
acortar la ventana cuando el usuario está mirando el terminal. **Diferido** —
primero medir si la ventana fija molesta.

**Comandos críticos:** el matching de `criticalCommands` hoy corre sobre texto
del JSONL. Con `tool_input` estructurado, corre sobre `tool_input.command`
(Bash) — más preciso. La regla existente se mantiene: crítico exige
**long-press** en el robot, no tap.

**Truncado (§):** `tool_input` puede ser enorme (un Write con 500 líneas). El
bridge guarda un resumen para display: `command` completo hasta 200 chars para
Bash; `file_path` para Edit/Write; nombre de tool + primeras claves para el
resto. El payload completo no viaja al bus ni al robot.

### Parte 2 — `AskUserQuestion` visible (read-only)

**Flujo:**

1. Se agrega `PreToolUse` con matcher `AskUserQuestion` a los hooks. El script
   hace `POST /hook` como los demás (fire-and-forget, no bloquea — no hay nada
   que esperar porque no se puede responder).
2. El adapter emite evento `question` con `payload.questions[]`: por pregunta,
   `question`, `header`, `options[].label` (descriptions truncadas a 80 chars).
   Severidad `medium` — es un "Claude te necesita", igual que un permiso no
   crítico.
3. **Dashboard**: panel de pregunta con las opciones listadas, marcado
   claramente "responde en el terminal". Botón único: "Ir al terminal" (llama
   al endpoint que ya usa `focusTerminal`).
4. **Robot**: balloon con la pregunta (`header` o primeras palabras) +
   decorator `?`. La página de screen no lista opciones (320×240 no da);
   muestra `¿? decision pending` + el header.
5. `PostToolUse` de `AskUserQuestion` trae `tool_response` con la respuesta
   elegida → el adapter emite `question_resolved` (con `resolvesEventId`) y el
   AM retira el balloon. El dashboard muestra la opción elegida en el
   historial.
6. `UserPromptSubmit`/`Stop` también auto-resuelven (mismo patrón
   `#autoResolvePending` de permisos) — si el usuario contestó o canceló, la
   pregunta no puede quedar pegada.

**Head/botón durante una pregunta pendiente:** un tap en la cabeza con
pregunta pendiente (y sin permiso pendiente) dispara `focusTerminal` hacia esa
sesión. El robot no puede elegir la opción, pero sí llevarte a donde se elige.

### Parte 3 — La seam para el modo host (Agent SDK)

Interfaz interna única para "decisión pendiente", agnóstica del origen:

```ts
interface PendingDecision {
  id: string;                   // = prompt_id del hook cuando existe
  sessionId: string;
  kind: 'permission' | 'question';
  summary: string;              // qué se muestra en el balloon
  detail: PermissionDetail | QuestionDetail;
  answerable: boolean;          // permission: true (si hay relay); question: false (hoy)
  respond?: (answer: DecisionAnswer) => void;  // presente solo si answerable
}
```

**Concurrencia (C1, council):** el modelo por sesión es una **lista** de
`PendingDecision`, no un slot único. `PermissionRequest` dispara por tool
call y los tool calls paralelos existen — dos hooks pueden estar bloqueando a
la vez contra el bridge. El `pendingPermission` singular actual del adapter
(`claude-adapter.ts:344-353`) se reemplaza por esta lista. La fase 0 verifica
empíricamente si Claude Code serializa los prompts de permiso; el modelo
soporta N pendientes aunque la respuesta sea "sí serializa". Head/botón
resuelven **la decisión más antigua** de la lista (FIFO), que es la que el
balloon muestra.

Dashboard y screen view consumen `PendingDecision` y pintan controles según
`answerable`. Cuando llegue el modo host, `canUseTool` produce
`PendingDecision` con `answerable: true` para todo y las vistas no cambian.
**Esta interfaz es el contrato; los hooks son un proveedor más.**

En DECISIONS.md se ancla la decisión de arquitectura: *modo monitor hoy, modo
host como destino* — el CoreS3 no será un espectador del terminal sino el
punto de control, y eso requiere que buildagotchi hospede las sesiones vía
Agent SDK en una fase futura (candidata: post-Fase 3).

## Riesgos

- **R-a: hooks con estado bloqueante.** Un hook que espera 10 s es nuevo en
  nuestro stack (todos los actuales son fire-and-forget con timeout 5).
  Mitigación: el script usa `curl --max-time` y sale limpio en cualquier
  error; sin output = comportamiento actual de Claude Code. Probar el camino
  de fallo primero.
- **R-b: `PermissionRequest` dispara por cada tool call no cubierta por
  allow-rules.** Volumen mucho mayor que `Notification`. El endpoint debe ser
  barato y el bridge debe deduplicar contra el camino JSONL para no contar
  permisos dobles en life-stats. **Regla de dedup (C2, council):** la
  correlación primaria es `prompt_id` (el payload de `PermissionRequest` lo
  trae; si el camino JSONL/Notification también lo expone, se matchea por id
  exacto). Donde el camino legacy no traiga `prompt_id`, regla explícita:
  *mientras exista un `PendingDecision` de tipo `permission` vivo para una
  sesión, el camino JSONL/Notification no crea eventos de permiso nuevos para
  esa sesión* — solo puede resolver los existentes.
- **R-c: docs vs realidad.** Los payloads de hooks citados vienen de la doc;
  hay que verificarlos empíricamente con un hook de logging antes de
  construir encima (fase 0 del plan de implementación).

## Criterios de aceptación

1. Con el relay habilitado, aprobar desde el dashboard un permiso de `Bash(ls)`
   hace que Claude Code ejecute la tool **sin mostrar prompt en el terminal**.
2. Con el relay deshabilitado (`permissionRelayWindowSeconds: 0`), el
   comportamiento es idéntico al actual (regresión cero).
3. Si la ventana expira, el prompt aparece en el terminal y responderlo ahí
   resuelve el evento en el bridge (sin permiso fantasma pegado).
4. Un `AskUserQuestion` en cualquier sesión muestra pregunta y opciones en el
   dashboard en <2 s, y el balloon del robot muestra el header.
5. Responder la pregunta en el terminal retira el balloon y el panel (vía
   `PostToolUse`), y el dashboard muestra qué opción se eligió.
6. Un permiso crítico vía relay sigue exigiendo long-press.
7. Life-stats no cuenta doble un permiso que entró por relay y se resolvió por
   relay.
8. Todos los eventos nuevos (`question`, `question_resolved`, permiso
   enriquecido) pasan por el bus y quedan en el recorder → replay funciona.
9. Con el bridge caído, el hook agrega < 500 ms de latencia al prompt del
   terminal (curl falla en conexión rechazada y sale limpio) (C3, council).
10. Dos permisos concurrentes en la misma sesión se muestran y resuelven
    independientemente (FIFO en head/botón; por id en dashboard), sin que el
    segundo pise al primero (C1, council).

## Deuda que este spec desbloquea (no se implementa aquí)

`PermissionRequest` trae el timestamp exacto del inicio de cada permiso — el
dato `pendingPromptAt` cuya ausencia difirió la **métrica de velocidad** de
life-stats a v2 (DEBT D-15, council de life-stats C3). Al implementar este
spec, D-15 pasa de "bloqueada por datos" a "implementable". PR separado
futuro; se anota en DEBT.
