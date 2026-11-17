import type { Request } from 'express';
import { ValidationError } from '../domain/errors';
import { Money } from '../domain/Money';

/**
 * Request parsing: turns untrusted JSON into typed values or throws a 400.
 * Controllers call these first, so services only ever see well-formed input.
 */

type Body = Record<string, unknown>;

const MAX_AMOUNT_RUPEES = 1_000_000;

export function bodyOf(req: Request): Body {
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('INVALID_BODY', 'Request body must be a JSON object.');
  }
  return body as Body;
}

export function requiredString(body: Body, field: string, maxLength = 200): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, { field });
  }
  if (value.length > maxLength) {
    throw new ValidationError('FIELD_TOO_LONG', `"${field}" can be at most ${maxLength} characters.`, { field });
  }
  return value.trim();
}

export function optionalString(body: Body, field: string, maxLength = 200): string | undefined {
  const value = body[field];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError('INVALID_FIELD', `"${field}" must be text.`, { field });
  }
  if (value.length > maxLength) {
    throw new ValidationError('FIELD_TOO_LONG', `"${field}" can be at most ${maxLength} characters.`, { field });
  }
  return value.trim();
}

export function optionalNumber(body: Body, field: string): number | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError('INVALID_FIELD', `"${field}" must be a number.`, { field });
  }
  return value;
}

export function requiredNumber(body: Body, field: string): number {
  const value = optionalNumber(body, field);
  if (value === undefined) throw new ValidationError('MISSING_FIELD', `"${field}" is required.`, { field });
  return value;
}

/** Amount in rupees: a JSON number, greater than zero, at most two decimals, within a sane ceiling. */
export function amountOf(body: Body, field = 'amount'): Money {
  // Preferred: `amountPaise`, a whole number, which cannot suffer from floating point.
  // `amount` in rupees is accepted for convenience and must have at most two decimals.
  if (body.amountPaise !== undefined) {
    const paise = body.amountPaise;
    if (typeof paise !== 'number' || !Number.isSafeInteger(paise) || paise <= 0) {
      throw new ValidationError('INVALID_AMOUNT', '"amountPaise" must be a whole number greater than zero.', {
        field: 'amountPaise',
      });
    }
    if (paise > MAX_AMOUNT_RUPEES * 100) {
      throw new ValidationError('INVALID_AMOUNT', `Amount cannot exceed ₹${MAX_AMOUNT_RUPEES.toLocaleString('en-IN')}.`, {
        field: 'amountPaise',
      });
    }
    return Money.ofPaise(paise);
  }
  const rupees = requiredNumber(body, field);
  if (rupees <= 0) {
    throw new ValidationError('INVALID_AMOUNT', 'Amount must be greater than zero.', { field });
  }
  if (rupees > MAX_AMOUNT_RUPEES) {
    throw new ValidationError('INVALID_AMOUNT', `Amount cannot exceed ₹${MAX_AMOUNT_RUPEES.toLocaleString('en-IN')}.`, { field });
  }
  return Money.fromRupees(rupees);
}

/** `?limit=` clamped to a safe range. */
export function limitOf(req: Request, fallback = 20, max = 100): number {
  const raw = req.query.limit;
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError('INVALID_LIMIT', '"limit" must be a positive whole number.');
  }
  return Math.min(limit, max);
}

/**
 * Free text that will be shown to other people (names, notes, bank names). Control characters,
 * invisible direction overrides and angle brackets are refused: they have no place in a name
 * and are the raw material of spoofing and markup injection.
 */
export function plainText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (/[\p{Cc}\p{Cf}<>]/u.test(value)) {
    throw new ValidationError('INVALID_FIELD', `"${field}" contains characters that are not allowed.`, { field });
  }
  return value;
}
