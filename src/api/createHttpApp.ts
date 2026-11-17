import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, Router } from 'express';
import type { Application } from '../container';
import type { PrimaryDatabase } from '../infrastructure/db/Database';
import type { LoadBalancer } from '../infrastructure/loadbalancer/LoadBalancer';
import type { RateLimiter } from '../infrastructure/ratelimit/RateLimiter';
import { PaymentController, SystemController, UserController } from './controllers';
import {
  addressRateLimiting,
  authentication,
  errorHandler,
  loadBalancing,
  operatorOnly,
  requestContext,
  routeNotFound,
  sameSiteOnly,
  securityHeaders,
} from './middleware';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface EdgeComponents {
  loadBalancer: LoadBalancer;
  /** Per signed-in user. */
  rateLimiter: RateLimiter;
  /** Per client address, before the caller is known. */
  addressRateLimiter: RateLimiter;
  primary: PrimaryDatabase;
}

/**
 * Builds the HTTP layer. Request path for the public API:
 *
 *   same-site guard -> JSON body -> request id + trace -> load balancer -> address rate limit
 *     -> [auth + per-user rate limit] -> controller -> service -> repository  ... -> error handler
 */
export function createHttpApp(app: Application, edge: EdgeComponents): Express {
  const http = express();
  http.disable('x-powered-by');
  http.use(securityHeaders());
  // Everything under /api is refused when it comes from another site or to an unknown host name.
  // When the operator deliberately listens on all interfaces, any host name may reach us.
  const listensEverywhere = ['0.0.0.0', '::'].includes(app.settings.host);
  const allowedHosts = listensEverywhere ? null : new Set(['localhost', '127.0.0.1', '[::1]', app.settings.host.toLowerCase()]);
  http.use('/api', sameSiteOnly(allowedHosts));
  http.use(express.json({ limit: '16kb' }));

  const docsDirectory = join(PROJECT_ROOT, 'docs');
  if (!existsSync(docsDirectory)) mkdirSync(docsDirectory, { recursive: true });

  const users = new UserController(app);
  const payments = new PaymentController(app);
  const system = new SystemController(app, edge.primary, docsDirectory);
  const auth = authentication(app.users, edge.rateLimiter, app.sessions, app.settings.allowHeaderIdentity);

  // ---- Operator / demo API. Not load balanced or rate limited: it observes the system. ----
  const ops = Router();
  ops.use(operatorOnly(app.settings.operatorKey));
  ops.get('/metrics', system.metrics);
  ops.get('/design', system.design);
  ops.get('/feed', system.feed);
  ops.get('/traces/:id', system.trace);
  ops.get('/ledger', system.ledger);
  ops.get('/ledger/verify', system.verifyLedger);
  ops.get('/docs', system.docs);
  ops.post('/ledger/tamper-test', system.tamperLedger);
  ops.put('/chaos', system.chaos);
  ops.put('/nodes/:id', system.nodeHealth);
  ops.post('/queue/redrive', system.redrive);
  ops.post('/breakers/reset', system.resetBreakers);
  ops.post('/reset', system.reset);
  http.use('/api/v1/system', ops);

  // ---- Public API, version 1 --------------------------------------------------------------
  const api = Router();
  api.post('/auth/login', users.login);
  api.post('/users', users.register);
  api.get('/users', users.list);
  api.get('/users/resolve', users.resolve);

  api.get('/me', auth, users.me);
  api.post('/payment-sources/bank-accounts', auth, users.linkBankAccount);
  api.post('/payment-sources/cards', auth, users.linkCard);

  api.post('/transfers', auth, payments.transfer);
  api.post('/wallet/topup', auth, payments.topUp);
  api.get('/transactions', auth, payments.history);
  api.get('/transactions/:id', auth, payments.details);
  api.post('/transactions/:id/refund', auth, payments.refund);

  api.post('/scheduled-payments', auth, payments.schedule);
  api.get('/scheduled-payments', auth, payments.listScheduled);
  api.delete('/scheduled-payments/:id', auth, payments.cancelScheduled);

  api.get('/notifications', auth, payments.notifications);

  http.use(
    '/api/v1',
    requestContext(),
    loadBalancing(edge.loadBalancer),
    addressRateLimiting(edge.addressRateLimiter),
    api,
  );
  http.use('/api', routeNotFound());

  http.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  // ---- Static UI, design documents and locally served front-end libraries -------------------
  const modules = join(PROJECT_ROOT, 'node_modules');
  http.use('/design-docs', express.static(docsDirectory));
  http.use('/vendor/marked', express.static(join(modules, 'marked', 'lib')));
  http.use('/vendor/mermaid', express.static(join(modules, 'mermaid', 'dist')));
  // Only stylesheets and font files: nothing else from the package folders is exposed.
  const fontAssets = (folder: string): express.RequestHandler => {
    const serve = express.static(folder, { index: false });
    return (req, res, next) => (/\.(css|woff2?)$/.test(req.path) ? serve(req, res, next) : next());
  };
  http.use('/vendor/fonts/bricolage', fontAssets(join(modules, '@fontsource-variable', 'bricolage-grotesque')));
  http.use('/vendor/fonts/plex-sans', fontAssets(join(modules, '@fontsource', 'ibm-plex-sans')));
  http.use('/vendor/fonts/plex-mono', fontAssets(join(modules, '@fontsource', 'ibm-plex-mono')));
  http.use(express.static(join(PROJECT_ROOT, 'public')));

  http.use(errorHandler());
  return http;
}
