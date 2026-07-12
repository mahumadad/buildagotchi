import { formatTokens, renderScreenView } from '/screen.mjs';

import { FaceRenderer } from './face-renderer.js';
import { SoundEngine } from './sound-engine.js';
import { StackchanScene } from './stackchan-scene.mjs';

const EMOTION_EMOJI = {
  NEUTRAL: '😐',
  HAPPY: '😊',
  SAD: '😢',
  ANGRY: '😠',
  SLEEPY: '😴',
  DOUBTFUL: '🤔',
  COLD: '🥶',
  HOT: '🥵',
};

const faceCanvas = document.getElementById('face-canvas');
const faceRenderer = new FaceRenderer(faceCanvas);
faceRenderer.start();

const viewport3d = document.getElementById('viewport-3d');
let scene3d = null;
let currentMode = 'NORMAL';
let lastEventAt = 0;
let manualServoUntil = 0;
if (viewport3d) {
  scene3d = new StackchanScene({ viewport: viewport3d, screen: faceCanvas });
  function animate3d(timeMs) {
    autoServo(timeMs);
    scene3d.render(timeMs);
    requestAnimationFrame(animate3d);
  }
  requestAnimationFrame(animate3d);
}

const sound = new SoundEngine();
const volumeSlider = document.getElementById('volume-slider');
const muteBtn = document.getElementById('mute-btn');
if (volumeSlider) {
  volumeSlider.addEventListener('input', () => {
    sound.volume = volumeSlider.value / 100;
  });
}
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    sound.muted = !sound.muted;
    muteBtn.textContent = sound.muted ? '🔇' : '🔊';
  });
}

const stateModeEl = document.getElementById('state-mode');
const attentionModeBadgeEl = document.getElementById('attention-mode-badge');
const attentionModeLegendEl = document.getElementById('attention-mode-legend');
const attentionActiveEl = document.getElementById('attention-active');
const attentionQueueHeaderEl = document.getElementById('attention-queue-header');
const attentionQueueEl = document.getElementById('attention-queue');
const connStatusEl = document.getElementById('conn-status');
const healthAdaptersEl = document.getElementById('health-adapters');
const healthTransportEl = document.getElementById('health-transport-status');
const sessionsListEl = document.getElementById('sessions-list');
const eventsListEl = document.getElementById('events-list');

const LED_COLORS = {
  amber: '#f59e0b',
  red: '#ef4444',
  green: '#22c55e',
  blue: '#3b82f6',
  white: '#e5e5e5',
  yellow: '#eab308',
};

const LED_ROWS_PER_SIDE = 3;
const ledsLeftEl = document.getElementById('leds-left');
const ledsRightEl = document.getElementById('leds-right');

function ensureLedRow(container) {
  if (container.children.length === LED_ROWS_PER_SIDE) return;
  container.innerHTML = '';
  for (let i = 0; i < LED_ROWS_PER_SIDE; i++) {
    const led = document.createElement('div');
    led.className = 'led';
    container.appendChild(led);
  }
}

function renderLeds(leds) {
  ensureLedRow(ledsLeftEl);
  ensureLedRow(ledsRightEl);
  for (const el of [...ledsLeftEl.children, ...ledsRightEl.children]) {
    el.className = 'led';
    el.style.color = '';
    el.style.background = '';
  }
  for (const led of leds ?? []) {
    const container = led.row === 'left' ? ledsLeftEl : ledsRightEl;
    const idx = typeof led.index === 'number' ? led.index : 0;
    const el = container.children[idx];
    if (!el) continue;
    // D-04: `off` is a legal pattern in the schema because the firmware has it.
    // Lighting the LED for it would make the emulator disagree with the robot,
    // which is the divergence S2.5.1 exists to prevent. Leave it dark.
    if (led.pattern === 'off') continue;
    const color = LED_COLORS[led.color] ?? led.color ?? '#e5e5e5';
    el.classList.add('on');
    if (led.pattern && led.pattern !== 'solid') el.classList.add(led.pattern);
    el.style.color = color;
    el.style.background = color;
  }
}

let currentSessions = {};

// M12b: The client no longer decides balloon lifespan. The server owns it
// (SPEC-FASE-2.5 S2.5.1) and the AttentionManager already provides TTL.
// This wrapper only exists as an integration point for other client-side
// affordances (transient toast-style feedback) — none in scope for M12b.
// See M15 for the persistent Screen history that replaces the old timers.

function sessionProject(session) {
  return session.cwd.split('/').filter(Boolean).pop() ?? '?';
}

function sessionName(session) {
  if (session.desktopTitle) return truncate(session.desktopTitle, 30);
  if (session.slug) return session.slug;
  if (session.lastPrompt) return truncate(session.lastPrompt, 30);
  if (session.title) return truncate(session.title, 30);
  return null;
}

function sessionLabel(session) {
  const project = sessionProject(session);
  const name = sessionName(session);
  if (name) return `${project}/${name}`;
  return project;
}

function firstPendingSession() {
  for (const [id, s] of Object.entries(currentSessions)) {
    if (s.pendingPermission) return { id, session: s };
  }
  return null;
}

function updateButtonStates() {
  const pending = firstPendingSession();
  const btnA = document.querySelector('[data-btn="A"]');
  const btnB = document.querySelector('[data-btn="B"]');
  if (btnA) {
    btnA.classList.toggle('has-action', !!pending);
    btnA.title = pending ? 'Approve pending permission' : 'Button A';
  }
  if (btnB) {
    btnB.classList.toggle('has-action', !!pending);
    btnB.title = pending ? 'Deny pending permission' : 'Button B';
  }
}

let lastSound = null;
function renderState(state) {
  void refreshScreenView(state.screen);
  if (state.resolvedState) {
    const rs = state.resolvedState;
    if (rs.emotion) faceRenderer.setEmotion(rs.emotion);
    if (rs.decorators) faceRenderer.setDecorators(rs.decorators);
    // M12b: the server is now authoritative for the balloon (S2.5.1). rs.balloon
    // is always a string under the new contract (S2.5.11): '' means clear.
    faceRenderer.setBalloon(rs.balloon || null);
    renderLeds(rs.leds);
    if (scene3d) {
      // Server-driven servo only wins when the client isn't auto-driving (pending / breathing).
      // Otherwise autoServo fights it every frame and the head appears frozen.
      if (rs.servo && !firstPendingSession() && Date.now() < manualServoUntil)
        scene3d.applyServo(rs.servo);
      scene3d.applyLeds(rs.leds);
    }
    if (rs.sound && rs.sound !== lastSound) sound.play(rs.sound);
    lastSound = rs.sound ?? null;
    // M15: pull the history whenever the balloon effectively changed.
    if (typeof rs.balloon === 'string' && rs.balloon !== lastKnownBalloon) {
      lastKnownBalloon = rs.balloon;
      refreshBalloonHistory();
    }
  }
  // Feature B: the micro-expression runs only while the AM has no active
  // event. `state.active === null` is the server's authoritative idle signal.
  faceRenderer.setIdle(state.active == null);
  if (state.mode) {
    stateModeEl.textContent = state.mode;
    currentMode = state.mode;
  }
  renderAttention(state);
}

// M14: the Attention panel is a passive render of the server's `#statePayload`.
// The dashboard NEVER mutates the queue — it only shows what the AM decided.
const MODE_LEGEND = {
  NORMAL: 'todo pasa',
  FOCUS: 'solo critical + high',
  SLEEP: 'solo critical',
};

const currentAttention = { active: null, queue: [] };

function renderAttention(state) {
  if (state.mode && attentionModeBadgeEl) {
    attentionModeBadgeEl.textContent = state.mode;
    attentionModeBadgeEl.dataset.mode = state.mode;
    if (attentionModeLegendEl) attentionModeLegendEl.textContent = MODE_LEGEND[state.mode] ?? '';
  }
  if ('active' in state) currentAttention.active = state.active ?? null;
  if ('queue' in state) currentAttention.queue = state.queue ?? [];
  paintAttention();
}

function paintAttention() {
  if (!attentionActiveEl) return;
  const { active, queue } = currentAttention;
  attentionActiveEl.innerHTML = '';
  if (active?.event) {
    const ev = active.event;
    attentionActiveEl.dataset.severity = ev.severity ?? 'ambient';
    const sev = document.createElement('span');
    sev.className = 'attention-severity';
    sev.textContent = ev.severity ?? 'ambient';
    const label = document.createElement('span');
    label.className = 'attention-label';
    label.textContent = `${ev.source ?? ''} · ${ev.category ?? ''}`.trim();
    const ttl = document.createElement('span');
    ttl.className = 'attention-ttl';
    ttl.textContent = formatTtl(active.deadline);
    attentionActiveEl.appendChild(sev);
    attentionActiveEl.appendChild(label);
    attentionActiveEl.appendChild(ttl);
  } else {
    delete attentionActiveEl.dataset.severity;
    const empty = document.createElement('span');
    empty.className = 'attention-empty';
    empty.textContent = 'nothing active';
    attentionActiveEl.appendChild(empty);
  }

  if (attentionQueueHeaderEl) {
    attentionQueueHeaderEl.textContent = `Queue (${queue.length})`;
  }
  if (attentionQueueEl) {
    attentionQueueEl.innerHTML = '';
    for (const ev of queue) {
      const li = document.createElement('li');
      li.className = 'attention-queue-item';
      li.dataset.severity = ev.severity ?? 'ambient';
      const sev = document.createElement('span');
      sev.className = 'attention-severity';
      sev.textContent = ev.severity ?? 'ambient';
      const label = document.createElement('span');
      label.className = 'attention-label';
      label.textContent = `${ev.source ?? ''} · ${ev.category ?? ''}`.trim();
      li.appendChild(sev);
      li.appendChild(label);
      attentionQueueEl.appendChild(li);
    }
  }
}

function formatTtl(deadline) {
  if (deadline == null) return '∞';
  const ms = deadline - Date.now();
  if (ms <= 0) return '0s';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.ceil((ms % 60_000) / 1000);
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

// The TTL counter refreshes locally so a permission with 30s TTL ticks down
// even between SSE state updates. Only touches the one span.
setInterval(() => {
  if (!attentionActiveEl) return;
  const ttlEl = attentionActiveEl.querySelector('.attention-ttl');
  if (ttlEl && currentAttention.active) {
    ttlEl.textContent = formatTtl(currentAttention.active.deadline);
  }
}, 1000);

function renderHealth(health) {
  healthAdaptersEl.innerHTML = '';
  for (const [name, info] of Object.entries(health.adapters ?? {})) {
    const row = document.createElement('div');
    row.className = 'health-item';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.status = info.status;
    badge.textContent = info.status;
    row.textContent = `${name}: `;
    row.appendChild(badge);
    healthAdaptersEl.appendChild(row);
  }
  if (health.transport) {
    healthTransportEl.textContent = health.transport.connected ? 'connected' : 'disconnected';
    healthTransportEl.dataset.status = health.transport.connected ? 'HEALTHY' : 'BROKEN';
  }
}

function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 5000) return 'ahora';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  return `${Math.floor(diff / 3600000)}h`;
}

function truncate(text, max = 90) {
  if (!text) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function renderSessions(sessions) {
  currentSessions = sessions ?? {};
  updateButtonStates();
  // M12b: no balloon writes from here. The server emits it via ResolvedState
  // when the permission event becomes active (S2.5.1). Cards below still
  // render — that's information, not balloon policy.
  const entries = Object.entries(currentSessions);
  if (entries.length === 0) {
    sessionsListEl.innerHTML = '<p class="empty">No sessions yet.</p>';
    return;
  }
  sessionsListEl.innerHTML = '';
  for (const [sessionId, session] of entries) {
    const card = document.createElement('div');
    card.className = `session-card ${session.state}`;

    const header = document.createElement('div');
    header.className = 'session-header';
    const project = document.createElement('span');
    project.className = 'session-project';
    project.textContent = sessionProject(session);
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `${session.state} · ${relativeTime(session.lastEventAt)} · ${sessionId.slice(0, 8)}`;
    header.appendChild(project);
    header.appendChild(meta);
    card.appendChild(header);

    // Chat name priority: user-assigned desktop title > Claude Code slug >
    // last human prompt > first prompt. Each source gets a modifier class so
    // the visual weight matches the source (custom > slug > prompt fallback).
    const nameText =
      session.desktopTitle ??
      session.slug ??
      (session.lastPrompt
        ? truncate(session.lastPrompt, 60)
        : session.title
          ? truncate(session.title, 60)
          : null);
    if (nameText) {
      const nameEl = document.createElement('div');
      let cls = 'session-title';
      if (session.desktopTitle) cls += ' session-user-title';
      else if (session.slug) cls += ' session-slug';
      nameEl.className = cls;
      nameEl.textContent = nameText;
      card.appendChild(nameEl);
    }

    if (session.pendingPermission) {
      const perm = document.createElement('div');
      perm.className = 'session-permission';
      const detail =
        session.pendingPermission.summary ??
        session.pendingPermission.command ??
        '(command unavailable)';
      const marker = session.pendingPermission.isCritical ? '⚠ ' : '';
      perm.textContent = `${marker}${truncate(detail, 120)}`;
      card.appendChild(perm);
    } else if (session.lastResponse) {
      // Response only — the name already carries the latest prompt.
      const info = document.createElement('div');
      info.className = 'session-info';
      info.textContent = `↩ ${truncate(session.lastResponse)}`;
      card.appendChild(info);
    }

    const actions = document.createElement('div');
    actions.className = 'session-actions';
    if (session.pendingPermission) {
      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => sendApproval(sessionId, 'approve'));
      const denyBtn = document.createElement('button');
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => sendApproval(sessionId, 'deny'));
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
    } else {
      const fakePerm = document.createElement('button');
      fakePerm.textContent = 'Fake perm';
      fakePerm.title = 'Simular permission_prompt en esta sesión';
      fakePerm.addEventListener('click', () => simPost('/sim/permission', { sessionId }));
      actions.appendChild(fakePerm);
    }
    card.appendChild(actions);

    sessionsListEl.appendChild(card);
  }
}

function renderEvents(events) {
  // M15: route the initial replay through addEvent() so consecutive identical
  // events collapse the same way in-flight events do. Recorder gives us newest
  // first; addEvent prepends, so reverse to get the last-in-list to be oldest.
  eventsListEl.innerHTML = '';
  const linesOldestFirst = [...events].reverse();
  for (const line of linesOldestFirst) {
    if (line?.data) addEvent(line.data);
  }
}

function addEvent(event) {
  lastEventAt = Date.now();
  const severity = event.severity ?? 'ambient';
  const label = `${event.source ?? ''} ${event.category ?? ''}`.trim();
  const key = `${event.source ?? ''}|${event.category ?? ''}|${severity}`;

  // M15: fold consecutive identical events into one row with `×N`. This is
  // purely visual — the EventBus already deduplicates by hash for identical
  // payloads; this catches "same category, different payload" clusters that
  // the bus can't collapse.
  const first = eventsListEl.firstElementChild;
  if (first && first.dataset.groupKey === key) {
    const n = Number(first.dataset.groupCount ?? '1') + 1;
    first.dataset.groupCount = String(n);
    let counter = first.querySelector('.event-count');
    if (!counter) {
      counter = document.createElement('span');
      counter.className = 'event-count';
      first.appendChild(counter);
    }
    counter.textContent = `×${n}`;
    return;
  }

  const li = document.createElement('li');
  li.className = 'event-item';
  li.dataset.severity = severity;
  li.dataset.groupKey = key;
  li.dataset.groupCount = '1';
  li.textContent = label;
  eventsListEl.prepend(li);
  // M12b: no client-side balloon on event arrival. The state machine already
  // produced (or refused) a ResolvedState.balloon for this event through the
  // AttentionManager — driving the balloon from here would race.
}

// M15: Screen history. Polled cheaply, not streamed — it only updates when a
// balloon changes and the state SSE already told us that happened.
const historyEl = document.getElementById('balloon-history');
let lastKnownBalloon = '';

async function refreshBalloonHistory() {
  if (!historyEl) return;
  try {
    const items = await fetch('/balloons').then((r) => r.json());
    historyEl.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'nothing yet';
      historyEl.appendChild(li);
      return;
    }
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'balloon-history-item';
      const time = document.createElement('span');
      time.className = 'balloon-history-time';
      time.textContent = formatShortTime(item.ts);
      const text = document.createElement('span');
      text.className = 'balloon-history-text';
      text.textContent = item.text;
      li.appendChild(time);
      li.appendChild(text);
      historyEl.appendChild(li);
    }
  } catch {
    // best-effort; SSE state changes will re-invoke us
  }
}

function formatShortTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

async function sendApproval(sessionId, action) {
  sound.play(action === 'approve' ? 'approve' : 'deny');
  await fetch(`/approve/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

async function loadInitial() {
  try {
    const [state, events, health] = await Promise.all([
      fetch('/state').then((r) => r.json()),
      fetch('/events?limit=50').then((r) => r.json()),
      fetch('/health').then((r) => r.json()),
    ]);
    renderState(state);
    renderEvents(events);
    renderHealth(health);
    refreshBalloonHistory();
  } catch {
    // best-effort initial load; SSE will keep things fresh
  }
}

function connectStream() {
  const es = new EventSource('/stream');

  es.addEventListener('open', () => {
    connStatusEl.dataset.state = 'open';
    connStatusEl.textContent = 'live';
  });

  es.addEventListener('error', () => {
    connStatusEl.dataset.state = 'closed';
    connStatusEl.textContent = 'reconnecting…';
  });

  let lastMode = null;
  es.addEventListener('state', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.mode && lastMode && data.mode !== lastMode) sound.play('modeChange');
    if (data.mode) lastMode = data.mode;
    renderState(data);
  });

  es.addEventListener('event', (ev) => {
    addEvent(JSON.parse(ev.data));
  });

  es.addEventListener('health', (ev) => {
    renderHealth(JSON.parse(ev.data));
  });

  es.addEventListener('session', (ev) => {
    renderSessions(JSON.parse(ev.data));
  });

  return es;
}

// --- Simulation controls ---

const EMOTIONS = ['NEUTRAL', 'HAPPY', 'SAD', 'ANGRY', 'SLEEPY', 'DOUBTFUL', 'COLD', 'HOT'];
const simEmotionsEl = document.getElementById('sim-emotions');

for (const emo of EMOTIONS) {
  const btn = document.createElement('button');
  btn.className = 'sim-btn emotion-btn';
  btn.textContent = EMOTION_EMOJI[emo];
  btn.title = emo;
  btn.addEventListener('click', () => {
    faceRenderer.setEmotion(emo);
    simPost('/sim/emotion', { emotion: emo });
  });
  simEmotionsEl.appendChild(btn);
}

document.getElementById('sim-mode').addEventListener('click', () => simPost('/sim/mode', {}));
document
  .getElementById('sim-permission')
  .addEventListener('click', () => simPost('/sim/permission', {}));

// M16: replay the day-log through the bus. `lastN` is a client-side input;
// the server clamps to the file's real event count. `instant: true` skips
// inter-event sleeps so the whole batch surfaces in one flush.
const replayBtn = document.getElementById('sim-replay');
if (replayBtn) {
  replayBtn.addEventListener('click', async () => {
    const lastN = Number(document.getElementById('replay-lastn')?.value) || 20;
    const resultEl = document.getElementById('replay-result');
    if (resultEl) resultEl.textContent = 'replaying…';
    try {
      const r = await fetch('/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ lastN, instant: true }),
      });
      const body = await r.json();
      if (!r.ok) {
        if (resultEl) resultEl.textContent = body?.error ?? `error ${r.status}`;
      } else if (resultEl) {
        resultEl.textContent = `published ${body.published}, skipped ${body.skipped}`;
      }
    } catch (err) {
      if (resultEl) resultEl.textContent = `error: ${err.message}`;
    }
  });
}

for (const btn of document.querySelectorAll('[data-btn]')) {
  btn.addEventListener('click', async () => {
    const button = btn.dataset.btn;
    const pending = firstPendingSession();

    if (button === 'A' && pending) {
      sound.play('approve');
      await sendApproval(pending.id, 'approve');
      // No client balloon: the server emits `permission_resolved` and its
      // stateRule paints the "approved" state on the face (M13).
      return;
    }
    if (button === 'B' && pending) {
      sound.play('deny');
      await sendApproval(pending.id, 'deny');
      return;
    }

    sound.play(button === 'A' ? 'buttonA' : button === 'B' ? 'buttonB' : 'buttonC');
    simPost('/sim/button', { button });
  });
}

const servoYawEl = document.getElementById('servo-yaw');
const servoYawVal = document.getElementById('servo-yaw-val');
const servoPitchEl = document.getElementById('servo-pitch');
const servoPitchVal = document.getElementById('servo-pitch-val');

function onServoInput() {
  const yaw = Number(servoYawEl.value);
  const pitch = Number(servoPitchEl.value);
  servoYawVal.textContent = yaw;
  servoPitchVal.textContent = pitch;
  manualServoUntil = Date.now() + 8000;
  if (scene3d) scene3d.applyServo({ yaw, pitch });
  // No POST: the slider previews neck movement in the 3D scene client-side.
  // There is no server-side manual servo override — servo comes from the state
  // rules — so `/sim/servo` was never implemented and returned 404.
}

if (servoYawEl) servoYawEl.addEventListener('input', onServoInput);
if (servoPitchEl) servoPitchEl.addEventListener('input', onServoInput);

const TOUCH_SOUNDS = { tap: 'tap', swipe_fwd: 'swipe', swipe_back: 'swipe', hold: 'hold' };
for (const btn of document.querySelectorAll('[data-touch]')) {
  btn.addEventListener('click', () => {
    sound.play(TOUCH_SOUNDS[btn.dataset.touch] ?? 'tap');
    simPost('/sim/touch', { gesture: btn.dataset.touch });
  });
}

async function simPost(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn(`sim ${path}:`, err);
    }
  } catch (e) {
    console.warn(`sim ${path}:`, e);
  }
}

loadInitial();
connectStream();

// --- Auto servo & idle animations ---
// Called from animate3d() every frame. Writes both to the scene (via applyServo)
// and to the sliders so the UI reflects the auto-driven pose.

function autoServo(timeMs) {
  if (!scene3d || Date.now() < manualServoUntil) return;

  const pending = firstPendingSession();
  const t = timeMs / 1000;
  let yaw;
  let pitch;

  if (pending) {
    // Bigger amplitude so it's visible on the 3D canvas — ±20° yaw, ±8° pitch nod
    yaw = Math.sin(t * 2.2) * 20;
    pitch = 6 + Math.sin(t * 3.0) * 6;
  } else if (currentMode === 'SLEEP') {
    yaw = Math.sin(t * 0.15) * 3;
    pitch = -20 + Math.sin(t * 0.2) * 2;
  } else {
    const idle = Math.min((Date.now() - lastEventAt) / 10000, 1);
    const breathYaw = Math.sin(t * 0.4) * 12 + Math.sin(t * 0.17) * 8;
    const breathPitch = Math.sin(t * 0.3) * 5 + Math.cos(t * 0.13) * 3;
    yaw = breathYaw * (0.3 + idle * 0.7);
    pitch = breathPitch * (0.3 + idle * 0.7);
  }

  scene3d.applyServo({ yaw, pitch });

  if (servoYawEl) {
    servoYawEl.value = Math.round(yaw);
    servoYawVal.textContent = Math.round(yaw);
  }
  if (servoPitchEl) {
    servoPitchEl.value = Math.round(pitch);
    servoPitchVal.textContent = Math.round(pitch);
  }
}

// --- Screen info overlay ---
// M12b: `updateScreenInfo` was removed. It duplicated the AttentionManager's
// arbitration logic in the browser and produced the four-way collision that
// caused the balloon bugs of Fase 2. The server now owns the balloon and the
// AM decides when to preempt (SPEC-FASE-2.5 §0, S2.5.1). M15 will add a
// server-backed history panel for messages that got scrolled past.

// --- Tokens (GET /stats) ---------------------------------------------------
// Polled like Screen history, not streamed: the numbers only move when a
// `response` event lands, and the state SSE already announced that.
//
// `today` and `since start` are OUTPUT tokens — spend, following the field names
// in claude-desktop-buddy/REFERENCE.md. `context` is the fullest live session's
// window occupancy: pressure, not spend. Sessions are never summed.
const tokensTodayEl = document.getElementById('tokens-today');
const tokensSinceStartEl = document.getElementById('tokens-since-start');
const tokensContextEl = document.getElementById('tokens-context');
const tokensBarFillEl = document.getElementById('tokens-bar-fill');
const lifeApprovalsEl = document.getElementById('life-approvals');
const lifeDenialsEl = document.getElementById('life-denials');
const lifeFromheadEl = document.getElementById('life-fromhead');
const lifeStreakEl = document.getElementById('life-streak');

async function refreshTokens() {
  if (!tokensTodayEl) return;
  try {
    const stats = await fetch('/stats').then((r) => r.json());
    tokensTodayEl.textContent = formatTokens(stats.output.today);
    tokensSinceStartEl.textContent = formatTokens(stats.output.sinceStart);

    const ctx = stats.context.max;
    if (ctx === 0) {
      tokensContextEl.textContent = '—';
      tokensBarFillEl.style.width = '0%';
      return;
    }
    // No model window is reported anywhere, so show the absolute number and a
    // bar scaled to 200k. Inventing a percentage against a guessed limit would
    // be a number that looks authoritative and isn't.
    const pct = Math.min(100, (ctx / 200_000) * 100);
    tokensContextEl.textContent = formatTokens(ctx);
    tokensBarFillEl.style.width = `${pct}%`;
    if (lifeApprovalsEl && stats.life) {
      lifeApprovalsEl.textContent = String(stats.life.approvals);
      lifeDenialsEl.textContent = String(stats.life.denials);
      lifeFromheadEl.textContent = `${stats.life.fromHeadPct}%`;
      lifeStreakEl.textContent = `${stats.life.streak}d`;
    }
  } catch {
    // A failed poll is not worth a visible error; the next one is 5s away.
  }
}

refreshTokens();
setInterval(refreshTokens, 5000);

// --- Screen view -----------------------------------------------------------
// Which page the robot is showing. Server state (S2.5.1). The rendering lives in
// screen.mjs so it can be tested under jsdom (D-14); this only fetches.
const screenEls = {
  badge: document.getElementById('screen-view-badge'),
  overlay: document.getElementById('screen-stats-overlay'),
  wrap: document.querySelector('.viewport-3d-wrap'),
};

async function refreshScreenView(screen) {
  if (!screen || !screenEls.badge) return;
  const stats =
    screen.view === 'stats'
      ? await fetch('/stats').then((r) => r.json())
      : { output: { today: 0, sinceStart: 0 }, context: { bySession: {}, max: 0 } };
  renderScreenView(screenEls, screen, stats);
}
