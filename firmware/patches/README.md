# Parches al clon upstream `stack-chan/`

`stack-chan/` es un clon anidado del upstream (`github.com/stack-chan/stack-chan`),
ignorado por nuestro git. Los cambios que hacemos ahí para que el firmware host
compile como lo necesitamos **se pierden en un `git pull` del upstream**. Este
directorio guarda esos cambios como parches trackeados, que son la fuente de verdad.

## Aplicar tras un `git pull` de stack-chan

Desde la raíz del repo:

```bash
cd stack-chan
git apply ../firmware/patches/chunk-heap-512k.patch
```

Si el parche no aplica limpio (el upstream tocó las mismas líneas), reconciliar a
mano: el objetivo es que el bloque `platforms."esp32/m5stackchan_cores3".creation.chunk.initial`
en `firmware/stackchan/manifest.json` valga `524288`, no `262144`.

## Parches

- **chunk-heap-512k.patch** — sube el chunk-heap de XS de 256KB a 512KB para el
  target `esp32/m5stackchan_cores3`. Sin esto, el churn de chunk del render de la
  cara + los balloons marquee empuja los picos contra el techo fijo de 256KB y el
  device se reinicia solo (`Chunk allocation failed → rst:0xc`) cada ~3 min de
  uptime. Diagnóstico y verificación en `DEBT.md` (D-23). El GC recupera bien
  (sawtooth verificado por instrumentación), así que el margen extra es el fix real,
  no un parche que solo demora.
