import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, parseScryptHash, verifyPassword, verifyUsername } from '../auth/password.js';

describe('scrypt password hashing', () => {
  it('hashes and verifies a password', () => {
    const stored = hashPassword('correct-horse');
    assert.match(stored, /^scrypt\$16384\$8\$1\$/);
    assert.equal(verifyPassword('correct-horse', stored), true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct-horse');
    assert.equal(verifyPassword('wrong-password', stored), false);
  });

  it('rejects malformed stored hashes', () => {
    assert.equal(verifyPassword('x', 'not-a-hash'), false);
    assert.equal(verifyPassword('x', 'scrypt$1$2'), false);
    assert.equal(verifyPassword('x', ''), false);
    assert.equal(parseScryptHash('garbage'), null);
  });

  it('produces unique salts', () => {
    const a = hashPassword('same');
    const b = hashPassword('same');
    assert.notEqual(a, b);
    assert.equal(verifyPassword('same', a), true);
    assert.equal(verifyPassword('same', b), true);
  });

  it('username comparison is constant-time and exact', () => {
    assert.equal(verifyUsername('alice', 'alice'), true);
    assert.equal(verifyUsername('alice', 'bob'), false);
    assert.equal(verifyUsername('alice', 'alice '), false);
  });
});
