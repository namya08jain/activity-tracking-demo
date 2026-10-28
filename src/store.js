// Saves the daily records to a JSON file so history survives a restart. A real rollout would use Crizac's own
// database instead; the demo keeps it to one small file with no extra installs.
const fs = require('node:fs');
const path = require('node:path');

function load(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read ${file} (${error.message}); starting with no history.`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    // Keep the unreadable file for inspection rather than overwriting it on the next save.
    const aside = `${file}.unreadable-${Date.now()}`;
    fs.renameSync(file, aside);
    console.warn(`${file} could not be read; moved it to ${aside} and started with no history.`);
    return {};
  }
}

// Writes to a temporary file first, then swaps it in, so a crash mid-save can't leave a half-written file.
function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data));
  fs.renameSync(temporary, file);
}

module.exports = { load, save };
