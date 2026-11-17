import { ErrorCategory } from '../domain/errors';

/**
 * The one place that knows how a kind of failure is presented over HTTP.
 * The domain speaks in categories; this table translates them.
 */
const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  [ErrorCategory.INVALID_INPUT]: 400,
  [ErrorCategory.UNAUTHENTICATED]: 401,
  [ErrorCategory.DECLINED]: 402,
  [ErrorCategory.FORBIDDEN]: 403,
  [ErrorCategory.NOT_FOUND]: 404,
  [ErrorCategory.CONFLICT]: 409,
  [ErrorCategory.RULE_VIOLATION]: 422,
  [ErrorCategory.RATE_LIMITED]: 429,
  [ErrorCategory.INTERNAL]: 500,
  [ErrorCategory.UNAVAILABLE]: 503,
};

export function statusFor(category: ErrorCategory): number {
  return STATUS_BY_CATEGORY[category] ?? 500;
}
