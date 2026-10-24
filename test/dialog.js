// The paste-your-key dialog on each platform: which program is run, when none can be shown, and how results are read.
// Commands are checked with stand-ins, since a CI machine has no one to click a dialog.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { dialogCommand, hasGui, promptKeyDialog } from '../src/dialog.js';

const installed = (...names) => (cmd) => (names.includes(cmd) ? { status: 0 } : { status: null, error: new Error('ENOENT') });
const deps = (platform, env = {}, tools = []) => ({ platform, env, spawn: () => { throw new Error('not used'); }, spawnSync: installed(...tools) });

// ---- Windows: a PowerShell password box, passed as an encoded script (no key or quoting ever on a command line) ----
{
  const c = dialogCommand('Venice', deps('win32'));
  assert.equal(c.command, 'powershell.exe');
  assert.ok(c.args.includes('-STA') && c.args.includes('-NonInteractive') && c.args.includes('-EncodedCommand'));
  const script = Buffer.from(c.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Paste your Venice API key:/);
  assert.match(script, /UseSystemPasswordChar = \$true/);
  assert.match(script, /TopMost = \$true/);
  if (process.platform === 'win32') {
    // On a Windows machine, also confirm PowerShell itself accepts the script.
    const check = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT,[ref]$t,[ref]$e); if($e){$e|%{$_.Message};exit 1}'],
    { encoding: 'utf8', env: { ...process.env, SCRIPT: script } });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
  assert.equal(hasGui(deps('win32')), true);
}

// ---- macOS: osascript with a hidden-answer dialog; quoting is escaped ----
{
  const c = dialogCommand('Anonrouter', deps('darwin'));
  assert.equal(c.command, 'osascript');
  assert.deepEqual(c.args.slice(0, 1), ['-e']);
  assert.equal(c.args[1], 'text returned of (display dialog "Paste your Anonrouter API key:" default answer "" with hidden answer with title "Anonrouter")');
  const tricky = dialogCommand('Evil" & do shell script "x', deps('darwin'));
  assert.ok(!/title "Evil" &/.test(tricky.args[1]), 'a quote in the title broke out of the AppleScript string');
  assert.equal(hasGui(deps('darwin')), true);
}

// ---- Linux: zenity, else kdialog, else yad; nothing without a display or an installed program ----
{
  const env = { DISPLAY: ':0' };
  const z = dialogCommand('Venice', deps('linux', env, ['zenity', 'kdialog']));
  assert.equal(z.command, 'zenity');
  assert.deepEqual(z.args, ['--entry', '--hide-text', '--title=Venice', '--text=Paste your Venice API key:']);
  const k = dialogCommand('Venice', deps('linux', env, ['kdialog']));
  assert.deepEqual([k.command, ...k.args], ['kdialog', '--password', 'Paste your Venice API key:', '--title', 'Venice']);
  assert.equal(dialogCommand('Venice', deps('linux', env, ['yad'])).command, 'yad');
  assert.equal(dialogCommand('Venice', deps('linux', env, [])), null, 'no dialog program installed');
  assert.equal(dialogCommand('Venice', deps('linux', {}, ['zenity'])), null, 'no display');
  assert.equal(dialogCommand('Venice', deps('linux', { WAYLAND_DISPLAY: 'wayland-0' }, ['zenity'])).command, 'zenity');
  assert.equal(hasGui(deps('linux', env, [])), false);
  assert.equal(hasGui(deps('linux', env, ['zenity'])), true);
}

// ---- remote sessions never show a dialog, on any platform ----
for (const platform of ['win32', 'darwin', 'linux']) {
  assert.equal(hasGui(deps(platform, { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22', DISPLAY: ':0' }, ['zenity'])), false, platform);
}

// ---- reading the result: the typed key, nothing on cancel, nothing when the program is missing, and a timeout ----
{
  const fake = (behave) => ({ ...deps('darwin'), spawn: (cmd, args) => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.kill = () => p.emit('close');
    setImmediate(() => behave(p, cmd, args));
    return p;
  } });
  assert.equal(await promptKeyDialog('Venice', 1000, fake((p) => { p.stdout.emit('data', 'sk-typed-key\n'); p.emit('close'); })), 'sk-typed-key');
  assert.equal(await promptKeyDialog('Venice', 1000, fake((p) => p.emit('close'))), null, 'cancel prints nothing');
  assert.equal(await promptKeyDialog('Venice', 1000, fake((p) => p.emit('error', new Error('ENOENT')))), null);
  assert.equal(await promptKeyDialog('Venice', 1000, { ...deps('darwin'), spawn: () => { throw new Error('boom'); } }), null);
  const started = Date.now();
  assert.equal(await promptKeyDialog('Venice', 50, fake(() => { /* never answers */ })), null);
  assert.ok(Date.now() - started < 2000, 'timeout did not stop the dialog');
  assert.equal(await promptKeyDialog('Venice', 1000, deps('linux', {}, ['zenity'])), null, 'no display: resolves without running anything');
}

console.log('dialog OK');
