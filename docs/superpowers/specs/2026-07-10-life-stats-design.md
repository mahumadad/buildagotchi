# Life stats — an honest mirror

**Fecha**: 2026-07-10
**Estado**: aprobado, pendiente de plan de implementación

## Objetivo

Darle "alma" al buildagotchi con estadísticas de encariñamiento que sobreviven
reinicios, **derivadas 100 % de hechos reales**. Inspirado en el sistema de vida
de `claude-desktop-buddy`, pero sin su ficción (energía que se drena, hambre,
niveles inventados). El repo tiene una postura firme —no mostrar números que no
se puedan defender— y este diseño la respeta: cada incremento corresponde a un
evento que de verdad ocurrió.

Sin dependencia de hardware. Todo corre en el bridge y se ve en el emulador hoy.

## No-objetivos (YAGNI)

- **Nada de mood continuo derivado**: la cara no afirma un estado emocional que
  sea una fórmula sobre contadores. Eso sería inventado.
- **Nada de energía/hambre/niveles ficticios**: no corresponden a nada medible.
- **Sin nombre de mascota / dueño editable**: no aporta a "espejo honesto".
- **Sin lectura del recorder para agregar**: se empujan hechos, no se re-lee el
  ndjson (que además solo guarda 30 días).

## Las cuatro métricas

Todas viven en `LifeStats`, persistidas a `~/.buildagotchi/life-stats.json`,
calcado del patrón de `TokenStats`.

| Métrica | Qué es | De dónde sale |
|---|---|---|
| `approvals` / `denials` | totales históricos | `resolve(reason)` en el AM |
| `fromHead` | aprobaciones desde head+button | el `source` de `resolve()` |
| `streak` | racha de días laborales usados | `markActive(now)` + `lastActiveDate` |
| `velocity` | media móvil de segundos prompt→response | `{sumMs, count}`, alimentado en cada `response` |

El `%` desde la cabeza se **deriva** (`fromHead / approvals`), no se guarda.
La media de velocidad se **deriva** (`sumMs / count`); se guardan suma y cuenta,
no cada muestra.

**Casos vacíos** (explícitos, no ambiguos): sin aprobaciones, `fromHeadPct = 0`
(no `NaN`); sin muestras de velocidad, `avgResponseSec = 0`. El snapshot nunca
emite `NaN`.

### La racha (`streak`)

`markActive(now)` compara `localDateString(now)` con `lastActiveDate`:

- Misma fecha → no cambia nada (ya cuenta hoy).
- Día **laboral** consecutivo (o el lunes tras un viernes activo) → `streak++`.
- Hueco de más de un día laboral → `streak = 1` (hoy).
- Fin de semana entre medias **no** rompe la racha: viernes activo → lunes activo
  cuenta como consecutivo.

`lastActiveDate` se persiste. El reloj se inyecta (`now()`), como en `TokenStats`
y `ContextPressureMonitor`, para poder testear el cruce de días sin esperar.

### La velocidad (`velocity`)

Cuando llega un `response`, el `ClaudeAdapter` ya conoce el timestamp del `prompt`
que responde (`pendingPromptEventId` y el timestamp guardado). Adjunta
`responseMs` al payload del evento `response`. `index.ts` lo pasa a
`LifeStats.addResponseTime(ms)`, que hace `sumMs += ms; count++`. La media es
`sumMs / count`. Muestras negativas (reloj hacia atrás) se descartan, como en
`state-machine.ts` con `latencyMs`.

## Flujo de datos

Los hechos se empujan donde el código ya pasa por ellos:

- **approvals / denials / fromHead**: en `index.ts`, en el callback `record` del
  `AttentionManager`, que ya recibe `{action:'resolved', reason, source}`. Un
  `resolved` → `lifeStats.recordResolution(reason, source)`.
- **velocity**: `index.ts` alimenta desde el bus, junto a los tokens, cuando el
  `response` trae `responseMs`.
- **streak**: `lifeStats.markActive(now)` en cualquier evento aceptado por el bus.
  Devuelve `{ crossedMilestone: boolean, streak: number }`.

### Alternativa descartada

Que `LifeStats` **lea** el ndjson del recorder y re-agregue en cada consulta.
Descartada: caro (30 días), frágil, y ya tenemos el patrón de empuje con
`TokenStats`. Además el recorder solo retiene 30 días; un contador persistido no.

## El único momento en la cara

`markActive` devuelve `crossedMilestone: true` cuando la racha **cruza** un umbral
(configurable, default 5 días laborales). En ese cruce, `index.ts` emite un evento
`life_milestone` (severidad `ambient`) con una `stateRule` de un solo flash
HAPPY + `heart`. **Disparado por flanco** —como `onLinkChange` y
`ContextPressureMonitor`—: celebra una vez al cruzar, no en cada evento del quinto
día. El hito es un hecho (la racha existe); la celebración es la única licencia.

`crossedMilestone` solo es `true` en el `markActive` que hace subir la racha al
umbral, y nunca más para ese mismo umbral hasta que la racha se reinicie y vuelva
a cruzarlo.

## Presentación (solo lector)

- **`/stats`** gana un campo `life` con el snapshot: `approvals`, `denials`,
  `fromHeadPct`, `streak`, `avgResponseSec`.
- **Vista stats del robot** (`screen.mjs`): una página nueva `LIFE` (la vista
  stats pasa de 2 a 3 páginas). No inyecta eventos, no cambia la cara.
- **Dashboard**: un panel `Life` que hace polling de `/stats`, como el de tokens.

## Testing

- `test/life-stats.test.ts`: persistencia, la racha a través de días con reloj
  inyectable (consecutivo, hueco, fin de semana), la media móvil, el descarte de
  muestras negativas, y **el flanco del hito** (cruza una vez, no re-dispara).
  Muteado: quitar el reset de racha, sumar en vez de promediar velocidad, y
  hacer que el hito dispare siempre deben romper un test cada uno.
- `test/dashboard-screen.test.ts`: la página `LIFE` renderiza los campos y
  respeta el guard de "nunca ocultar la escena 3D".
- El decorator `heart` del hito ya está cubierto por `config-decorators.test.ts`
  (guard de "todo decorator del config lo sabe dibujar el renderer").

## Archivos

Nuevos: `bridge/src/core/life-stats.ts`, `bridge/test/life-stats.test.ts`.
Modificados: `bridge/src/adapters/claude-adapter.ts` (adjuntar `responseMs`),
`bridge/src/index.ts` (cablear `LifeStats` + emitir `life_milestone`),
`bridge/src/server/server.ts` (`/stats` gana `life`),
`bridge/src/server/public/screen.mjs` + `dashboard.js` + `dashboard.css` (vista y
panel), `config.yaml` + `config.example.yaml` (regla `life_milestone` y el umbral
de racha).

## Riesgo conocido

La lógica de racha con fines de semana y feriados es la parte con más superficie
de bug. Feriados **no** se manejan (un feriado entre semana rompe la racha); es
aceptable para v1 y se anota, no se resuelve. El reloj inyectable hace la lógica
testeable sin esperar días reales.
