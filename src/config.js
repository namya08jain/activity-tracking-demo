// All timings are in seconds. The demo shrinks them a lot so nobody waits during a presentation;
// start the server with MODE=real to use realistic values.
const modes = {
  demo: {
    heartbeat: 2,          // each open tab or desktop app reports how long ago its last input was
    presence: 10,          // input within this window = Active
    work: 30,              // a saved action within this window = Working
    idleLogout: 30,        // no input on any tab or device for this long = logged out everywhere
    warningBefore: 10,     // "Are you still there?" this long before the logout
    noWorkFlag: 20,        // present (mouse/keyboard) but nothing saved for this long = flagged
    deadConnection: 5,     // a silent connection (sleeping laptop, locked phone) is dropped after this
    timelineWindow: 300,   // the manager's timeline shows the last 5 minutes
    block: 30,             // activity % is worked out per block (the bought tools use 10 minutes)
    manualMax: 90,         // "On a call / Meeting / Break" ends by itself after this
    regularWindow: 20,     // the "too regular" check looks at input gaps in this window…
    regularMinGaps: 10,    // …needs at least this many…
    regularMaxVariation: 0.05,  // …and flags them if they vary by 5% or less (a metronome, not a person)
    minCall: 5,            // a detected call shorter than this isn't counted as a work action
    awayPrompt: 30,        // the desktop app asks "what was it?" after being away this long…
    awayLimit: 600,        // …but not after longer than this (that's time off, not a break)…
    awayAnswerWindow: 120, // …and the answer must come within this long of being back
    watchdog: 5            // the desktop app's background service restarts it this long after it's ended
  },
  real: {
    heartbeat: 30,
    presence: 60,
    work: 300,
    idleLogout: 300,
    warningBefore: 60,
    noWorkFlag: 1800,
    deadConnection: 30,
    timelineWindow: 8 * 3600,
    block: 600,
    manualMax: 2 * 3600,
    regularWindow: 1800,
    regularMinGaps: 60,
    regularMaxVariation: 0.05,
    minCall: 20,
    awayPrompt: 600,
    awayLimit: 4 * 3600,
    awayAnswerWindow: 900,
    watchdog: 30
  }
};

const mode = process.env.MODE === 'real' ? 'real' : 'demo';
module.exports = { mode, ...modes[mode] };
