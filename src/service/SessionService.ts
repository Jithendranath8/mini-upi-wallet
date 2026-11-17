import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthenticationError } from '../domain/errors';
import type { User } from '../domain/User';
import type { UserService } from './UserService';

export interface Session {
  token: string;
  expiresAt: Date;
  user: User;
}

/**
 * Sign-in and session tokens.
 *
 * A token is `<userId>.<expiry>.<signature>`, where the signature is an HMAC-SHA256 over the
 * first two parts with a server-side secret. It is stateless: any app node holding the secret
 * can verify it without a session store, which is what keeps the app tier horizontally
 * scalable. (Same idea as a JWT, without the header and claims format.)
 */
export class SessionService {
  readonly #secret: Buffer;

  constructor(
    private readonly users: UserService,
    private readonly ttlMs: number,
    secret?: string,
  ) {
    // Without a configured secret, tokens are valid only until this process restarts.
    this.#secret = secret ? Buffer.from(secret) : randomBytes(32);
  }

  /** UPI ID + PIN -> token. The PIN lockout of UserService applies to sign-in too. */
  login(upiId: string, pin: unknown): Session {
    const user = this.users.findByUpiId(upiId);
    if (!user) {
      // Same answer as a wrong PIN: never reveal which UPI IDs exist.
      throw new AuthenticationError('INVALID_CREDENTIALS', 'UPI ID or PIN is incorrect.');
    }
    try {
      this.users.verifyPin(user, pin, 'sign-in');
    } catch (error) {
      // A wrong PIN and an unknown UPI ID must look identical from outside (a lockout may say so).
      if (error instanceof AuthenticationError && error.code === 'INVALID_PIN') {
        throw new AuthenticationError('INVALID_CREDENTIALS', 'UPI ID or PIN is incorrect.');
      }
      throw error;
    }
    const expiresAt = new Date(Date.now() + this.ttlMs);
    const body = `${user.id}.${expiresAt.getTime()}`;
    return { token: `${body}.${this.sign(body)}`, expiresAt, user };
  }

  /** Returns the user id the token was issued for, or throws. */
  verify(token: string): string {
    const parts = token.split('.');
    if (parts.length !== 3) throw new AuthenticationError('INVALID_TOKEN', 'Session token is not valid.');
    const [userId, expiry, signature] = parts;
    const expected = Buffer.from(this.sign(`${userId}.${expiry}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AuthenticationError('INVALID_TOKEN', 'Session token is not valid.');
    }
    if (!(Number(expiry) > Date.now())) {
      throw new AuthenticationError('TOKEN_EXPIRED', 'Your session has expired. Sign in again.');
    }
    return userId;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.#secret).update(body).digest('base64url');
  }
}
