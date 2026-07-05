# buildagotchi

Physical desktop buddy for developers. A [StackChan](https://github.com/stack-chan/stack-chan)
kit (M5Stack CoreS3) that reflects the state of your work — Claude Code sessions,
GitHub, Chrome errors, Jira, calendar — through expressive faces, servos, LEDs
and voice. Plus a multi-LLM voice assistant, ambient cognitive load monitor,
and an open MCP surface so any agent can push notifications and drive the
hardware.

> **Status: work in progress.** Nothing runs yet. This repo currently contains
> only the architectural documents while the hardware kit ships and Phase 0
> (discovery) hasn't started. See [ROADMAP.md](ROADMAP.md) for phase gates.

## What's here

| File | Purpose |
|---|---|
| [DECISIONS.md](DECISIONS.md) | Anchored architectural decisions (D1–D26) + risks (R1–R8). The source of truth. |
| [ROADMAP.md](ROADMAP.md) | Phased plan with validation gates between phases. |
| [SETUP.md](SETUP.md) | Toolchain setup for ModdableSDK + ESP-IDF on macOS. |
| [NOTES.md](NOTES.md) | Empty template for recording Phase 0 evidence. |

## The concept in one paragraph

The hardware is the "display"; everything smart lives in a Node/TypeScript
**bridge** running as a launchd daemon on macOS. Adapters (Claude Code, GitHub,
Chrome CDP, Jira, Google/Atlassian Calendar, LLMs) emit normalized `Event`
objects to a bus. An **Attention Manager** arbitrates concurrent events by
priority/TTL. A **Cognitive Load** engine derives a 0–100 background mood
score from the current inputs, with temporal decay. The bridge resolves all
of it into a single state (`{emotion, decorator, LEDs, sound, servos}`) and
pushes it to the firmware over BLE (Nordic UART). The firmware is
deliberately dumb — it renders what it's told and reports touch/button events
back. Everything is observable (`/metrics`, Event Recorder ndjson log,
dashboard on `localhost`).

## Why open the repo

Not a product. There is no support, no installers, no cross-platform testing.
It's a personal buddy. But the code is open under Apache 2.0 so anyone
curious can read it, fork it, and adapt it to their own setup. See
[D25 in DECISIONS.md](DECISIONS.md) for the full stance.

## Requirements (when there's code to run)

- macOS (Apple Silicon or Intel)
- Node 20+
- ModdableSDK + ESP-IDF v5.x — see [SETUP.md](SETUP.md)
- M5Stack StackChan CoreS3 kit (K151)

## License

[Apache 2.0](LICENSE) © 2026 mahumadad
