# buildagotchi

A physical desktop companion for developers, built on the
[StackChan](https://github.com/stack-chan/stack-chan) platform (M5Stack CoreS3).
It reflects the state of your development environment — Claude Code sessions,
GitHub, browser errors, Jira, calendar — through expressive faces, servo
movement, LEDs and voice, and exposes an open MCP surface so any agent can push
notifications and drive the hardware.

> **Status: work in progress.** Nothing runs yet. This repository currently
> contains the architectural documentation while Phase 0 (hardware discovery)
> is pending. See [ROADMAP.md](ROADMAP.md) for the phased plan and validation
> gates.

## How it works

The hardware acts as the display; all the logic lives in a Node/TypeScript
**bridge** running as a background daemon on the host machine. Source adapters
(Claude Code, GitHub, Chrome CDP, Jira, Google/Atlassian Calendar, LLM
providers) emit normalized `Event` objects onto an event bus. An **Attention
Manager** arbitrates concurrent events by priority and TTL. A **Cognitive
Load** engine derives a 0–100 background mood score from current inputs, with
temporal decay. The bridge resolves everything into a single state
(`{emotion, decorators, LEDs, sound, servos}`) and pushes it to the firmware
over BLE (Nordic UART). The firmware is deliberately thin — it renders what it
is told and reports touch/button input back. The whole system is observable:
a Prometheus-style `/metrics` endpoint, an append-only event log with replay,
and a local dashboard.

## Planned capabilities

- **Claude Code monitoring** — session state, pending permissions, token usage,
  with physical approve/deny via head touch (long-press guard for destructive
  commands).
- **Work notifications** — GitHub PRs/CI, Jira tickets, upcoming meetings,
  directed left/right by category and filtered by the active mode
  (NORMAL / FOCUS / SLEEP).
- **Ambient cognitive load** — a background mood derived from open errors,
  pending reviews, and upcoming meetings, shown when no discrete event is
  active.
- **Voice assistant** — push-to-talk to Claude (multi-LLM planned), local
  STT/TTS candidates evaluated first.
- **Open event surface** — a `POST /events` HTTP endpoint and MCP tools
  (`notify`, `set_face`, `speak`, …) so external scripts, webhooks, and agents
  can drive the device without writing an adapter.
- **Local dashboard** — a web UI at `localhost:1780` showing current state,
  event history, adapter health, BLE link status, `/metrics` for scraping,
  and replay controls to re-run a past event log against the current state
  machine.

## Repository contents

| File | Purpose |
|---|---|
| [DECISIONS.md](DECISIONS.md) | Anchored architectural decisions (D1–D26) and risks (R1–R8). The source of truth. |
| [ROADMAP.md](ROADMAP.md) | Phased plan with validation gates between phases. |
| [SPEC-FASE-1.md](SPEC-FASE-1.md) | Implementation spec for Phase 1 (bridge foundation + BLE link), split into 1A (no hardware) / 1B (hardware). |
| [SETUP.md](SETUP.md) | Toolchain setup for ModdableSDK + ESP-IDF on macOS. |
| [NOTES.md](NOTES.md) | Template for recording Phase 0 discovery evidence. |
| [config.example.yaml](config.example.yaml) | Annotated template of the bridge configuration (mode, Attention Manager, dedup, stateRules, BLE, external surface). Copy to `config.yaml` (gitignored) to use. |

## Requirements

- macOS (Apple Silicon or Intel) — the bridge is designed to be portable, but
  macOS is the only supported target for now
- Node 20+
- ModdableSDK + ESP-IDF v5.x — see [SETUP.md](SETUP.md)
- M5Stack StackChan CoreS3 kit (K151)

## Reference repos (not vendored)

The `SETUP.md` and `SPEC-FASE-1.md` documents reference the following upstream
repositories. They are **cloned locally** by the developer (and gitignored in
this repo), not vendored or submoduled — they are studied and referenced, not
shipped as part of buildagotchi:

- <https://github.com/stack-chan/stack-chan> — Moddable firmware base for the
  device (target `m5stackchan_cores3`).
- <https://github.com/m5stack/StackChan> and
  <https://github.com/m5stack/StackChan-BSP> — board support and factory firmware.
- <https://github.com/anthropics/claude-desktop-buddy> — reference for the BLE
  protocol (Nordic UART + JSON line-delimited) that this project extends.

Clone them under the same parent directory as this repo if you want the paths
in the docs to line up.

## Forking and contributing

The project is developed for a single-user setup first, but the code is meant
to be read, forked, and adapted: permissive license, no obfuscation, secrets
kept out of the repository, and configuration in a documented
`config.example.yaml`. Issues and pull requests are welcome and reviewed on a
best-effort basis — there is no support SLA, no installers, and no
cross-platform test matrix at this stage.

## License

[Apache 2.0](LICENSE) © 2026 mahumadad
