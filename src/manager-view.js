// The manager screen at Crizac's size: thousands of people. Each manager's page tells the server what it is looking
// at (search, team, office, status, sort, and which rows are on screen); the server sends the totals and only those
// rows, about 40, every second. The full picture of one person is sent only while their detail panel is open.

const STATES = ['working', 'active', 'idle', 'away', 'call', 'meeting', 'break', 'logged_out'];
const ONLINE = STATES.filter(state => state !== 'logged_out');
// "Working" in the team cards: at work, on a call or in a meeting.
const BUSY = new Set(['working', 'call', 'meeting']);
const SORTS = new Set(['attention', 'name', 'status', 'activity', 'work', 'longest']);
const STATUS_FILTERS = new Set(['', 'online', 'flagged', ...STATES]);
const MAX_ROWS = 200;

const text = (value, max = 60) => (typeof value === 'string' ? value.slice(0, max) : '');
const whole = (value, low, high, fallback) => (Number.isInteger(value) ? Math.min(Math.max(value, low), high) : fallback);

// What a page may ask for; anything else falls back to the default.
function cleanView(input = {}) {
  return {
    search: text(input.search).trim().toLowerCase(),
    team: text(input.team),
    office: text(input.office),
    status: STATUS_FILTERS.has(input.status) ? input.status : '',
    sort: SORTS.has(input.sort) ? input.sort : 'attention',
    offset: whole(input.offset, 0, 1_000_000, 0),
    limit: whole(input.limit, 1, MAX_ROWS, 60)
  };
}

// Totals for the top of the page and the team cards, worked out once a second for every manager.
function overview(rows) {
  const counts = Object.fromEntries(STATES.map(state => [state, 0]));
  const teams = new Map();
  const offices = new Map();  // office → its time zone, for the clocks
  let flagged = 0;
  for (const row of rows) {
    counts[row.state]++;
    if (row.flags.length) flagged++;
    if (row.office && !offices.has(row.office)) offices.set(row.office, row.timeZone);
    const name = row.team || 'No team';
    let team = teams.get(name);
    if (!team) teams.set(name, team = { name, people: 0, online: 0, busy: 0, flagged: 0, counts: Object.fromEntries(STATES.map(state => [state, 0])) });
    team.people++;
    team.counts[row.state]++;
    if (row.state !== 'logged_out') team.online++;
    if (BUSY.has(row.state)) team.busy++;
    if (row.flags.length) team.flagged++;
  }
  return {
    people: rows.length,
    online: ONLINE.reduce((sum, state) => sum + counts[state], 0),
    counts,
    flagged,
    teams: [...teams.values()].sort((a, b) => b.people - a.people || a.name.localeCompare(b.name)),
    offices: [...offices].map(([name, timeZone]) => ({ name, timeZone })).sort((a, b) => a.name.localeCompare(b.name))
  };
}

// Most urgent first: flagged, then idle or away the longest, then people at work, then those logged out.
const URGENCY = { idle: 1, away: 1, active: 2, working: 3, call: 3, meeting: 3, break: 3, logged_out: 4 };
const STATUS_ORDER = Object.fromEntries(STATES.map((state, index) => [state, index]));
const byName = (a, b) => a.name.localeCompare(b.name);
const COMPARE = {
  attention: (a, b) => (b.flags.length - a.flags.length) || (URGENCY[a.state] - URGENCY[b.state]) || ((b.since ?? 0) - (a.since ?? 0)) || byName(a, b),
  name: byName,
  status: (a, b) => (STATUS_ORDER[a.state] - STATUS_ORDER[b.state]) || ((b.since ?? 0) - (a.since ?? 0)) || byName(a, b),
  // Lowest activity first: the people worth a look. No figure yet goes last.
  activity: (a, b) => ((a.activity ?? 101) - (b.activity ?? 101)) || byName(a, b),
  work: (a, b) => (b.work - a.work) || byName(a, b),
  longest: (a, b) => ((b.since ?? 0) - (a.since ?? 0)) || byName(a, b)
};

function matches(row, view) {
  if (view.team && (row.team || 'No team') !== view.team) return false;
  if (view.office && row.office !== view.office) return false;
  if (view.status === 'flagged' && !row.flags.length) return false;
  if (view.status === 'online' && row.state === 'logged_out') return false;
  if (view.status && view.status !== 'flagged' && view.status !== 'online' && row.state !== view.status) return false;
  if (view.search && !row.name.toLowerCase().includes(view.search)) return false;
  return true;
}

// The rows one manager's page shows: filtered, sorted, and only the part on screen.
function select(rows, view) {
  const chosen = rows.filter(row => matches(row, view)).sort(COMPARE[view.sort]);
  return { total: chosen.length, offset: view.offset, rows: chosen.slice(view.offset, view.offset + view.limit) };
}

module.exports = { cleanView, overview, select, STATES };
