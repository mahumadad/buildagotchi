# buildagotchi

A physical desktop companion for developers, built on the
[StackChan](https://github.com/stack-chan/stack-chan) platform (M5Stack CoreS3).
It reflects the state of your development environment — Claude Code sessions,
GitHub, browser errors, Jira, calendar — through expressive faces, servo
movement, LEDs and voice, and exposes an open MCP surface so any agent can push
notifications and drive the hardware.

> **Status: the bridge runs; the robot has not arrived.**
>
> The CoreS3 kit is still in the post, so Phase 0 (hardware discovery) and
> Phase 1B (real BLE) are blocked. Everything else was built anyway, against a
> **full web emulator** — see [Running without the hardware](#running-without-the-hardware).
>
> | | |
> |---|---|
> | **Done** | Phase 1A (bridge foundation), Phase 2 (Claude Code MVP), Phase 2.5 (server-authoritative display + observability), Life Stats |
> | **Runs today** | `npm run dev` in `bridge/` → web emulator at `localhost:1780` with 3D robot, live sessions, dashboard, and event replay |
> | **505 tests** | `npm test` in `bridge/`. Green. |
> | **Not built** | BLE transport (stub), Metabolic State (Phase 4), voice (Phase 5), Chrome/Jira/GitHub/Calendar adapters (Phases 3, 6) |
>
> [ROADMAP.md](ROADMAP.md) has the phased plan and the validation gates.
> [DEVLOG.md](DEVLOG.md) has what actually happened, including the bugs.

## How it works

The hardware acts as the display; all the logic lives in a Node/TypeScript
**bridge** running as a background daemon on the host machine. Source adapters
(Claude Code today; GitHub, Chrome CDP, Jira, Calendar, LLM providers planned)
emit normalized `Event` objects onto an event bus. An **Attention Manager**
arbitrates concurrent events by priority and TTL. A **Metabolic State** engine
will derive a 0–100 background mood score from current inputs with temporal
decay (Phase 4; the seam is in place, the engine is not).

The bridge resolves everything into a single state
(`{emotion, decorators, LEDs, sound, servos, balloon}`) and pushes it to the
firmware over BLE (Nordic UART). **The firmware decides nothing.** It renders
what it is told and reports touch and button input back. That constraint is
load-bearing: it is why display policy lives on the server
([S2.5.1](DECISIONS.md)), and why the same `ResolvedState` drives both the robot
and the emulator.

The whole system is observable: a Prometheus-style `/metrics` endpoint, an
append-only event log with replay, and a local dashboard.

> The BLE transport is currently a stub that logs what it would have sent.
> Everything upstream of it is real.

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

## The emulator

The entire project was developed without the physical robot. The bridge ships
with a **web-based emulator** at `localhost:1780` that renders exactly what the
firmware would — a 3D StackChan model with expressive faces, servo movement,
LEDs, speech balloons, and sound. It connects to your **real Claude Code
sessions** via hooks in `~/.claude/settings.json`, so what you see in the
browser is what the robot will do when it arrives.

The emulator dashboard shows:

- **3D robot viewport** — the face, emotions, decorators, and servo pan/tilt,
  rendered with Three.js in the same 320x240 frame the firmware draws.
- **Claude sessions panel** — every active Claude Code session on your machine,
  with status, context usage, last message, and permission simulation buttons.
- **Simulation controls** — cycle modes (NORMAL/FOCUS/SLEEP), fake permission
  prompts, trigger emotions, replay past event logs.
- **Stats pages** — token usage, session counts, and **life stats** (approvals,
  from-head percentage, workday streak) that persist across restarts.
- **Screen history** — a scrolling log of everything the robot's balloon has
  displayed.
- **Health and attention** — adapter health, current attention priority, event
  queue depth.

This is not a mock. The emulator runs the real bridge — the real adapters,
event bus, Attention Manager, state machine, and personality engine — with only
the BLE transport swapped for a stub.

## Running without the hardware

The CoreS3 kit was ordered before a line of code was written, and it still
hasn't arrived. Waiting for it would have cost weeks. Instead the bridge got a
simulator on day one ([D11](DECISIONS.md)), and three phases were built,
reviewed and debugged against it.

```bash
cd bridge
npm install
cp ../config.example.yaml ../config.yaml          # config.yaml is gitignored (D25)

npx tsx src/cli.ts init --hooks                   # Keychain token + Claude Code hooks
npm run dev                                       # starts with --simulate
# open http://localhost:1780
```

`init --hooks` is what wires the thing to your real Claude Code sessions: it
mints an API token into the macOS Keychain and installs the hook script into
`~/.claude/settings.json`. Skip it and the emulator still runs — you just drive
it with the `/sim/*` endpoints instead of with your actual work.

The web emulator renders the `ResolvedState` the firmware would have received:

- **The robot's face**, in a 3D viewport: emotions, decorators, servo pan/tilt.
- **The 320×240 LCD**, including the speech balloon, wrapped and truncated the
  way the firmware will do it.
- **The six LEDs**, with the firmware's real patterns (`solid`, `blink`,
  `rainbow`, `off`) and nothing else.
- **The sounds**, through Web Audio.
- **The physical controls** — head touch, buttons A/B/C, servo sliders — posted
  back to the bridge as if a hand had touched the robot.

It runs against **live Claude Code sessions**. The hooks in
`~/.claude/settings.json` are the same ones the real device will use, so a
permission prompt in your terminal lights an amber LED in the browser, and
approving it from the chat clears it. There is nothing to fake.

Beyond the emulator, three things make working blind survivable:

- **`POST /events`** — push any event with `curl` (Bearer token from
  `init`). An adapter that doesn't exist yet can be prototyped as a shell
  one-liner before anyone writes it.
- **`POST /replay`** — re-run a recorded day of events through the current state
  machine. Yesterday's bug, reproduced on demand.
- **The `/sim/*` endpoints** — fake a permission prompt, cycle the mode, force
  an emotion, press a button.

### The emulator is not the firmware

It is a stand-in, and a stand-in that lies is worse than none. Two divergences
shipped and had to be hunted down: `rainbow` was painted as a plain solid LED,
and `pattern: 'off'` lit the LED instead of leaving it dark. Both were caught by
asking "would the robot do this?", not by a test.

So: the emulator's capabilities are pinned to the firmware's. `pulse` was
removed from the schema the day we read
`stack-chan/firmware/stackchan/led/led.ts` and found it wasn't there. Anything
the emulator can do that the robot cannot is a bug filed in [DEBT.md](DEBT.md).

And some things a simulator structurally cannot answer — BLE latency under load,
whether the ESP32-S3 keeps up with audio and servos at once, whether the speech
balloon is legible at arm's length. Those are Phase 0, and they are why Phase 0
still exists in the [ROADMAP](ROADMAP.md) instead of being quietly skipped.

## Repository contents

| File | Purpose |
|---|---|
| [DECISIONS.md](DECISIONS.md) | Anchored architectural decisions (D1–D28, A1, S2.5.1–S2.5.16) and risks (R1–R8). The source of truth. |
| [ROADMAP.md](ROADMAP.md) | Phased plan with validation gates between phases. |
| [DEVLOG.md](DEVLOG.md) | Chronological log of what was built, what was verified, and what broke. The ROADMAP has the plan; this has the reality. |
| [DEBT.md](DEBT.md) | Known technical debt: where it is, why it hasn't exploded yet, what would make it explode, and what the fix costs. |
| [SPEC-FASE-1.md](SPEC-FASE-1.md) | Spec for Phase 1 (bridge foundation + BLE link), split into 1A (no hardware) / 1B (hardware). |
| [SPEC-IMPL-FASE-1A.md](SPEC-IMPL-FASE-1A.md) | Executable plan for Phase 1A (M0–M5): contracts, test matrices, TDD order, done criteria. |
| [SPEC-FASE-2.md](SPEC-FASE-2.md) | Spec for Phase 2 (ClaudeAdapter, dashboard, MCP server, personality presets). |
| [SPEC-IMPL-FASE-2.md](SPEC-IMPL-FASE-2.md) | Executable plan for Phase 2 (M6–M11). |
| [SPEC-FASE-2.5.md](SPEC-FASE-2.5.md) | Spec for Phase 2.5 (server-authoritative balloon + observability). Explains why the dashboard can't own display policy. |
| [SPEC-IMPL-FASE-2.5.md](SPEC-IMPL-FASE-2.5.md) | Executable plan for Phase 2.5 (M12a–M17), post-council revision 2. |
| [docs/superpowers/specs/2026-07-10-life-stats-design.md](docs/superpowers/specs/2026-07-10-life-stats-design.md) | Life stats spec — three fact-based metrics (approvals, fromHead%, streak), council-reviewed. |
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

## External references (not cloned)

Projects in the Claude Code ecosystem that solve adjacent problems. Audited for
patterns and ideas — nothing is vendored or depended on, but they inform
architectural decisions (D19 Claude detection strategy, A1 TTS choice) pending
a deeper review before Phase 2:

| Project | What we learned |
|---|---|
| [Clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter) | Proven daemon → BLE → ESP32 pattern, Keychain OAuth access, Anthropic API usage polling. |
| [ComandOS](https://github.com/0xAI-Builders/comandos) | Claude Code native hooks (`UserPromptSubmit`/`Stop`/`Notification`/`SessionEnd`), Piper TTS offline (`es_MX`). |
| [ccboard](https://github.com/florianbruniaux/ccboard) | Hook injection into `settings.json`, file watcher with debounce, session state mapping. |
| [claude-session-dashboard](https://github.com/dlupiak/claude-session-dashboard) | JSONL parsing of `~/.claude/projects/` for token metrics and session metadata. |
| [claude-code-dashboard](https://github.com/ek33450505/claude-code-dashboard) | chokidar fs watcher + SSE transport + SQLite for session persistence. |
| [claude-push](https://github.com/coa00/claude-push) | Minimal `PermissionRequest` hook → push notification via ntfy.sh. |
| [claude-dashboard](https://github.com/uppinote20/claude-dashboard) | API response caching (60s TTL), token usage tracking. |
| [stackchan-codex-bridge](https://github.com/chuankris/stackchan-codex-bridge) | Mac daemon + Node.js/TS + MCP + WebSocket to StackChan — closest analog to our bridge architecture. |
| [stackchan-xiaozhi-firmware](https://github.com/heavenchenggong/stackchan-xiaozhi-firmware) | ESP-IDF CoreS3 firmware exposing servos as MCP tools + on-device wake-word (Multinet6). |
| [kisaragi-mochi/stackchan-mcp](https://github.com/kisaragi-mochi/stackchan-mcp) | Python ↔ ESP-IDF MCP bridge with rich tools (servos, camera, LEDs, TTS/STT). |
| [stackchan-display](https://github.com/botamochi6277/stackchan-display) | Face rendering with `ExpressionWeight` — smooth morphing between emotions. Reference for Metabolic State visuals. |
| [stackchan-playground](https://github.com/Ryota-Nakamura-317/stackchan-playground) | M5Stack CoreS3 experiments with a Claude Code notifier (AquesTalk TTS). |
| [AI_StackChan_Ex](https://github.com/ronron-gh/AI_StackChan_Ex) | Local LLM via Module LLM Realtime API + modular app framework. Reference for offline mode. |
| [jarvis](https://github.com/owen4sure/jarvis) | Full stack (agent orchestration + multi-channel memory + MLX Whisper). Broad reference. |

## Forking and contributing

The project is developed for a single-user setup first, but the code is meant
to be read, forked, and adapted: permissive license, no obfuscation, secrets
kept out of the repository, and configuration in a documented
`config.example.yaml`. Issues and pull requests are welcome and reviewed on a
best-effort basis — there is no support SLA, no installers, and no
cross-platform test matrix at this stage.

## License

[Apache 2.0](LICENSE) © 2026 mahumadad
