import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * UPI PINs are never stored. We keep a salted scrypt hash and compare in constant time.
 * The work factor is deliberately small for the prototype so concurrency demos stay snappy.
 */
export class PinHasher {
  private static readonly KEY_LENGTH = 32;
  private static readonly WORK_FACTOR = { N: 1024, r: 8, p: 1 };

  static hash(pin: string): { hash: string; salt: string } {
    const salt = randomBytes(16).toString('hex');
    return { hash: PinHasher.derive(pin, salt), salt };
  }

  static verify(pin: string, hash: string, salt: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = Buffer.from(PinHasher.derive(pin, salt), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private static derive(pin: string, salt: string): string {
    return scryptSync(pin, salt, PinHasher.KEY_LENGTH, PinHasher.WORK_FACTOR).toString('hex');
  }
}
