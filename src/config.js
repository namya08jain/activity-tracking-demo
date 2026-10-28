// All timings are in seconds. The demo shrinks them so a call doesn't wait 5 minutes for a logout;
// start the server with MODE=real to use realistic values.
const modes = {
  demo: {
    heartbeat: 5,          // each open tab reports how long ago its last input was
    presence: 20,          // input within this window = Active
    work: 60,              // a saved action within this window = Working
    idleLogout: 60,        // no input on any tab or device for this long = logged out everywhere
    warningBefore: 20,     // "Are you still there?" this long before the logout
    noWorkFlag: 45,        // present (mouse/keyboard) but nothing saved for this long = flagged
    deadConnection: 10,    // a silent connection (sleeping laptop, locked phone) is dropped after this
    timelineWindow: 600,   // the manager's timeline shows the last 10 minutes
    block: 60,             // activity % is worked out per block (the bought tools use 10 minutes)
    manualMax: 180,        // "On a call / Meeting / Break" ends by itself after this
    regularWindow: 60,     // the "too regular" check looks at input gaps in this window…
    regularMinGaps: 15,    // …needs at least this many…
    regularMaxVariation: 0.05  // …and flags them if they vary by 5% or less (a metronome, not a person)
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
    regularMaxVariation: 0.05
  }
};

const mode = process.env.MODE === 'real' ? 'real' : 'demo';
module.exports = { mode, ...modes[mode] };
