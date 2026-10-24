import { spawn, spawnSync } from 'node:child_process';

const windowsScript = (title, label) => `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object System.Windows.Forms.Form
$f.Text = '${title}'
$f.Size = New-Object System.Drawing.Size(460, 170)
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true
$l = New-Object System.Windows.Forms.Label
$l.Text = '${label}'
$l.Location = New-Object System.Drawing.Point(15, 15)
$l.AutoSize = $true
$t = New-Object System.Windows.Forms.TextBox
$t.Location = New-Object System.Drawing.Point(15, 45)
$t.Size = New-Object System.Drawing.Size(415, 24)
$t.UseSystemPasswordChar = $true
$ok = New-Object System.Windows.Forms.Button
$ok.Text = 'Save'
$ok.Location = New-Object System.Drawing.Point(270, 85)
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.Location = New-Object System.Drawing.Point(355, 85)
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$f.AcceptButton = $ok
$f.CancelButton = $cancel
$f.Controls.AddRange(@($l, $t, $ok, $cancel))
$f.Add_Shown({ $f.Activate(); $t.Focus() })
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($t.Text) }
`;

const defaults = { platform: process.platform, env: process.env, spawn, spawnSync };

function run(command, args, timeoutMs, deps = defaults) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = deps.spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim() || null); }); // cancelling a dialog prints nothing
  });
}

// Linux dialog programs, in order of preference. The first one that is installed is used.
const LINUX_TOOLS = [
  { command: 'zenity', args: (title, label) => ['--entry', '--hide-text', `--title=${title}`, `--text=${label}`] },
  { command: 'kdialog', args: (title, label) => ['--password', label, '--title', title] },
  { command: 'yad', args: (title, label) => ['--entry', '--hide-text', `--title=${title}`, `--text=${label}`] },
];
const toolCache = new Map();

function findLinuxTool(deps) {
  const key = `${deps.platform}:${deps.env.PATH ?? ''}`;
  if (!toolCache.has(key) || deps !== defaults) {
    const found = LINUX_TOOLS.find((t) => {
      const r = deps.spawnSync(t.command, ['--version'], { stdio: 'ignore', timeout: 3000 });
      return !r.error && r.status === 0;
    }) ?? null;
    if (deps === defaults) toolCache.set(key, found); else return found;
  }
  return toolCache.get(key);
}

const appleScriptString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The program and arguments that show the dialog on this machine, or null when none can be shown. */
export function dialogCommand(title, deps = defaults) {
  const label = `Paste your ${title} API key:`;
  if (deps.env.SSH_CONNECTION || deps.env.SSH_TTY) return null; // nobody is at this machine's screen
  if (deps.platform === 'win32') {
    const encoded = Buffer.from(windowsScript(title, label), 'utf16le').toString('base64');
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded] };
  }
  if (deps.platform === 'darwin') {
    return { command: 'osascript', args: ['-e', `text returned of (display dialog ${appleScriptString(label)} default answer "" with hidden answer with title ${appleScriptString(title)})`] };
  }
  if (!(deps.env.DISPLAY || deps.env.WAYLAND_DISPLAY)) return null; // headless: no display to draw on
  const tool = findLinuxTool(deps);
  return tool ? { command: tool.command, args: tool.args(title, label) } : null;
}

/** Can a native dialog be shown here? False on a headless Linux box, a remote host, or one with no dialog program. */
export function hasGui(deps = defaults) {
  return dialogCommand('x', deps) !== null;
}

/** Shows a native "paste your key" dialog. Resolves to the key, or null if cancelled or unavailable. */
export function promptKeyDialog(title, timeoutMs = 5 * 60 * 1000, deps = defaults) {
  const cmd = dialogCommand(title, deps);
  return cmd ? run(cmd.command, cmd.args, timeoutMs, deps) : Promise.resolve(null);
}
