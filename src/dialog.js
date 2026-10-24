import { spawn } from 'node:child_process';

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

function run(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let p;
    try { p = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim() || null); });
  });
}

/** Can a native dialog be shown here? False on a headless Linux box (SSH session, remote dev host, CI). */
export function hasGui() {
  return process.platform !== 'linux' || !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Shows a native "paste your key" dialog. Resolves to the key, or null if cancelled/unavailable. */
export function promptKeyDialog(title, timeoutMs = 5 * 60 * 1000) {
  const label = `Paste your ${title} API key:`;
  if (process.platform === 'win32') {
    const encoded = Buffer.from(windowsScript(title, label), 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], timeoutMs);
  }
  if (process.platform === 'darwin') {
    const script = `text returned of (display dialog "${label}" default answer "" with hidden answer with title "${title}")`;
    return run('osascript', ['-e', script], timeoutMs);
  }
  return run('zenity', ['--entry', '--hide-text', `--title=${title}`, `--text=${label}`], timeoutMs);
}
