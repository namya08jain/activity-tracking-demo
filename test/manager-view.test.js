const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityTracker } = require('../src/tracker');
const { SamplePeople } = require('../src/sample-people');
const { cleanView, overview, select } = require('../src/manager-view');

const config = {
  heartbeat: 5, presence: 20, work: 60, idleLogout: 60, warningBefore: 20, noWorkFlag: 45, deadConnection: 10, timelineWindow: 600,
  block: 60, manualMax: 180, regularWindow: 60, regularMinGaps: 15, regularMaxVariation: 0.05
};
const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const at = seconds => T0 + seconds * 1000;
const person = (name, state, extra = {}) => ({ id: name.toLowerCase(), name, team: 'Admissions', office: 'Kolkata', timeZone: 'Asia/Kolkata', state, since: 60, app: null, activity: 50, work: 3, flags: [], ...extra });

test('a page can only ask for known filters and sorts, and at most 200 rows at a time', () => {
  assert.deepEqual(cleanView({ search: '  PRIYA ', status: 'nonsense', sort: 'drop table', offset: -5, limit: 10_000 }),
    { search: 'priya', team: '', office: '', status: '', sort: 'attention', offset: 0, limit: 200 });
  assert.equal(cleanView({ team: { evil: true } }).team, '');
  assert.equal(cleanView({ search: 'x'.repeat(500) }).search.length, 60);
});

test('the overview counts each status and gives every team its own totals', () => {
  const rows = [
    person('Ananya', 'working'), person('Priya', 'idle', { flags: ['noWork'] }),
    person('Rahul', 'call', { team: 'Visa' }), person('Oliver', 'logged_out', { team: 'Visa', office: 'London' })
  ];
  const summary = overview(rows);
  assert.equal(summary.people, 4);
  assert.equal(summary.online, 3);
  assert.equal(summary.flagged, 1);
  assert.deepEqual(summary.offices.map(office => office.name), ['Kolkata', 'London']);
  const visa = summary.teams.find(team => team.name === 'Visa');
  assert.deepEqual({ people: visa.people, online: visa.online, busy: visa.busy, flagged: visa.flagged }, { people: 2, online: 1, busy: 1, flagged: 0 });
});

test('"Needs a look" order: flagged first, then idle or away the longest, then the rest', () => {
  const rows = [
    person('Working Wendy', 'working'),
    person('Idle Ivan', 'idle', { since: 300 }),
    person('Idle Ira', 'idle', { since: 900 }),
    person('Flagged Fay', 'working', { flags: ['regular'] }),
    person('Gone Gita', 'logged_out')
  ];
  const { rows: ordered } = select(rows, cleanView());
  assert.deepEqual(ordered.map(row => row.name), ['Flagged Fay', 'Idle Ira', 'Idle Ivan', 'Working Wendy', 'Gone Gita']);
});

test('filters combine, and only the rows on screen are sent', () => {
  const rows = Array.from({ length: 500 }, (_, index) => person(`Person ${String(index).padStart(3, '0')}`, index % 2 ? 'working' : 'idle', { team: index % 5 ? 'Admissions' : 'Visa' }));
  const visaIdle = select(rows, cleanView({ team: 'Visa', status: 'idle', sort: 'name' }));
  assert.equal(visaIdle.total, 50);
  assert.ok(visaIdle.rows.every(row => row.team === 'Visa' && row.state === 'idle'));
  const page = select(rows, cleanView({ sort: 'name', offset: 100, limit: 40 }));
  assert.equal(page.total, 500);
  assert.equal(page.rows.length, 40);
  assert.equal(page.rows[0].name, 'Person 100');
  assert.equal(select(rows, cleanView({ search: 'person 04' })).total, 10);
});

test('a real employee becomes one short line: status, how long, app in use, activity, work and flags', () => {
  const tracker = new ActivityTracker(config, [{ id: 'ananya', name: 'Ananya Bose', office: 'Kolkata', timeZone: 'Asia/Kolkata', team: 'Admissions' }]);
  const token = tracker.login('ananya', at(0));
  tracker.connect('tab', token, { deviceId: 'laptop', app: 'Console' });
  for (let second = 1; second <= 30; second++) {
    tracker.heartbeat('tab', { visible: true, secondsSinceInput: 0, inputSeconds: [0] }, at(second));
    tracker.tick(at(second));
  }
  tracker.work('tab', 'Saved a note', at(31));
  tracker.tick(at(31));
  const row = tracker.row(tracker.users.get('ananya'), at(40));
  assert.deepEqual({ ...row, activity: row.activity > 0 }, {
    id: 'ananya', name: 'Ananya Bose', team: 'Admissions', office: 'Kolkata', timeZone: 'Asia/Kolkata',
    state: 'working', since: 10, app: 'Console', activity: true, work: 1, flags: []
  });
  assert.equal(tracker.detail('ananya', at(40)).team, 'Admissions');
  assert.equal(tracker.detail('nobody', at(40)), null);
});

test('2,000 sample people: the same crowd every time, spread over teams, drifting between statuses', () => {
  const crowd = new SamplePeople(config);
  crowd.add(2000, T0);
  assert.equal(crowd.size, 2000);
  const rows = crowd.rows(T0);
  assert.equal(new Set(rows.map(row => row.name)).size, 2000, 'names are unique');
  assert.equal(new Set(rows.map(row => row.team)).size, 10);
  assert.ok(rows.some(row => row.flags.length), 'some are worth a look');
  const again = new SamplePeople(config);
  again.add(2000, T0);
  assert.deepEqual(again.rows(T0).slice(0, 5), rows.slice(0, 5));

  const before = rows.map(row => row.state).join();
  for (let second = 1; second <= 60; second++) crowd.tick(T0 + second * 1000);
  assert.notEqual(crowd.rows(T0 + 60_000).map(row => row.state).join(), before);
  const detail = crowd.detail('sample-1', T0 + 60_000);
  assert.ok(detail.blocks.length > 0 && detail.segments.length > 0);
  assert.equal(crowd.detail('sample-99999', T0), null);
  crowd.remove();
  assert.equal(crowd.size, 0);
});
