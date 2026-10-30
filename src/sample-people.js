// Demo only: a crowd of made-up employees for the manager screen, so it can be shown at the size Crizac works at.
// Each one drifts between statuses about as often as real staff would (sped up like the rest of the demo).
// They live in memory only: never in reports, saved history or "My day", and the button removes them again.

const FIRST = ['Aarav', 'Aditi', 'Akash', 'Ananya', 'Anika', 'Anjali', 'Arjun', 'Arnav', 'Aryan', 'Avik', 'Ayesha', 'Debjani',
  'Deepak', 'Dev', 'Diya', 'Farhan', 'Gaurav', 'Ishaan', 'Ishita', 'Kabir', 'Kavya', 'Krish', 'Meera', 'Mohit', 'Nandini',
  'Neha', 'Nikhil', 'Nisha', 'Pooja', 'Pranav', 'Priyanka', 'Rahul', 'Rajat', 'Ria', 'Rohan', 'Sahil', 'Sanya', 'Sayan',
  'Shreya', 'Siddharth', 'Sneha', 'Soumya', 'Sourav', 'Subhajit', 'Swati', 'Tanvi', 'Tanya', 'Varun', 'Vikram', 'Zoya'];
const LAST = ['Agarwal', 'Banerjee', 'Basu', 'Bhattacharya', 'Bose', 'Chakraborty', 'Chatterjee', 'Das', 'Datta', 'Dey', 'Ghosh',
  'Gupta', 'Iyer', 'Jain', 'Kapoor', 'Khan', 'Kumar', 'Mehta', 'Mitra', 'Mukherjee', 'Nair', 'Pal', 'Paul', 'Rao', 'Roy',
  'Saha', 'Sarkar', 'Sen', 'Sengupta', 'Sharma', 'Singh', 'Sinha', 'Verma'];
const UK_FIRST = ['Amelia', 'Charlotte', 'Daniel', 'Emily', 'George', 'Grace', 'Harry', 'Isla', 'Jack', 'James', 'Lucy', 'Oliver', 'Sophie', 'Thomas'];
const UK_LAST = ['Brown', 'Clarke', 'Evans', 'Green', 'Hughes', 'Johnson', 'Patel', 'Roberts', 'Smith', 'Taylor', 'Walker', 'Wilson'];

// Team, share of staff, and the apps that team mostly works in.
const TEAMS = [
  ['Admissions', 26, ['Console', 'University portal', 'Outlook', 'Excel']],
  ['Visa', 14, ['Console', 'Outlook', 'Chrome', 'Excel']],
  ['Partner support', 12, ['Console', 'Outlook', 'Teams', 'TMS']],
  ['Interview team', 9, ['Console', 'Teams', 'Outlook']],
  ['Accommodation', 8, ['Console', 'Chrome', 'Outlook']],
  ['Student loans', 7, ['Console', 'Excel', 'Outlook']],
  ['Finance', 7, ['Excel', 'Console', 'Outlook']],
  ['Marketing', 7, ['Chrome', 'Outlook', 'Excel']],
  ['Scholarships', 5, ['Console', 'University portal', 'Outlook']],
  ['Compliance', 5, ['Console', 'Excel', 'TMS']]
];
const CALL_APPS = ['Teams', 'Teams', 'WhatsApp', 'Zoom'];

// Chance per second of moving from one status to another.
const MOVES = {
  working: { active: 0.02, idle: 0.004, call: 0.006, meeting: 0.002, break: 0.002, away: 0.002, logged_out: 0.0002 },
  active: { working: 0.04, idle: 0.01, call: 0.005, away: 0.003 },
  idle: { active: 0.05, working: 0.02, away: 0.006 },
  call: { working: 0.012 },
  meeting: { working: 0.006 },
  break: { working: 0.008 },
  away: { active: 0.03, logged_out: 0.002 },
  logged_out: { working: 0.002 }
};
const START = [['working', 55], ['active', 15], ['call', 9], ['idle', 6], ['meeting', 3], ['break', 3], ['away', 2], ['logged_out', 7]];
const STATES = ['working', 'active', 'idle', 'away', 'call', 'meeting', 'break'];
const AT_COMPUTER = ['working', 'active', 'idle', 'away'];

// The same crowd every time: a seeded random number generator.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(random, items) {
  const total = items.reduce((sum, item) => sum + item[1], 0);
  let roll = random() * total;
  for (const item of items) {
    roll -= item[1];
    if (roll < 0) return item;
  }
  return items[items.length - 1];
}

class SamplePeople {
  constructor(config) {
    this.config = config;
    this.people = new Map();
    this.random = seeded(20261028);
  }

  get size() {
    return this.people.size;
  }

  add(count, now) {
    const random = seeded(1028);
    const used = new Set();
    for (let index = 0; index < count; index++) {
      const london = random() < 0.12;
      const [team, , apps] = pickWeighted(random, TEAMS);
      let name;
      do {
        const first = london ? UK_FIRST : FIRST;
        const last = london ? UK_LAST : LAST;
        name = `${first[Math.floor(random() * first.length)]} ${last[Math.floor(random() * last.length)]}`;
        if (used.has(name)) name += ` ${String.fromCharCode(65 + Math.floor(random() * 26))}.`;
      } while (used.has(name));
      used.add(name);
      const [state] = pickWeighted(random, START);
      const person = {
        id: `sample-${index + 1}`, name, team, apps,
        office: london ? 'London' : 'Kolkata', timeZone: london ? 'Europe/London' : 'Asia/Kolkata',
        state, since: now - Math.floor(random() * 40 * 60_000),
        app: apps[Math.floor(random() * apps.length)],
        callApp: CALL_APPS[Math.floor(random() * CALL_APPS.length)],
        // Today so far, in seconds; it keeps growing while the demo runs.
        totals: Object.fromEntries(STATES.map(key => [key, 0])),
        activeSeconds: 0,
        work: Math.floor(random() * 40),
        // A few people get something worth a look, as in a real team.
        flags: random() < 0.015 ? ['noWork'] : random() < 0.006 ? ['regular'] : random() < 0.004 ? ['stopped'] : [],
        history: []
      };
      const hours = 1 + random() * 5;
      person.totals.working = Math.round(hours * 3600 * (0.5 + random() * 0.2));
      person.totals.active = Math.round(hours * 3600 * 0.15);
      person.totals.idle = Math.round(hours * 3600 * 0.06);
      person.totals.call = Math.round(hours * 3600 * random() * 0.15);
      person.activeSeconds = Math.round((person.totals.working + person.totals.active) * (0.5 + random() * 0.35));
      if (person.flags.includes('noWork')) Object.assign(person, { state: 'active', work: Math.floor(random() * 3) });
      if (person.flags.includes('regular')) person.state = 'active';
      if (person.flags.includes('stopped')) person.state = 'away';
      // A believable last few minutes before the current status, so their timeline isn't empty on day one.
      const windowStart = now - this.config.timelineWindow * 1000;
      if (person.since > windowStart && person.state !== 'logged_out') {
        person.history.push({ state: random() < 0.75 ? 'working' : 'active', start: windowStart, end: person.since });
      }
      person.history.push({ state: person.state, start: person.since, end: now });
      this.people.set(person.id, person);
    }
  }

  remove() {
    this.people.clear();
  }

  // Called once a second.
  tick(now, elapsedSeconds = 1) {
    for (const person of this.people.values()) {
      if (person.state !== 'logged_out') person.totals[person.state] += elapsedSeconds;
      if (person.state === 'working' || person.state === 'active') {
        if (this.random() < 0.8) person.activeSeconds += elapsedSeconds;
        if (person.state === 'working' && this.random() < 0.04) person.work++;
        if (this.random() < 0.01) person.app = person.apps[Math.floor(this.random() * person.apps.length)];
      }
      const last = person.history[person.history.length - 1];
      last.end = now;
      // Flagged people stay put, so the manager can find them.
      if (person.flags.length) continue;
      const moves = MOVES[person.state];
      let roll = this.random();
      for (const [next, chance] of Object.entries(moves)) {
        roll -= chance * elapsedSeconds;
        if (roll < 0) {
          person.state = next;
          person.since = now;
          person.history.push({ state: next, start: now, end: now });
          break;
        }
      }
      const oldest = now - this.config.timelineWindow * 1000;
      while (person.history.length > 1 && person.history[0].end < oldest) person.history.shift();
    }
  }

  row(person, now) {
    const atComputer = AT_COMPUTER.reduce((sum, key) => sum + person.totals[key], 0);
    const inUse = person.state === 'working' || person.state === 'active';
    return {
      id: person.id, name: person.name, team: person.team, office: person.office, timeZone: person.timeZone, state: person.state,
      since: Math.round((now - person.since) / 1000),
      app: person.state === 'call' ? person.callApp : inUse ? person.app : null,
      activity: atComputer >= 3 ? Math.min(100, Math.round((person.activeSeconds / atComputer) * 100)) : null,
      work: person.work,
      flags: person.flags,
      sample: true
    };
  }

  rows(now) {
    return [...this.people.values()].map(person => this.row(person, now));
  }

  // The detail panel for a made-up person: the same shape the tracker gives for a real one.
  detail(id, now) {
    const person = this.people.get(id);
    if (!person) return null;
    const row = this.row(person, now);
    const blockMs = this.config.block * 1000;
    const blocks = [];
    for (let start = Math.ceil((now - this.config.timelineWindow * 1000) / blockMs) * blockMs; start <= now; start += blockMs) {
      const random = seeded(Math.floor(start / 1000) + person.id.length * 7919 + Number(person.id.slice(7)));
      const busy = person.history.some(part => part.end > start && part.start < start + blockMs && AT_COMPUTER.includes(part.state));
      blocks.push({ start, current: start + blockMs > now, activity: busy ? Math.round(30 + random() * 60) : null, work: random() < 0.35 ? 1 : 0 });
    }
    const manual = ['call', 'meeting', 'break'].includes(person.state)
      ? { kind: person.state, seconds: row.since, endsIn: null, ...(person.state === 'call' && { detected: true, app: person.callApp }) }
      : null;
    return {
      ...row,
      devices: person.state === 'logged_out' || person.flags.includes('stopped') ? [] : [{ label: 'Laptop · Desktop app', tabs: 1, apps: row.app ? [row.app] : [], desktop: true }],
      secondsSinceInput: person.state === 'idle' ? row.since : 1,
      secondsUntilLogout: manual ? null : this.config.idleLogout,
      manual,
      lastWork: person.work ? 'Updated an application' : null,
      lastWorkApp: 'Console',
      apps: person.apps.slice(0, 3).map((name, index) => ({ name, seconds: Math.round(person.totals.working * [0.6, 0.25, 0.15][index]) })),
      noWorkFor: person.flags.includes('noWork') ? 50 * 60 : null,
      tooRegular: person.flags.includes('regular') ? { everyMs: 2000, same: 58, gaps: 60 } : null,
      trackerStopped: person.flags.includes('stopped') ? { since: person.since, device: 'Laptop · Desktop app' } : null,
      logoutReason: person.state === 'logged_out' ? 'signed out' : null,
      lastSeenToday: now,
      totals: { ...person.totals },
      activity: row.activity,
      workCount: person.work,
      blocks,
      segments: person.history.map(part => ({ ...part }))
    };
  }
}

module.exports = { SamplePeople };
