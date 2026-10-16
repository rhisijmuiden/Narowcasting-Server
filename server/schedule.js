'use strict';
// Decides which playout is on air right now, based on the schedule rules.
const store = require('./store');

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function nowParts(timezone) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    day: parts.weekday.toLowerCase().slice(0, 3),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function ruleMatches(rule, now) {
  if (rule.enabled === false) return false;
  if (rule.startDate && now.date < rule.startDate) return false;
  if (rule.endDate && now.date > rule.endDate) return false;
  const days = Array.isArray(rule.days) && rule.days.length ? rule.days : DAYS;
  const start = toMinutes(rule.start || '00:00');
  const end = rule.end ? toMinutes(rule.end) : 24 * 60;
  if (start <= end) return days.includes(now.day) && now.minutes >= start && now.minutes < end;
  // Overnight window, e.g. 22:00 - 06:00
  const prevDay = DAYS[(DAYS.indexOf(now.day) + 6) % 7];
  return (days.includes(now.day) && now.minutes >= start) || (days.includes(prevDay) && now.minutes < end);
}

function activePlayoutId() {
  const settings = store.getSection('settings');
  const now = nowParts(settings.timezone);
  // Higher priority wins; on a tie the rule listed first wins.
  const rules = store.list('schedule')
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => ruleMatches(r, now))
    .sort((a, b) => (Number(b.r.priority) || 0) - (Number(a.r.priority) || 0) || a.i - b.i);
  const pick = rules.length ? rules[0].r.playoutId : settings.defaultPlayoutId;
  if (pick && store.get('playouts', pick)) return pick;
  const first = store.list('playouts')[0];
  return first ? first.id : null;
}

// Slides can carry their own time window; reuses the same matching rules.
function windowOpen(win) {
  if (!win) return true;
  return ruleMatches(win, nowParts(store.getSection('settings').timezone));
}

module.exports = { activePlayoutId, windowOpen, nowParts, DAYS };
