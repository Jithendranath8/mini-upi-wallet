import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import type { Application } from '../src/container';
import { AuthenticationError, ErrorCategory } from '../src/domain/errors';
import { SessionService } from '../src/service/SessionService';
import { closeApp, createTestApp, freezeClock, fund, PIN, registerUser } from './helpers';

const MINUTE = 60_000;
const SECRET = 'a-test-secret-shared-by-every-app-node';

const authError = (code: string, details?: Record<string, unknown>) => (error: unknown) => {
  assert.ok(error instanceof AuthenticationError, `expected AuthenticationError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.equal(error.category, ErrorCategory.UNAUTHENTICATED);
  if (details) assert.deepEqual(error.details, details);
  return true;
};

/** What a failed attempt looks like to the caller: everything an attacker could tell apart. */
const failureOf = (attempt: () => unknown): { code: string; message: string; category: string; details: unknown } => {
  try {
    attempt();
  } catch (error) {
    assert.ok(error instanceof AuthenticationError, `expected AuthenticationError, got ${String(error)}`);
    return { code: error.code, message: error.message, category: error.category, details: error.details };
  }
  return assert.fail('expected the attempt to be refused');
};

describe('SessionService', () => {
  let app: Application;
  let sessions: SessionService;

  before(async () => {
    app = await createTestApp({ sessionTtlMs: 30 * MINUTE, sessionSecret: SECRET, pinMaxAttempts: 3, pinLockMs: 10 * MINUTE });
    sessions = app.sessions;
  });

  after(() => closeApp(app));

  describe('login', () => {
    test('UPI ID and PIN give a token, its expiry and the user', (t) => {
      freezeClock(t);
      const alice = registerUser(app);

      const session = sessions.login(alice.upiId, PIN);

      assert.equal(session.user.id, alice.id);
      assert.equal(session.expiresAt.getTime(), Date.now() + 30 * MINUTE);
      const [userId, expiry, signature, ...rest] = session.token.split('.');
      assert.deepEqual(rest, []);
      assert.equal(userId, alice.id);
      assert.equal(Number(expiry), session.expiresAt.getTime());
      assert.match(signature, /^[A-Za-z0-9_-]{43}$/, 'an unpadded base64url SHA-256 MAC');
      assert.equal(sessions.verify(session.token), alice.id);
    });

    test('the UPI ID is matched whatever its case or padding', () => {
      const alice = registerUser(app);
      assert.equal(sessions.login(`  ${alice.upiId.toUpperCase()} `, PIN).user.id, alice.id);
    });

    test('the token carries no secret: not the PIN, not the UPI ID', () => {
      const alice = registerUser(app, { pin: '482913' });
      const { token } = sessions.login(alice.upiId, '482913');
      assert.equal(token.includes('482913'), false);
      assert.equal(token.includes(alice.upiId), false);
    });

    test('a wrong, missing or non-string PIN is refused with INVALID_CREDENTIALS', () => {
      const alice = registerUser(app);
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.throws(() => sessions.login(alice.upiId, undefined), authError('INVALID_CREDENTIALS'));
      assert.equal(sessions.login(alice.upiId, PIN).user.id, alice.id, 'the right PIN still works before the limit');
      assert.throws(() => sessions.login(alice.upiId, 1234), authError('INVALID_CREDENTIALS'));
    });

    test('a refused sign-in does not say how many attempts are left (a payment does)', () => {
      const alice = registerUser(app);
      assert.throws(
        () => sessions.login(alice.upiId, '0000'),
        (error: unknown) => {
          assert.ok(error instanceof AuthenticationError);
          assert.equal(error.code, 'INVALID_CREDENTIALS');
          assert.equal(error.details, undefined, 'no attempt counter: it would confirm that the UPI ID exists');
          return true;
        },
      );
      assert.throws(() => app.users.verifyPin(alice, '0000'), authError('INVALID_PIN', { attemptsLeft: 2 }));
    });

    test('wrong PINs at sign-in count towards a lockout: after the limit even the right PIN cannot sign in', (t) => {
      const advance = freezeClock(t);
      const alice = registerUser(app);
      for (let i = 0; i < 3; i += 1) assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));

      assert.throws(() => sessions.login(alice.upiId, PIN), authError('PIN_LOCKED'));
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('PIN_LOCKED'));

      advance(10 * MINUTE);
      assert.equal(sessions.login(alice.upiId, PIN).user.id, alice.id, 'the lock ends after pinLockMs');
    });

    test('a stranger guessing at the sign-in page cannot lock the owner out of paying', () => {
      const alice = registerUser(app);
      for (let i = 0; i < 3; i += 1) assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.throws(() => sessions.login(alice.upiId, PIN), authError('PIN_LOCKED'));

      assert.doesNotThrow(() => app.users.verifyPin(alice, PIN), 'payments count their own wrong PINs');
      assert.throws(() => app.users.verifyPin(alice, '0000'), authError('INVALID_PIN', { attemptsLeft: 2 }));
    });

    test('and the other way round: wrong PINs on payments do not lock sign-in', () => {
      const alice = registerUser(app);
      for (let i = 0; i < 3; i += 1) assert.throws(() => app.users.verifyPin(alice, '0000'), authError('INVALID_PIN'));
      assert.throws(() => app.users.verifyPin(alice, PIN), authError('PIN_LOCKED'));

      assert.equal(sessions.login(alice.upiId, PIN).user.id, alice.id);
      assert.throws(() => app.users.verifyPin(alice, PIN), authError('PIN_LOCKED'), 'signing in does not lift the payment lock');
    });

    test("one account's sign-in lock does not affect anyone else", () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      for (let i = 0; i < 3; i += 1) assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.equal(sessions.login(bob.upiId, PIN).user.id, bob.id);
    });

    test('a successful sign-in resets the counter', () => {
      const alice = registerUser(app);
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      sessions.login(alice.upiId, PIN);
      // Two more wrong PINs would lock the account if the earlier two still counted.
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.throws(() => sessions.login(alice.upiId, '0000'), authError('INVALID_CREDENTIALS'));
      assert.equal(sessions.login(alice.upiId, PIN).user.id, alice.id);
    });

    test('an unknown UPI ID is refused as UNAUTHENTICATED', () => {
      for (const upiId of ['nobody@miniupi', '', '   ', "x' OR '1'='1"]) {
        assert.throws(() => sessions.login(upiId, PIN), authError('INVALID_CREDENTIALS'));
      }
    });

    test('an unknown UPI ID gives the same error as a wrong PIN, so sign-in does not reveal which UPI IDs exist', () => {
      const alice = registerUser(app);

      const unknownUser = failureOf(() => sessions.login('nobody@miniupi', PIN));
      const wrongPin = failureOf(() => sessions.login(alice.upiId, '0000'));

      assert.deepEqual(wrongPin, unknownUser);
      assert.deepEqual(unknownUser, { code: 'INVALID_CREDENTIALS', message: 'UPI ID or PIN is incorrect.', category: 'UNAUTHENTICATED', details: undefined });
    });

    test('unknown UPI IDs can be tried for ever without anything being locked or stored', () => {
      for (let i = 0; i < 10; i += 1) assert.throws(() => sessions.login('nobody@miniupi', '0000'), authError('INVALID_CREDENTIALS'));
      const alice = registerUser(app);
      assert.equal(sessions.login(alice.upiId, PIN).user.id, alice.id);
    });
  });

  describe('verify', () => {
    test('a token stays valid until its expiry, to the millisecond', (t) => {
      const advance = freezeClock(t);
      const alice = registerUser(app);
      const { token } = sessions.login(alice.upiId, PIN);

      advance(30 * MINUTE - 1);
      assert.equal(sessions.verify(token), alice.id);
      advance(1);
      assert.throws(() => sessions.verify(token), authError('TOKEN_EXPIRED'));
      advance(24 * 60 * MINUTE);
      assert.throws(() => sessions.verify(token), authError('TOKEN_EXPIRED'));
    });

    test('a token is not extended by being used, and each sign-in gets its own expiry', (t) => {
      const advance = freezeClock(t);
      const alice = registerUser(app);
      const first = sessions.login(alice.upiId, PIN);
      advance(20 * MINUTE);
      sessions.verify(first.token);
      const second = sessions.login(alice.upiId, PIN);
      advance(10 * MINUTE);

      assert.throws(() => sessions.verify(first.token), authError('TOKEN_EXPIRED'));
      assert.equal(sessions.verify(second.token), alice.id);
      assert.notEqual(first.token, second.token);
    });

    test('a tampered token is refused: another user id, a later expiry, or a changed signature', () => {
      const alice = registerUser(app);
      const mallory = registerUser(app);
      const { token } = sessions.login(mallory.upiId, PIN);
      const [userId, expiry, signature] = token.split('.');
      const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');

      const forgeries = [
        `${alice.id}.${expiry}.${signature}`, //                     impersonation
        `${userId}.${Number(expiry) + 24 * 60 * MINUTE}.${signature}`, //  a longer life
        `${userId}.${expiry}.${flipped}`,
        `${userId}.${expiry}.`,
        `${userId}.${expiry}.${signature}x`,
        `${userId}.${expiry}.${signature.toUpperCase()}`,
      ];
      for (const forged of forgeries) {
        assert.throws(() => sessions.verify(forged), authError('INVALID_TOKEN'), forged);
      }
      assert.equal(sessions.verify(token), mallory.id, 'the untouched token is still good');
    });

    test('a token signed with the wrong secret, or with a different algorithm, is refused', () => {
      const alice = registerUser(app);
      const body = `${alice.id}.${Date.now() + 30 * MINUTE}`;
      const sign = (secret: string, algorithm: string) => createHmac(algorithm, secret).update(body).digest('base64url');

      assert.equal(sessions.verify(`${body}.${sign(SECRET, 'sha256')}`), alice.id, 'the scheme is HMAC-SHA256 over "<userId>.<expiry>"');
      assert.throws(() => sessions.verify(`${body}.${sign('guessed-secret', 'sha256')}`), authError('INVALID_TOKEN'));
      assert.throws(() => sessions.verify(`${body}.${sign(SECRET, 'sha1')}`), authError('INVALID_TOKEN'));
      assert.throws(() => sessions.verify(`${body}.${sign('', 'sha256')}`), authError('INVALID_TOKEN'));
    });

    test('anything that is not three dot-separated parts is refused', () => {
      for (const garbage of ['', 'not-a-token', 'a.b', 'a.b.c.d', '..', 'usr_1', 'Bearer x.y.z extra.dots.here.too']) {
        assert.throws(() => sessions.verify(garbage), authError('INVALID_TOKEN'), JSON.stringify(garbage));
      }
    });

    test('a correctly signed token whose expiry is not a number is refused', () => {
      const body = 'usr_whoever.never';
      const signature = createHmac('sha256', SECRET).update(body).digest('base64url');
      assert.throws(() => sessions.verify(`${body}.${signature}`), authError('TOKEN_EXPIRED'));
    });
  });

  describe('statelessness', () => {
    test('any node holding the same secret verifies a token without a session store', () => {
      const alice = registerUser(app);
      const { token } = sessions.login(alice.upiId, PIN);

      const otherNode = new SessionService(app.users, 30 * MINUTE, SECRET);
      assert.equal(otherNode.verify(token), alice.id);
      assert.equal(sessions.verify(otherNode.login(alice.upiId, PIN).token), alice.id);
    });

    test('a node with a different secret refuses it', () => {
      const alice = registerUser(app);
      const { token } = sessions.login(alice.upiId, PIN);
      assert.throws(() => new SessionService(app.users, 30 * MINUTE, 'another-secret').verify(token), authError('INVALID_TOKEN'));
    });

    test('without a configured secret each instance invents its own: tokens die with the process', () => {
      const alice = registerUser(app);
      const first = new SessionService(app.users, 30 * MINUTE);
      const second = new SessionService(app.users, 30 * MINUTE);
      const { token } = first.login(alice.upiId, PIN);
      assert.equal(first.verify(token), alice.id);
      assert.throws(() => second.verify(token), authError('INVALID_TOKEN'));
    });

    test('the session lifetime comes from the configuration', (t) => {
      const advance = freezeClock(t);
      const alice = registerUser(app);
      const shortLived = new SessionService(app.users, 1_000, SECRET);
      const session = shortLived.login(alice.upiId, PIN);
      assert.equal(session.expiresAt.getTime() - Date.now(), 1_000);
      advance(1_000);
      assert.throws(() => shortLived.verify(session.token), authError('TOKEN_EXPIRED'));
    });

    test('a token only says who the caller is: what they may do is still checked on every request', async () => {
      const alice = registerUser(app);
      const bob = registerUser(app);
      await fund(app, alice, 100);
      const { token } = sessions.login(alice.upiId, PIN);

      const userId = sessions.verify(token);
      assert.equal(app.users.authenticate(userId).id, alice.id);
      assert.equal(app.users.walletOf(userId).balance.paise, 10_000);
      assert.notEqual(userId, bob.id);
    });
  });
});
