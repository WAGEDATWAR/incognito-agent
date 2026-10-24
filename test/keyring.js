// Real keyring round trip (Linux, libsecret's `secret-tool`). Only runs when ACP_TEST_KEYRING=1, inside a session that has
// a running keyring; the CI "keyring" job sets that up. Everywhere else it reports a skip and passes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { tmpDir } from './helpers.js';

if (process.env.ACP_TEST_KEYRING !== '1') {
  console.log('keyring skipped (set ACP_TEST_KEYRING=1 inside a session with a running keyring)');
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

const lookup = () => spawnSync('secret-tool', ['lookup', 'service', 'incognito-acp', 'provider', 'anonrouter'], { encoding: 'utf8' }).stdout;
const clear = () => spawnSync('secret-tool', ['clear', 'service', 'incognito-acp', 'provider', 'anonrouter']);

try {
  assert.equal(chooseBackend(), 'secret-tool', 'secret-tool should be chosen where it is installed');

  // Save: the key lives in the keyring and the file holds only a marker.
  const key1 = 'ar_KeyringRoundTrip1234567890abcd';
  const file = saveApiKey(anonrouter, key1);
  assert.equal(isKeyProtected(anonrouter), true, 'key was not stored in the keyring');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('KeyringRoundTrip'), 'plaintext key on disk');
  assert.equal(lookup(), key1);
  assert.equal(loadApiKey(anonrouter), key1);

  // Saving again replaces the stored key.
  const key2 = 'ar_KeyringReplacement1234567890ab';
  saveApiKey(anonrouter, key2);
  assert.equal(loadApiKey(anonrouter), key2);
  assert.equal(lookup(), key2);

  // A plaintext file from an older version is moved into the keyring on first read.
  clear();
  fs.writeFileSync(credentialsPath(anonrouter), JSON.stringify({ apiKey: 'ar_OldPlaintextKey1234567890ab' }));
  assert.equal(loadApiKey(anonrouter), 'ar_OldPlaintextKey1234567890ab');
  assert.equal(isKeyProtected(anonrouter), true, 'plaintext file was not migrated');
  assert.ok(!fs.readFileSync(credentialsPath(anonrouter), 'utf8').includes('OldPlaintext'));
  assert.equal(lookup(), 'ar_OldPlaintextKey1234567890ab');

  // If the keyring entry disappears, the key reads as missing (the user is asked again) instead of throwing.
  clear();
  fs.utimesSync(credentialsPath(anonrouter), new Date(), new Date(Date.now() + 5000)); // invalidate the in-process cache
  assert.equal(loadApiKey(anonrouter), null);
  console.log('keyring OK');
} finally {
  clear();
}
