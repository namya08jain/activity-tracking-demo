// What the desktop app may report about the program in front. The laptop sends the program's file name
// ("ms-teams.exe"); the server turns it into a short name from this fixed list, and anything else counts as
// "Other app". So a tampered desktop app can't invent names, and window titles never leave the laptop.
const DESKTOP_APPS = {
  'chrome.exe': 'Chrome', 'msedge.exe': 'Edge', 'brave.exe': 'Brave', 'firefox.exe': 'Firefox', 'opera.exe': 'Opera',
  'ms-teams.exe': 'Teams', 'teams.exe': 'Teams', 'zoom.exe': 'Zoom', 'whatsapp.exe': 'WhatsApp', 'whatsapp.root.exe': 'WhatsApp',
  'slack.exe': 'Slack', 'webex.exe': 'Webex', 'ciscocollabhost.exe': 'Webex', 'skype.exe': 'Skype', 'discord.exe': 'Discord',
  'outlook.exe': 'Outlook', 'olk.exe': 'Outlook', 'excel.exe': 'Excel', 'winword.exe': 'Word', 'powerpnt.exe': 'PowerPoint',
  'onenote.exe': 'OneNote', 'explorer.exe': 'File Explorer', 'acrobat.exe': 'Acrobat', 'acrord32.exe': 'Acrobat',
  'notepad.exe': 'Notepad', 'crizacactivity.exe': 'Crizac Activity',
  // The Windows desktop itself (nothing open, or a click on the wallpaper). Windows runs it inside explorer.exe,
  // so the desktop app reports it under this name instead.
  'desktop': 'Desktop'
};
const OTHER_APP = 'Other app';
const BROWSERS = new Set(['Chrome', 'Edge', 'Brave', 'Firefox', 'Opera']);
// Programs whose use of the microphone means a call. A browser using the mic is most likely Meet or Teams on the web.
const CALL_APPS = new Set(['Teams', 'Zoom', 'WhatsApp', 'Slack', 'Webex', 'Skype', 'Discord', ...BROWSERS]);
// Websites the desktop app recognises from the window title on the laptop itself. Only these names are sent.
const SITES = new Set(['Console', 'TMS', 'University portal']);
const DESKTOP_APP_NAMES = new Set([...Object.values(DESKTOP_APPS), OTHER_APP, ...SITES]);

function desktopApp(fileName) {
  const key = String(fileName ?? '').toLowerCase().slice(0, 64);
  return Object.hasOwn(DESKTOP_APPS, key) ? DESKTOP_APPS[key] : OTHER_APP;
}

// The name time is credited to: a recognised website when a browser is in front, otherwise the program.
function desktopActivity(fileName, site) {
  const app = desktopApp(fileName);
  return BROWSERS.has(app) && SITES.has(site) ? site : app;
}

// The call app using the microphone, or null. `micApps` = file names of the programs using it right now.
function callApp(micApps) {
  if (!Array.isArray(micApps)) return null;
  for (const fileName of micApps.slice(0, 10)) {
    const app = desktopApp(fileName);
    if (CALL_APPS.has(app)) return app;
  }
  return null;
}

module.exports = { DESKTOP_APP_NAMES, desktopApp, desktopActivity, callApp };
