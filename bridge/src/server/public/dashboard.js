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

const faceEl = document.getElementById('face');
const stateModeEl = document.getElementById('state-mode');
const connStatusEl = document.getElementById('conn-status');
const healthAdaptersEl = document.getElementById('health-adapters');
const healthTransportEl = document.getElementById('health-transport-status');
const sessionsListEl = document.getElementById('sessions-list');
const eventsListEl = document.getElementById('events-list');

function setFace(emotion) {
  faceEl.textContent = EMOTION_EMOJI[emotion] ?? EMOTION_EMOJI.NEUTRAL;
}

function renderState(state) {
  if (state.resolvedState?.emotion) setFace(state.resolvedState.emotion);
  if (state.mode) stateModeEl.textContent = state.mode;
}

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

function renderSessions(sessions) {
  const entries = Object.entries(sessions ?? {});
  if (entries.length === 0) {
    sessionsListEl.innerHTML = '<p class="empty">No sessions yet.</p>';
    return;
  }
  sessionsListEl.innerHTML = '';
  for (const [sessionId, session] of entries) {
    const card = document.createElement('div');
    card.className = `session-card ${session.state}`;
    const label = document.createElement('span');
    label.textContent = `${sessionId.slice(0, 8)} — ${session.state} (${session.cwd})`;
    card.appendChild(label);
    if (session.pendingPermission) {
      const actions = document.createElement('span');
      actions.className = 'session-actions';
      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve';
      approveBtn.addEventListener('click', () => sendApproval(sessionId, 'approve'));
      const denyBtn = document.createElement('button');
      denyBtn.textContent = 'Deny';
      denyBtn.addEventListener('click', () => sendApproval(sessionId, 'deny'));
      actions.appendChild(approveBtn);
      actions.appendChild(denyBtn);
      card.appendChild(actions);
    }
    sessionsListEl.appendChild(card);
  }
}

function renderEvents(events) {
  eventsListEl.innerHTML = '';
  for (const line of events) {
    const li = document.createElement('li');
    li.className = 'event-item';
    const severity = line.data?.severity ?? 'ambient';
    li.dataset.severity = severity;
    li.textContent = `${line.data?.source ?? ''} ${line.data?.category ?? ''}`.trim();
    eventsListEl.appendChild(li);
  }
}

function addEvent(event) {
  const li = document.createElement('li');
  li.className = 'event-item';
  const severity = event.severity ?? 'ambient';
  li.dataset.severity = severity;
  li.textContent = `${event.source ?? ''} ${event.category ?? ''}`.trim();
  eventsListEl.prepend(li);
}

async function sendApproval(sessionId, action) {
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

  es.addEventListener('state', (ev) => {
    renderState(JSON.parse(ev.data));
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

loadInitial();
connectStream();
