// Real macOS Keychain round trip through the `security` tool. Only runs when ACP_TEST_KEYCHAIN=1 on a Mac with an
// unlocked default keychain (the CI "keychain" job sets one up). Everywhere else it reports a skip and passes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpDir } from './helpers.js';

if (process.env.ACP_TEST_KEYCHAIN !== '1') {
  console.log('keychain skipped (set ACP_TEST_KEYCHAIN=1 on a Mac with an unlocked default keychain)');
  process.exit(0);
}

const home = tmpDir();
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.ANONROUTER_API_KEY;
delete process.env.ACP_KEY_STORAGE;
const { chooseBackend } = await import('../src/keystore.js');
const { saveApiKey, loadApiKey, isKeyProtected, credentialsPath } = await import('../src/credentials.js');
const { anonrouter } = await import('../src/providers/anonrouter.js');

const security = (...args) => spawnSync('security', args, { encoding: 'utf8' });
const lookup = () => security('find-generic-password', '-s', 'incognito-acp', '-a', 'anonrouter', '-w').stdout.replace(/\r?\n$/, '');
const clear = () => security('delete-generic-password', '-s', 'incognito-acp', '-a', 'anonrouter');

// Raw output of the exact commands the agent relies on, so a failure on a new machine shows why.
{
  const probe = spawnSync('security', ['-i'], { input: 'add-generic-password -U -s "incognito-acp-probe" -a "probe" -w "probe-secret-123"\n', encoding: 'utf8' });
  console.log('probe add:', JSON.stringify({ status: probe.status, stdout: probe.stdout, stderr: probe.stderr }));
  const found = spawnSync('security', ['find-generic-password', '-s', 'incognito-acp-probe', '-a', 'probe', '-w'], { encoding: 'utf8' });
  console.log('probe find:', JSON.stringify({ status: found.status, stdout: found.stdout, stderr: found.stderr }));
  spawnSync('security', ['delete-generic-password', '-s', 'incognito-acp-probe', '-a', 'probe']);
}

try {
  assert.equal(chooseBackend(), 'keychain', 'the Keychain should be chosen on macOS');

  // Save: the key lives in the Keychain and the file holds only a marker.
  const key1 = 'ar_KeychainRoundTrip1234567890abc';
  const file = saveApiKey(anonrouter, key1);
  assert.equal(isKeyProtected(anonrouter), true, 'key was not stored in the Keychain');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('KeychainRoundTrip'), 'plaintext key on disk');
  assert.equal(lookup(), key1);
  assert.equal(loadApiKey(anonrouter), key1);

  // Saving again replaces the stored key (-U updates in place).
  const key2 = 'ar_KeychainReplacement1234567890a';
  saveApiKey(anonrouter, key2);
  assert.equal(loadApiKey(anonrouter), key2);
  assert.equal(lookup(), key2);

  // A key with characters that need quoting survives the trip through `security -i`.
  const odd = 'ar_odd"quote\\back slash_1234567890';
  saveApiKey(anonrouter, odd);
  assert.equal(loadApiKey(anonrouter), odd);

  // A plaintext file from an older version is moved into the Keychain on first read.
  clear();
  fs.writeFileSync(credentialsPath(anonrouter), JSON.stringify({ apiKey: 'ar_OldPlaintextKey1234567890ab' }));
  assert.equal(loadApiKey(anonrouter), 'ar_OldPlaintextKey1234567890ab');
  assert.equal(isKeyProtected(anonrouter), true, 'plaintext file was not migrated');
  assert.ok(!fs.readFileSync(credentialsPath(anonrouter), 'utf8').includes('OldPlaintext'));
  assert.equal(lookup(), 'ar_OldPlaintextKey1234567890ab');

  // If the Keychain item disappears, the key reads as missing (the user is asked again) instead of throwing.
  clear();
  fs.utimesSync(credentialsPath(anonrouter), new Date(), new Date(Date.now() + 5000)); // invalidate the in-process cache
  assert.equal(loadApiKey(anonrouter), null);
  console.log('keychain OK');
} finally {
  clear();
}
