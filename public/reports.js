// Daily and weekly summary for managers, built from the server's saved daily records.
// Uses duration, roundDuration, el, localTime, initials and appTime from shared.js.
// Each person's days are their own office's dates (Kolkata or London); "today" refreshes every 10 seconds.
const $ = id => document.getElementById(id);
let range = 'today';
let report = null;
let refreshTimer = null;

function hoursText(row) {
  if (range === 'week') return `${row.daysActive} of ${row.days.length}`;
  if (!row.firstSeen) return 'Not seen';
  return `${localTime(row.firstSeen, row.timeZone)} to ${localTime(row.lastSeen, row.timeZone)}`;
}

function flagsCell(row) {
  const cell = el('div', 'cell report-flags');
  const { noWork, regular, trackerStops } = row.flagged;
  if (!noWork && !regular && !trackerStops) cell.append(el('span', 'muted', 'None'));
  if (noWork) cell.append(el('div', 'flag', `⚑ Nothing saved for ${roundDuration(noWork)}`));
  if (regular) cell.append(el('div', 'flag', `⚑ Too regular for ${roundDuration(regular)}`));
  if (trackerStops) cell.append(el('div', 'flag', `⚑ Desktop app stopped ${trackerStops === 1 ? 'once' : `${trackerStops} times`}`));
  return cell;
}

// Labelled value cell; the label only shows when rows turn into cards on narrow screens.
function valueCell(label, value, className = '') {
  const cell = el('div', `cell report-value ${className}`);
  cell.append(el('span', 'cell-name', label), el('span', 'cell-value', value));
  return cell;
}

// Seven small columns: work actions per day (bar), activity % underneath. Sample days get a dashed outline.
function weekStrip(row, maxWork) {
  const strip = el('div', 'week-strip');
  for (const day of row.days) {
    const column = el('div', `week-day${day.sample ? ' sample' : ''}${day.atComputer ? '' : ' empty'}`);
    const weekdayName = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    const bar = el('div', 'bar');
    const fill = el('i');
    fill.style.height = `${maxWork ? Math.round((day.work / maxWork) * 100) : 0}%`;
    bar.append(fill);
    column.append(
      el('span', 'week-name', weekdayName),
      el('span', 'week-work', day.work ? String(day.work) : ''),
      bar,
      el('span', 'week-activity', day.activity === null ? '–' : `${day.activity}%`)
    );
    column.title = `${day.date}${day.sample ? ' (sample)' : ''}: ${day.work} work actions, `
      + `${day.activity === null ? 'no activity' : `activity ${day.activity}%`}, ${duration(day.atComputer)} at the computer`;
    strip.append(column);
  }
  return strip;
}

function teamStats(team) {
  const stat = (label, value, note, lead) => {
    const box = el('div', `stat${lead ? ' stat-lead' : ''}`);
    box.append(el('span', '', label), el('b', '', value), el('small', '', note));
    return box;
  };
  return [
    stat('Team activity', team.activity === null ? '–' : `${team.activity}%`, 'of time at the computer had mouse or keyboard use', true),
    stat('Work actions', String(team.work), 'things opened or saved, whole team', true),
    stat('At the computer', roundDuration(team.atComputer), `across ${team.people} people`),
    stat('Calls and meetings', roundDuration(team.callsAndMeetings), 'no idle logout during these'),
    stat('People with flags', String(team.flaggedPeople), 'worth a look, not a penalty')
  ];
}

function render() {
  $('hours-head').textContent = range === 'week' ? 'Days active' : 'First in, last seen';
  $('team-stats').replaceChildren(...teamStats(report.team));
  $('sample-note').hidden = !report.sample;
  const maxWork = Math.max(1, ...report.employees.flatMap(row => row.days.map(day => day.work)));

  $('report-rows').replaceChildren(...report.employees.map(row => {
    const line = el('div', `report-row${range === 'week' ? ' with-week' : ''}`);
    const person = el('div', 'cell person-cell');
    const text = el('div');
    text.append(el('div', 'name', row.name), el('div', 'muted small', row.office));
    person.append(el('span', 'avatar', initials(row.name)), text);

    const apps = el('div', 'cell report-value report-apps');
    apps.append(el('span', 'cell-name', 'Time by app'));
    const appsValue = el('span', 'cell-value apps-time');
    if (row.apps.length) appsValue.append(...row.apps.map(app => appTime(app)));
    else appsValue.append(el('span', 'muted', 'None'));
    apps.append(appsValue);

    line.append(
      person,
      valueCell('At the computer', roundDuration(row.atComputer)),
      valueCell('Activity', row.activity === null ? '–' : `${row.activity}%`, 'big activity'),
      valueCell('Work actions', String(row.work), 'big work'),
      valueCell('Calls and meetings', roundDuration(row.callsAndMeetings)),
      valueCell('Breaks', roundDuration(row.breaks)),
      apps,
      valueCell(range === 'week' ? 'Days active' : 'First in, last seen', hoursText(row)),
      flagsCell(row)
    );
    if (range === 'week') line.append(weekStrip(row, maxWork));
    return line;
  }));
}

async function load() {
  clearTimeout(refreshTimer);
  const response = await fetch(`/api/report?range=${range}`);
  if (response.ok) {
    report = await response.json();
    render();
  }
  if (range === 'today') refreshTimer = setTimeout(load, 10_000);
}

// A cell starting with = + - or @ could run as a formula in Excel; a leading apostrophe keeps it as text.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// "2026-10-22 09:32" in the employee's own time zone, so a week's first and last times carry their dates.
function localDateTime(at, timeZone) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  return `${date} ${localTime(at, timeZone)}`;
}

function downloadCsv() {
  if (!report) return;
  const hours = seconds => (seconds / 3600).toFixed(2);
  const header = ['Name', 'Office', 'Period', 'At the computer (hours)', 'Activity %', 'Work actions', 'Calls and meetings (hours)',
    'Breaks (hours)', 'Console (hours)', 'TMS (hours)', 'First seen (local date and time)', 'Last seen (local date and time)', 'Days active',
    'Flagged: nothing saved (minutes)', 'Flagged: too regular (minutes)', 'Includes sample days'];
  const lines = report.employees.map(row => {
    const app = name => hours(row.apps.find(item => item.name === name)?.seconds || 0);
    return [row.name, row.office, range, hours(row.atComputer), row.activity ?? '', row.work, hours(row.callsAndMeetings),
      hours(row.breaks), app('Console'), app('TMS'),
      row.firstSeen ? localDateTime(row.firstSeen, row.timeZone) : '', row.lastSeen ? localDateTime(row.lastSeen, row.timeZone) : '',
      row.daysActive, Math.round(row.flagged.noWork / 60), Math.round(row.flagged.regular / 60), row.sample ? 'yes' : 'no'];
  });
  const csv = [header, ...lines].map(cells => cells.map(csvCell).join(',')).join('\r\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = `team-activity-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function sample(action) {
  const response = await fetch('/api/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
  $('sample-message').textContent = response.ok
    ? (action === 'add' ? 'Sample week added.' : 'Sample week removed.')
    : (await response.json()).error;
  load();
}

for (const button of document.querySelectorAll('[data-range]')) {
  button.onclick = () => {
    range = button.dataset.range;
    for (const other of document.querySelectorAll('[data-range]')) other.classList.toggle('on', other === button);
    load();
  };
}
$('csv').onclick = downloadCsv;
$('sample-add').onclick = () => sample('add');
$('sample-remove').onclick = () => sample('remove');
load();
