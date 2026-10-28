// Helpers used by both the console ("My day") and the manager screen.
const STATE_LABELS = {
  working: 'Working', active: 'Active', idle: 'Idle', away: 'Away', logged_out: 'Logged out',
  call: 'On a call', meeting: 'In a meeting', break: 'On a break'
};

function duration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// Rounded for reports: "45s", "38m", "7h 05m".
function roundDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function initials(name) {
  return name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
}

function localTime(at, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(at));
}

// "Console 3m 10s" with a small app badge, for time in use per app.
function appTime({ name, seconds }) {
  const item = el('span', 'app-time');
  item.append(el('span', 'app-tag', name), document.createTextNode(duration(seconds)));
  return item;
}

function blockName(blockSeconds) {
  return blockSeconds % 60 === 0 ? (blockSeconds === 60 ? 'minute' : `${blockSeconds / 60} minutes`) : `${blockSeconds} seconds`;
}

// One column per block: activity % as a bar (number on top), work actions (✓) underneath. Newest on the right.
function blockChart(blocks, blockSeconds, timeZone) {
  const chart = el('div', 'blocks');
  for (const block of blocks) {
    const column = el('div', `block${block.current ? ' current' : ''}`);
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.height = `${block.activity ?? 0}%`;
    bar.append(fill);
    column.append(
      el('span', 'pct', block.activity === null ? '' : String(block.activity)),
      bar,
      el('span', 'work', block.work ? `✓${block.work}` : '')
    );
    const from = localTime(block.start, timeZone);
    const to = localTime(block.start + blockSeconds * 1000, timeZone);
    column.title = `${from}–${to}${block.current ? ' (still filling up)' : ''} · `
      + `${block.activity === null ? 'not at the computer' : `activity ${block.activity}%`} · ${block.work} work action${block.work === 1 ? '' : 's'}`;
    chart.append(column);
  }
  return chart;
}
