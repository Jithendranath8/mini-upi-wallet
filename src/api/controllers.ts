import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Request, RequestHandler, Response } from 'express';
import type { Application } from '../container';
import { NotFoundError, ValidationError } from '../domain/errors';
import type { User } from '../domain/User';
import type { PrimaryDatabase } from '../infrastructure/db/Database';
import { tracer } from '../infrastructure/observability/Tracer';
import {
  toScheduledPaymentView,
  toSourceView,
  toUserView,
  toWalletView,
} from '../readmodel/views';
import type { TransferResult } from '../service/TransferService';
import type { IdempotentOutcome } from '../service/IdempotencyService';
import {
  amountOf,
  bodyOf,
  limitOf,
  optionalNumber,
  optionalString,
  plainText,
  requiredNumber,
  requiredString,
} from './requests';
import { statusFor } from './httpStatus';

/**
 * Controllers: the HTTP edge. Each handler parses the request, calls ONE service method and
 * shapes the response. No business rule lives here.
 *
 * Response envelope:  success -> { data }      failure -> { error: { code, message, details, requestId } }
 */

const currentUser = (res: Response): User => res.locals.user as User;
const wantsStrongRead = (req: Request): boolean => req.query.consistency === 'strong';
const pathParam = (req: Request, name: string): string => String(req.params[name]);

/** The client's Idempotency-Key. The `scheduled:` namespace belongs to the scheduler. */
function clientKey(req: Request): string {
  const key = req.header('Idempotency-Key') ?? '';
  if (key.startsWith('scheduled:')) {
    throw new ValidationError('IDEMPOTENCY_KEY_RESERVED', 'Idempotency keys starting with "scheduled:" are reserved.');
  }
  return key;
}

export class UserController {
  constructor(private readonly app: Application) {}

  /** POST /users */
  register: RequestHandler = (req, res) => {
    const body = bodyOf(req);
    const user = this.app.users.register({
      name: plainText(requiredString(body, 'name', 50), 'name')!,
      phone: requiredString(body, 'phone', 10),
      pin: requiredString(body, 'pin', 6),
      email: optionalString(body, 'email', 120),
      upiHandle: optionalString(body, 'upiHandle', 30),
      dailyLimitRupees: optionalNumber(body, 'dailyLimit'),
    });
    res.status(201).json({ data: this.profile(user) });
  };

  /** POST /auth/login : UPI ID + PIN -> session token for `Authorization: Bearer`. */
  login: RequestHandler = (req, res) => {
    const body = bodyOf(req);
    const session = this.app.sessions.login(requiredString(body, 'upiId', 60), body.pin);
    res.json({
      data: { token: session.token, expiresAt: session.expiresAt.toISOString(), user: toUserView(session.user) },
    });
  };

  /** GET /users : the demo's "who am I logged in as" picker. */
  list: RequestHandler = (_req, res) => {
    res.json({ data: this.app.users.list().map(toUserView) });
  };

  /** GET /users/resolve?upiId= : cached lookup of a payee by UPI ID. */
  resolve: RequestHandler = (req, res) => {
    const upiId = req.query.upiId;
    if (typeof upiId !== 'string' || upiId.trim() === '') {
      throw new ValidationError('MISSING_FIELD', '"upiId" query parameter is required.');
    }
    res.json({ data: this.app.users.resolveUpiId(upiId) });
  };

  /** GET /me : profile, wallet balance (cached) and linked payment sources. */
  me: RequestHandler = (_req, res) => {
    res.json({ data: this.profile(currentUser(res)) });
  };

  /** POST /payment-sources/bank-accounts */
  linkBankAccount: RequestHandler = (req, res) => {
    const body = bodyOf(req);
    const source = this.app.users.linkBankAccount(currentUser(res).id, {
      bankName: plainText(requiredString(body, 'bankName', 40), 'bankName')!,
      accountNumber: requiredString(body, 'accountNumber', 18),
      ifsc: requiredString(body, 'ifsc', 11).toUpperCase(),
    });
    res.status(201).json({ data: toSourceView(source) });
  };

  /** POST /payment-sources/cards */
  linkCard: RequestHandler = (req, res) => {
    const body = bodyOf(req);
    const source = this.app.users.linkCard(currentUser(res).id, {
      network: requiredString(body, 'network', 20),
      cardNumber: requiredString(body, 'cardNumber', 19),
      expiryMonth: requiredNumber(body, 'expiryMonth'),
      expiryYear: requiredNumber(body, 'expiryYear'),
    });
    res.status(201).json({ data: toSourceView(source) });
  };

  private profile(user: User) {
    return {
      user: toUserView(user),
      wallet: toWalletView(this.app.users.walletOf(user.id)),
      sources: this.app.users.sourcesOf(user.id).map(toSourceView),
    };
  }
}

export class PaymentController {
  constructor(private readonly app: Application) {}

  /** POST /transfers  (headers: X-User-Id, Idempotency-Key) */
  transfer: RequestHandler = async (req, res) => {
    const body = bodyOf(req);
    const user = currentUser(res);
    const command = {
      idempotencyKey: clientKey(req),
      senderId: user.id,
      receiverUpiId: requiredString(body, 'receiverUpiId', 60),
      amount: amountOf(body),
      sourceId: optionalString(body, 'sourceId', 40),
      note: plainText(optionalString(body, 'note', 80), 'note'),
    };
    this.app.users.verifyPin(user, body.pin);
    this.respond(res, await this.app.transfers.transfer(command));
  };

  /** POST /wallet/topup : load your own wallet from a linked bank account or card. */
  topUp: RequestHandler = async (req, res) => {
    const body = bodyOf(req);
    const user = currentUser(res);
    const command = {
      idempotencyKey: clientKey(req),
      senderId: user.id,
      receiverUpiId: user.upiId,
      amount: amountOf(body),
      sourceId: requiredString(body, 'sourceId', 40),
      note: 'Wallet top-up',
    };
    this.app.users.verifyPin(user, body.pin);
    this.respond(res, await this.app.transfers.transfer(command));
  };

  /** GET /transactions?limit=&consistency=strong */
  history: RequestHandler = (req, res) => {
    const before = typeof req.query.before === 'string' ? req.query.before : undefined;
    const served = this.app.queries.history(currentUser(res).id, limitOf(req), wantsStrongRead(req), before);
    res.setHeader('X-Data-Source', served.servedBy);
    // `nextCursor` is null on the last page; otherwise pass it back as `?before=`.
    res.json({ data: served.data, page: { nextCursor: served.nextCursor ?? null } });
  };

  /** GET /transactions/:id : the transaction, its state timeline and its ledger entries. */
  details: RequestHandler = (req, res) => {
    const served = this.app.queries.details(pathParam(req, 'id'), currentUser(res).id, wantsStrongRead(req));
    res.setHeader('X-Data-Source', served.servedBy);
    res.json({ data: served.data });
  };

  /** POST /transactions/:id/refund */
  refund: RequestHandler = async (req, res) => {
    const user = currentUser(res);
    this.app.users.verifyPin(user, bodyOf(req).pin);
    const transaction = await this.app.refunds.refund(pathParam(req, 'id'), user);
    res.json({ data: { transaction } });
  };

  /** POST /scheduled-payments : pay later. Send either `executeAt` (ISO time) or `delaySeconds`. */
  schedule: RequestHandler = (req, res) => {
    const body = bodyOf(req);
    const user = currentUser(res);
    const delaySeconds = optionalNumber(body, 'delaySeconds');
    const executeAtText = optionalString(body, 'executeAt', 40);
    if (delaySeconds === undefined && executeAtText === undefined) {
      throw new ValidationError('MISSING_FIELD', 'Send "executeAt" or "delaySeconds".');
    }
    const input = {
      receiverUpiId: requiredString(body, 'receiverUpiId', 60),
      amount: amountOf(body),
      sourceId: optionalString(body, 'sourceId', 40),
      note: plainText(optionalString(body, 'note', 80), 'note'),
      executeAt: delaySeconds !== undefined ? new Date(Date.now() + delaySeconds * 1000) : new Date(executeAtText!),
    };
    this.app.users.verifyPin(user, body.pin);
    res.status(201).json({ data: toScheduledPaymentView(this.app.scheduled.schedule(user, input)) });
  };

  /** GET /scheduled-payments */
  listScheduled: RequestHandler = (_req, res) => {
    res.json({ data: this.app.scheduled.listFor(currentUser(res).id).map(toScheduledPaymentView) });
  };

  /** DELETE /scheduled-payments/:id */
  cancelScheduled: RequestHandler = (req, res) => {
    res.json({ data: toScheduledPaymentView(this.app.scheduled.cancel(currentUser(res), pathParam(req, 'id'))) });
  };

  /** GET /notifications */
  notifications: RequestHandler = (req, res) => {
    const user = currentUser(res);
    const reader = this.app.readRouter.route(user.id, { strong: wantsStrongRead(req) });
    res.setHeader('X-Data-Source', reader.role);
    res.json({ data: this.app.notifications.listFor(reader, user.id, limitOf(req, 15, 50)) });
  };

  /**
   * A payment that was accepted and then failed a business rule is still a recorded
   * transaction: the response carries both the error and the FAILED transaction.
   */
  private respond(res: Response, outcome: IdempotentOutcome<TransferResult>): void {
    const { result, replayed } = outcome;
    res.setHeader('Idempotent-Replayed', String(replayed));
    if (result.error) {
      const { category, ...error } = result.error;
      res.status(statusFor(category)).json({
        error: { ...error, requestId: res.locals.requestId },
        data: { transaction: result.transaction },
      });
      return;
    }
    res.status(replayed ? 200 : 201).json({ data: { transaction: result.transaction } });
  }
}

/** Operator and demo endpoints: live metrics, traces, the ledger audit and fault injection. */
export class SystemController {
  constructor(
    private readonly app: Application,
    private readonly primary: PrimaryDatabase,
    private readonly docsDirectory: string,
  ) {}

  metrics: RequestHandler = (_req, res) => {
    res.json({ data: this.app.system.snapshot() });
  };

  design: RequestHandler = (_req, res) => {
    res.json({ data: this.app.system.design() });
  };

  feed: RequestHandler = (req, res) => {
    res.json({ data: tracer.recentFeed(limitOf(req, 60, 250)) });
  };

  trace: RequestHandler = (req, res) => {
    const trace = tracer.find(pathParam(req, 'id'));
    if (!trace) throw new NotFoundError('TRACE_NOT_FOUND', 'That request trace is no longer kept.');
    res.json({ data: trace.toJSON() });
  };

  ledger: RequestHandler = (req, res) => {
    const reader = this.app.readRouter.route(undefined, { strong: wantsStrongRead(req) });
    res.setHeader('X-Data-Source', reader.role);
    res.json({ data: this.app.ledger.recent(reader, limitOf(req, 30, 200)) });
  };

  verifyLedger: RequestHandler = (_req, res) => {
    res.json({ data: this.app.ledger.verify(this.primary) });
  };

  tamperLedger: RequestHandler = (_req, res) => {
    res.json({ data: this.app.system.attemptLedgerTamper() });
  };

  chaos: RequestHandler = (req, res) => {
    res.json({ data: this.app.system.updateChaos(bodyOf(req)) });
  };

  nodeHealth: RequestHandler = (req, res) => {
    const healthy = bodyOf(req).healthy;
    if (typeof healthy !== 'boolean') throw new ValidationError('INVALID_FIELD', '"healthy" must be true or false.');
    res.json({ data: this.app.system.setNodeHealth(pathParam(req, 'id'), healthy) });
  };

  redrive: RequestHandler = (_req, res) => {
    res.json({ data: { redriven: this.app.system.redriveDeadLetters() } });
  };

  resetBreakers: RequestHandler = (_req, res) => {
    this.app.system.resetBreakers();
    res.json({ data: { reset: true } });
  };

  reset: RequestHandler = async (_req, res) => {
    await this.app.resetDemo();
    res.json({ data: { reset: true } });
  };

  /** The design documents under /docs, for the in-app viewer. */
  docs: RequestHandler = (_req, res) => {
    const files = readdirSync(this.docsDirectory)
      .filter((file) => file.endsWith('.md'))
      .sort();
    res.json({
      data: files.map((file) => {
        const firstHeading = readFileSync(join(this.docsDirectory, file), 'utf8').match(/^#\s+(.+)$/m);
        return { file, title: firstHeading ? firstHeading[1] : file };
      }),
    });
  };
}
