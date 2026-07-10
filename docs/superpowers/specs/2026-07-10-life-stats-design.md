# Life stats — an honest mirror

**Fecha**: 2026-07-10
**Estado**: aprobado (rev 2 — post-council), pendiente de plan de implementación

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

## Las tres métricas (rev 2)

Todas viven en `LifeStats`, persistidas a `~/.buildagotchi/life-stats.json`,
calcado del patrón de `TokenStats`.

| Métrica | Qué es | De dónde sale |
|---|---|---|
| `approvals` / `denials` | totales históricos | evento `permission_resolved` del bus (ver §Conducto) |
| `fromHead` | aprobaciones desde head+button | `source` del `resolve()` directo o `action` del evento |
| `streak` | racha de días laborales usados | `markActive(now)` + `lastActiveDate` |

**Velocidad diferida a v2.** El council (C3) demostró que `prompt→Stop` incluye
la espera humana en permisos (escenario: permiso nocturno → muestra de horas que
sesga el histórico para siempre), y `{sumMs,count}` acumulado de por vida no es
"media móvil" — deja de moverse con volumen. Para ser honesta necesita: (a)
descartar turnos con permiso pendiente en medio, y (b) una ventana deslizante o
exponencial, no un acumulado. Ambas requieren datos que hoy el adapter no tiene
(`pendingPromptAt`, detección de permiso intercalado). Se implementa cuando esos
datos existan, no antes.

El `%` desde la cabeza se **deriva** (`fromHead / approvals`), no se guarda.

**Casos vacíos** (explícitos, no ambiguos): sin aprobaciones, `fromHeadPct = 0`
(no `NaN`). El snapshot nunca emite `NaN`.

### Conducto de approvals/denials (C1 fix)

El AM hardcodea `'dismissed'` para eventos retirados por `resolvesEventId`
(`attention.ts:131-132`). Por tanto, **no se puede usar el callback `record` del
AM** para contar aprobaciones externas — todas aparecerían como `dismissed`.

La fuente real son dos caminos:

1. **Dashboard** (`server.ts`): llama `attentionManager.resolve(eventId, action,
   source)` directamente con el `action` correcto (`'approved'`/`'denied'`). El
   server llama `lifeStats.recordResolution(action, source)` en el mismo sitio.
2. **Externo** (hook path): `#autoResolvePending` emite un evento
   `permission_resolved` con `action: 'approved'|'external'|'abandoned'` en su
   payload. `index.ts` lo consume desde el bus filtrando
   `category === 'permission_resolved'` y delega a `lifeStats`.

Reglas de conteo (C8):
- `action === 'approved'` → `approvals++`, y si `source ∈ {head, button}` →
  `fromHead++`.
- `action === 'denied'` → `denials++`.
- `action === 'dismissed'`, `'external'` (sin acción clara), `'abandoned'` →
  **no cuentan**. Son retiros administrativos, no decisiones del usuario.

### Hechos sintéticos (C2 fix)

`LifeStats` recibe un flag `enabled` en el constructor. `index.ts` lo pasa como
`!options.demo`. Cuando `enabled === false`, todas las mutaciones (`recordResolution`,
`markActive`) son no-ops silenciosos y el JSON no se toca.

Para **replay** (`POST /replay`): los eventos replayados pasan por el bus con
normalidad, pero `index.ts` no re-alimenta `LifeStats` desde ellos. El camino
de replay es: bus → AM → state machine (para ver la animación), y eso no toca
`LifeStats` porque `LifeStats` no está suscrito al bus directamente — recibe
llamadas explícitas desde `index.ts` en los puntos de verdad (dashboard resolve,
bus `permission_resolved`, bus `onAccepted` para markActive). El replay usa
`bus.publish` que llega a `onAccepted`, así que hay que filtrar: `onAccepted`
solo llama `markActive` si `e.source !== 'replay'`. Hoy no hay source 'replay';
si se añade, es trivial. Si no, un flag `replaying` en el server basta.

Criterio de aceptación medible: con `--demo` corriendo N ciclos,
`life-stats.json` no cambia. Con replay de un ndjson, `life-stats.json` no
cambia.

### La racha (`streak`) — con tabla de transiciones (C4 fix)

`markActive(now)` compara `localDateString(now)` con `lastActiveDate`:

| Último día activo | Hoy | Resultado |
|---|---|---|
| Misma fecha | — | No cambia (ya cuenta hoy) |
| Viernes | Lunes | `streak++` (fin de semana no rompe) |
| Viernes | Sábado | `streak` no cambia, `lastActiveDate` = sábado |
| Sábado | Domingo | `streak` no cambia, `lastActiveDate` = domingo |
| Sábado/Domingo | Lunes | `streak++` (el finde fue puente al lunes) |
| Cualquier laboral | Siguiente laboral | `streak++` |
| Cualquier día | Hueco > 1 laboral | `streak = 1` (hoy) |

**Regla general**: la racha solo **incrementa** en transiciones a día laboral
(lun-vie). Actividad en fin de semana **actualiza `lastActiveDate`** (para no
romper el puente) pero no incrementa ni rompe la racha.

`isWorkday(date)` es una función pura: `getDay() ∈ {1,2,3,4,5}`.
`workdayGap(from, to)` cuenta cuántos días laborales hay entre dos fechas
(exclusivo ambos). Si `gap === 0` → consecutivo, `streak++`. Si `gap > 0` →
hueco, `streak = 1`.

Estas dos funciones se extraen como helpers puros y testables, no incrustados en
`markActive`.

`lastActiveDate` se persiste. El reloj se inyecta (`now()`), como en `TokenStats`
y `ContextPressureMonitor`, para poder testear el cruce de días sin esperar.

## Flujo de datos

Los hechos se empujan donde el código ya pasa por ellos:

- **approvals / denials / fromHead** (ver §Conducto arriba):
  - Dashboard: `server.ts` llama `lifeStats.recordResolution(action, source)`
    justo después de `attentionManager.resolve(...)`.
  - Externo: `index.ts` filtra `permission_resolved` en `onAccepted` y delega.
- **streak**: `lifeStats.markActive(now)` en cualquier evento aceptado por el bus
  cuyo `source === 'claude'` (excluye demo y replay).
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
  `fromHeadPct`, `streak`.
- **Vista stats del robot** (`screen.mjs`): una página nueva `LIFE` (la vista
  stats pasa de 2 a 3 páginas). No inyecta eventos, no cambia la cara.
- **Dashboard**: un panel `Life` que hace polling de `/stats`, como el de tokens.

## Testing

- `test/life-stats.test.ts`: persistencia, la racha a través de días con reloj
  inyectable (cada fila de la tabla de transiciones es un test), y **el flanco
  del hito** (cruza una vez, no re-dispara). Muteado: quitar el reset de racha y
  hacer que el hito dispare siempre deben romper un test cada uno.
  Tests adicionales por C1/C2: `recordResolution('dismissed', ...)` no cambia
  contadores; con `enabled=false` nada se persiste.
- `test/life-stats-helpers.test.ts`: `isWorkday` y `workdayGap` como funciones
  puras — cada combinación de la tabla de transiciones.
- `test/dashboard-screen.test.ts`: la página `LIFE` renderiza los campos y
  respeta el guard de "nunca ocultar la escena 3D".
- El decorator `heart` del hito ya está cubierto por `config-decorators.test.ts`
  (guard de "todo decorator del config lo sabe dibujar el renderer").

## Archivos

Nuevos: `bridge/src/core/life-stats.ts`, `bridge/test/life-stats.test.ts`,
`bridge/test/life-stats-helpers.test.ts`.
Modificados: `bridge/src/index.ts` (cablear `LifeStats` + emitir
`life_milestone` + filtrar demo/replay), `bridge/src/server/server.ts`
(`/stats` gana `life` + llamar `recordResolution` en dashboard resolve),
`bridge/src/core/screen-view.ts` (**C5**: `PAGES.stats` pasa de 2 a 3),
`bridge/src/server/public/screen.mjs` + `dashboard.js` + `dashboard.css` (vista y
panel), `config.yaml` + `config.example.yaml` (regla `life_milestone` y el umbral
de racha).

## Riesgo conocido

Feriados **no** se manejan (un feriado entre semana rompe la racha); es
aceptable para v1. El helper `isWorkday`/`workdayGap` está extraído como función
pura justamente para que añadir feriados sea un cambio local. El reloj inyectable
hace la lógica testeable sin esperar días reales.

## Hallazgos del council (rev 2)

Revisión adversarial por Fable el 2026-07-10. Hallazgos resueltos:

- **C1** (bloqueante): conducto de approvals sesgado → §Conducto reescrito, dos
  caminos explícitos, `dismissed` excluido (C8).
- **C2** (bloqueante): hechos sintéticos → flag `enabled`, criterio medible.
- **C3** (importante): velocidad incluye esperas y no es móvil → diferida a v2.
- **C4** (importante): actividad en finde no definida → tabla de transiciones.
- **C5** (importante): faltaba `screen-view.ts` → agregado a archivos.
- **C6** (menor): faltaba `pendingPromptAt` → no aplica (velocidad diferida).
- **C7** (menor): cita incorrecta clamp vs descarte → no aplica (velocidad diferida).
- **C8** (menor): excluir `dismissed` → reglas de conteo en §Conducto.
