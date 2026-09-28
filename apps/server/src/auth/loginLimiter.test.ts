import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LoginLimiter } from './loginLimiter.js';

/** Unit tests with an injected clock — no waiting on real time. */

describe('LoginLimiter', () => {
  it('does not block before reaching 5 failures', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) {
      assert.equal(limiter.isBlocked('k'), false);
      limiter.recordFailure('k');
    }
    assert.equal(limiter.isBlocked('k'), false);
    void now;
  });

  it('blocks after the 5th failure within the window', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 5; i++) limiter.recordFailure('k');
    // The 5th failure itself is recorded; the NEXT attempt is rejected.
    assert.equal(limiter.isBlocked('k'), true);
    // Other clients are unaffected.
    assert.equal(limiter.isBlocked('other'), false);
    void now;
  });

  it('unblocks once the failures fall outside the window', () => {
    let now = 0;
    const limiter = new LoginLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now });
    limiter.recordFailure('k');
    limiter.recordFailure('k');
    assert.equal(limiter.isBlocked('k'), true);
    now += 60_001;
    assert.equal(limiter.isBlocked('k'), false);
  });

  it('clears a client on successful login', () => {
    let now = 0;
    const limiter = new LoginLimiter({ now: () => now });
    for (let i = 0; i < 4; i++) limiter.recordFailure('k');
    limiter.recordSuccess('k');
    assert.equal(limiter.isBlocked('k'), false);
    limiter.recordFailure('k');
    assert.equal(limiter.isBlocked('k'), false);
    void now;
  });

  it('prunes expired failures so the map does not grow forever', () => {
    let now = 0;
    const limiter = new LoginLimiter({ maxFailures: 2, windowMs: 60_000, now: () => now });
    limiter.recordFailure('k');
    now += 60_001;
    limiter.recordFailure('k');
    assert.equal(limiter.isBlocked('k'), false);
  });
});
