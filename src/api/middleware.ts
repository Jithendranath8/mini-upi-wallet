import { timingSafeEqual } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { DomainError, ForbiddenError, RateLimitExceededError } from '../domain/errors';
import type { LoadBalancer } from '../infrastructure/loadbalancer/LoadBalancer';
import { RequestTrace, tracer } from '../infrastructure/observability/Tracer';
import type { RateLimiter } from '../infrastructure/ratelimit/RateLimiter';
import type { SessionService } from '../service/SessionService';
import type { UserService } from '../service/UserService';
import { statusFor } from './httpStatus';
import { newId } from '../util/ids';

/** Gives every request an id and a trace that follows it through every await. */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const requestId = newId('req');
    res.locals.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const trace = new RequestTrace(requestId, `${req.method} ${req.baseUrl}${req.path}`);
    // Marks the moment the client got its answer; later steps are background work.
    res.on('finish', () => {
      tracer.step('Response', `${res.statusCode} sent to the client`, res.statusCode < 400 ? 'ok' : 'error', trace);
    });
    tracer.run(trace, next);
  };
}

/** Picks the app node that serves this request and says so in X-Served-By. */
export function loadBalancing(loadBalancer: LoadBalancer): RequestHandler {
  return (_req, res, next) => {
    const node = loadBalancer.route();
    res.locals.node = node.id;
    res.setHeader('X-Served-By', node.id);
    tracer.step('LoadBalancer', `Routed to ${node.id} (${loadBalancer.stats().strategy})`);
    next();
  };
}

/**
 * Rate limit by client address, before the caller is identified. It must not be keyed on a
 * header the client chooses: that would let anyone dodge the limit or exhaust someone else's.
 */
export function addressRateLimiting(rateLimiter: RateLimiter): RequestHandler {
  return (req, _res, next) => {
    const decision = rateLimiter.tryConsume(req.ip ?? 'unknown');
    if (!decision.allowed) {
      tracer.step('RateLimiter', `Address ${req.ip} is sending too fast: rejected`, 'error');
      throw new RateLimitExceededError(decision.retryAfterMs);
    }
    next();
  };
}

/**
 * Identifies the caller from X-User-Id (the prototype's stand-in for a session token), then
 * spends one token from THAT user's bucket. Rejects with 429 and Retry-After when it is empty.
 */
export function authentication(
  users: UserService,
  rateLimiter: RateLimiter,
  sessions: SessionService,
  allowHeaderIdentity: boolean,
): RequestHandler {
  return (req, res, next) => {
    // A session token always wins. The X-User-Id header is a demo convenience and is only
    // honoured when the operator has left `allowHeaderIdentity` on.
    const bearer = /^Bearer (.+)$/.exec(req.header('Authorization') ?? '')?.[1];
    const userId = bearer ? sessions.verify(bearer) : allowHeaderIdentity ? req.header('X-User-Id') : undefined;
    const user = users.authenticate(userId);
    res.locals.user = user;

    const decision = rateLimiter.tryConsume(user.id);
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));
    if (!decision.allowed) {
      tracer.step('RateLimiter', `Bucket empty for ${user.upiId}: rejected, retry in ${decision.retryAfterMs} ms`, 'error');
      throw new RateLimitExceededError(decision.retryAfterMs);
    }
    tracer.step('RateLimiter', `Allowed (${decision.remaining} tokens left for ${user.upiId})`, 'ok');
    next();
  };
}

/**
 * Refuses requests that a web page on another site made on the user's behalf, and requests
 * addressed to a host name this server does not answer to (DNS rebinding). Browsers send
 * Origin / Sec-Fetch-Site on such requests; command-line clients send neither and pass.
 */
export function sameSiteOnly(allowedHosts: ReadonlySet<string> | null): RequestHandler {
  return (req, _res, next) => {
    const hostName = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (allowedHosts && !allowedHosts.has(hostName)) {
      throw new ForbiddenError('HOST_NOT_ALLOWED', 'This server does not answer to that host name.');
    }
    const origin = req.headers.origin;
    const crossSite =
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (typeof origin === 'string' && origin !== 'null' && safeHost(origin) !== (req.headers.host ?? '').toLowerCase());
    if (crossSite) {
      throw new ForbiddenError('CROSS_SITE_REQUEST', 'Requests from other sites are not accepted.');
    }
    next();
  };
}

function safeHost(origin: string): string | undefined {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Operator role. When an operator key is configured, every state-changing operator endpoint
 * requires it; reads stay open so dashboards keep working. Unset (the default), the demo is
 * open to whoever can reach the server, which is loopback only.
 */
export function operatorOnly(operatorKey: string): RequestHandler {
  const expected = Buffer.from(operatorKey);
  return (req, _res, next) => {
    if (operatorKey === '' || req.method === 'GET') return next();
    const given = Buffer.from(req.header('X-Operator-Key') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new ForbiddenError('OPERATOR_KEY_REQUIRED', 'This action needs a valid X-Operator-Key header.');
    }
    next();
  };
}

/** Baseline browser protections. The UI ships no inline scripts, so scripts are 'self' only. */
export function securityHeaders(): RequestHandler {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // Mermaid diagrams carry inline styles
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

export function routeNotFound(): RequestHandler {
  return (req, res) => {
    res.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.originalUrl}.` },
    });
  };
}

/**
 * The single place where errors become HTTP responses.
 *   DomainError      -> its own status and code (the client can act on it)
 *   malformed JSON   -> 400
 *   anything else    -> 500 with no internals leaked; details go to the server log
 */
export function errorHandler(): ErrorRequestHandler {
  return (error, req, res, _next) => {
    const requestId: string | undefined = res.locals.requestId;

    if (error instanceof DomainError) {
      if (error instanceof RateLimitExceededError) {
        res.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
      }
      res.status(statusFor(error.category)).json({
        error: { code: error.code, message: error.message, details: error.details, requestId },
      });
      return;
    }

    const parseFailure = (error as { type?: string }).type;
    if (parseFailure === 'entity.parse.failed' || parseFailure === 'entity.too.large') {
      res.status(parseFailure === 'entity.too.large' ? 413 : 400).json({
        error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON under 16 kB.', requestId },
      });
      return;
    }

    console.error(`[${requestId ?? 'no-request-id'}] ${req.method} ${req.originalUrl} failed`, error);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side.', requestId },
    });
  };
}
