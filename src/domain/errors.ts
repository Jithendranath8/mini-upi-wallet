/**
 * What kind of failure this is, in the domain's own words. The domain knows nothing about
 * HTTP: the API layer decides how each category is presented (see `src/api/httpStatus.ts`).
 */
export enum ErrorCategory {
  INVALID_INPUT = 'INVALID_INPUT',
  UNAUTHENTICATED = 'UNAUTHENTICATED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RULE_VIOLATION = 'RULE_VIOLATION',
  DECLINED = 'DECLINED',
  RATE_LIMITED = 'RATE_LIMITED',
  UNAVAILABLE = 'UNAVAILABLE',
  /** Not a DomainError at all: an unexpected fault on our side. */
  INTERNAL = 'INTERNAL',
}

/**
 * Error hierarchy. Every failure the system can explain to a client is a DomainError
 * carrying a stable machine-readable `code` and a `category`.
 * Anything that is NOT a DomainError is a bug.
 */
export abstract class DomainError extends Error {
  abstract readonly category: ErrorCategory;

  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request itself is malformed. */
export class ValidationError extends DomainError {
  readonly category = ErrorCategory.INVALID_INPUT;
}

/** The caller could not be identified, or the UPI PIN is wrong. */
export class AuthenticationError extends DomainError {
  readonly category = ErrorCategory.UNAUTHENTICATED;
}

/** The caller is identified but not allowed to do this. */
export class ForbiddenError extends DomainError {
  readonly category = ErrorCategory.FORBIDDEN;
}

/** A referenced resource does not exist. */
export class NotFoundError extends DomainError {
  readonly category = ErrorCategory.NOT_FOUND;
}

/** The request conflicts with the current state of a resource. */
export class ConflictError extends DomainError {
  readonly category = ErrorCategory.CONFLICT;
}

/** The request is well-formed but breaks a business rule. */
export class BusinessRuleError extends DomainError {
  readonly category = ErrorCategory.RULE_VIOLATION;
}

/** Too many requests from this client. */
export class RateLimitExceededError extends DomainError {
  readonly category = ErrorCategory.RATE_LIMITED;
  constructor(readonly retryAfterMs: number) {
    super('RATE_LIMIT_EXCEEDED', 'Too many requests. Slow down and retry shortly.', { retryAfterMs });
  }
}

/** A dependency is temporarily unable to serve the request. */
export class ServiceUnavailableError extends DomainError {
  readonly category = ErrorCategory.UNAVAILABLE;
}

// ---- Specific business failures -------------------------------------------------

export class InsufficientBalanceError extends BusinessRuleError {
  constructor(availablePaise: number, requiredPaise: number) {
    super('INSUFFICIENT_BALANCE', 'Wallet balance is too low for this payment.', {
      availablePaise,
      requiredPaise,
    });
  }
}

export class DailyLimitExceededError extends BusinessRuleError {
  constructor(limitPaise: number, spentPaise: number, requestedPaise: number) {
    super('DAILY_LIMIT_EXCEEDED', 'This payment would exceed your daily transfer limit.', {
      limitPaise,
      spentPaise,
      requestedPaise,
    });
  }
}

/** A fraud rule refused the payment: the caller is not allowed to make it. */
export class FraudSuspectedError extends ForbiddenError {
  constructor(rule: string, reason: string) {
    super('FRAUD_SUSPECTED', reason, { rule });
  }
}

export class IllegalStateTransitionError extends ConflictError {
  constructor(from: string, to: string) {
    super('ILLEGAL_STATE_TRANSITION', `A ${from} transaction cannot move to ${to}.`, { from, to });
  }
}

/** Optimistic lock failure: someone else changed the row since we read it. */
export class OptimisticLockError extends ConflictError {
  constructor(entity: string, id: string) {
    super('CONCURRENT_MODIFICATION', `${entity} ${id} was modified concurrently. Retry.`, { entity, id });
  }
}

export class IdempotencyKeyReuseError extends BusinessRuleError {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used with a different request body.',
      { key },
    );
  }
}

export class RequestInProgressError extends ConflictError {
  constructor(key: string) {
    super('REQUEST_IN_PROGRESS', 'The original request with this Idempotency-Key is still running.', { key });
  }
}

export class LockTimeoutError extends ServiceUnavailableError {
  constructor(key: string, waitedMs: number) {
    super('LOCK_TIMEOUT', 'The account is busy with another payment. Retry shortly.', { key, waitedMs });
  }
}

// ---- External payment gateway failures --------------------------------------------

/** The bank/card network answered and said no (e.g. insufficient funds). Not a system fault. */
export class PaymentDeclinedError extends DomainError {
  readonly category = ErrorCategory.DECLINED;
  constructor(gateway: string, reason: string) {
    super('PAYMENT_DECLINED', `${gateway} declined the payment: ${reason}`, { gateway });
  }
}

/** The bank/card network did not answer or errored. This is what trips the circuit breaker. */
export class GatewayUnavailableError extends ServiceUnavailableError {
  constructor(gateway: string, reason: string) {
    super('GATEWAY_UNAVAILABLE', `${gateway} is not responding: ${reason}`, { gateway });
  }
}

export class CircuitOpenError extends ServiceUnavailableError {
  constructor(gateway: string, retryAfterMs: number) {
    super('CIRCUIT_OPEN', `${gateway} is failing, so calls are paused. Retry in ${Math.ceil(retryAfterMs / 1000)}s.`, {
      gateway,
      retryAfterMs,
    });
  }
}
