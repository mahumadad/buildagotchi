/**
 * What the robot's 320×240 screen is drawing. Pure DOM, no fetch, no timers —
 * `dashboard.js` owns the polling and hands the data in, so this can be tested
 * under jsdom (D-14).
 *
 * The view itself is server state (S2.5.1): the firmware cannot run browser JS,
 * so display policy lives in the bridge and this only renders it.
 */

/** The precedent's abbreviation, so 184502 fits a 320px screen as `184.5K`. */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function tokensPage(stats) {
  return [
    'TOKENS',
    `  today       ${formatTokens(stats.output.today)}`,
    `  since start ${formatTokens(stats.output.sinceStart)}`,
    `  context     ${stats.context.max === 0 ? '—' : formatTokens(stats.context.max)}`,
  ].join('\n');
}

function sessionsPage(stats) {
  const entries = Object.entries(stats.context.bySession);
  // `sessions` is optional so an older /stats payload still renders.
  const s = stats.sessions ?? { total: 0, running: 0, waiting: 0 };
  return [
    `SESSIONS  ${s.running} run / ${s.waiting} wait`,
    ...(entries.length === 0
      ? ['  none']
      : entries.map(([id, ctx]) => `  ${id.slice(0, 12).padEnd(14)}${formatTokens(ctx)}`)),
  ].join('\n');
}

/**
 * @param {{badge: HTMLElement, overlay: HTMLElement, wrap: HTMLElement}} els
 * @param {{view: string, page: number, pages: number} | undefined} screen
 * @param {object} stats
 */
export function renderScreenView(els, screen, stats) {
  if (!screen || !els.badge) return;

  els.badge.textContent =
    screen.pages > 1 ? `${screen.view} ${screen.page + 1}/${screen.pages}` : screen.view;

  const showStats = screen.view === 'stats';
  els.overlay.hidden = !showStats;
  // The overlay is drawn ON TOP of the scene, never instead of it. Hiding the
  // wrapper collapsed it to 0×0, and `StackchanScene#resize` only runs on a
  // window resize — so coming back to the face left a 0-pixel canvas and the
  // robot vanished for good. Nothing here may touch `els.wrap.hidden`.
  if (!showStats) return;

  els.overlay.textContent = screen.page === 0 ? tokensPage(stats) : sessionsPage(stats);
}
