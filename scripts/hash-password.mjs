#!/usr/bin/env node
/**
 * Generate AUTH_PASSWORD_HASH for the .env file.
 *
 * Usage:
 *   node scripts/hash-password.mjs
 *
 * The script prompts for a password (without echoing it), hashes it with
 * scrypt (node:crypto, zero native dependencies) and prints a line you can
 * paste into your .env:
 *
 *   AUTH_PASSWORD_HASH=scrypt$16384$8$1$<saltB64>$<hashB64>
 *
 * The server verifies this format in apps/server/src/auth/password.ts.
 * Never commit the generated hash to git.
 */
import { createInterface } from 'node:readline';
import { randomBytes, scryptSync } from 'node:crypto';

const N = 16384;
const r = 8;
const p = 1;
const KEY_LEN = 64;
const SALT_LEN = 32;

function promptPassword(query) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Hide typed characters.
    const onData = (chunk) => {
      const str = String(chunk);
      if (str === '\n' || str === '\r' || str === '\u0004') return;
      process.stdout.write('\x1b[2K\x1b[200D' + query + '*'.repeat(rl.line.length));
    };
    process.stdin.on('data', onData);
    rl.question(query, (answer) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const password = await promptPassword('New password: ');
if (!password) {
  console.error('Password must not be empty.');
  process.exit(1);
}
const confirm = await promptPassword('Confirm password: ');
if (password !== confirm) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const salt = randomBytes(SALT_LEN);
const hash = scryptSync(password, salt, KEY_LEN, { N, r, p });
const stored = `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;

console.log('\nAdd this line to your .env (keep it secret, never commit it):\n');
console.log(`AUTH_PASSWORD_HASH=${stored}`);
