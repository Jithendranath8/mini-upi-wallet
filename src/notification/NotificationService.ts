import { createHash } from 'node:crypto';
import { NotificationStatus, TransactionStatus, TransactionType } from '../domain/enums';
import type { User } from '../domain/User';
import type { TransactionEvent, TransactionObserver } from '../events/TransactionEvents';
import type { SqlReader } from '../infrastructure/db/Database';
import { tracer } from '../infrastructure/observability/Tracer';
import type { MessageQueue, QueueMessage } from '../infrastructure/queue/MessageQueue';
import type { NotificationRepository } from '../repository/interfaces';
import { toNotificationView, type NotificationView } from '../readmodel/views';
import type { NotificationChannelFactory, OutboundMessage } from './channels';

export const NOTIFICATIONS_TOPIC = 'notifications';

interface Draft {
  user: User;
  title: string;
  body: string;
}

/** Decides who should hear about an event and what the message says. */
export class NotificationComposer {
  compose({ transaction, transition, sender, receiver, source }: TransactionEvent): Draft[] {
    const amount = transaction.amount.format();
    const isTopUp = transaction.type === TransactionType.TOPUP;

    switch (transition.to) {
      case TransactionStatus.SUCCESS:
        if (isTopUp) {
          return [{ user: sender, title: 'Money added', body: `${amount} added to your wallet from ${source.describe()}.` }];
        }
        return [
          { user: sender, title: 'Payment sent', body: `Paid ${amount} to ${receiver.name} (${receiver.upiId}).` },
          { user: receiver, title: 'Money received', body: `${sender.name} (${sender.upiId}) sent you ${amount}.` },
        ];

      case TransactionStatus.FAILED:
        return [
          {
            user: sender,
            title: 'Payment failed',
            body: `${amount} to ${receiver.name} did not go through. ${transaction.failureReason ?? ''}`.trim(),
          },
        ];

      case TransactionStatus.REFUNDED: {
        const drafts: Draft[] = [
          { user: sender, title: 'Refund received', body: `${amount} was returned to your ${source.describe()}.` },
        ];
        const receiverHadTheMoney = transition.from === TransactionStatus.SUCCESS && receiver.id !== sender.id;
        if (receiverHadTheMoney) {
          drafts.push({
            user: receiver,
            title: 'Payment refunded',
            body: `${amount} you received from ${sender.name} was refunded to them.`,
          });
        }
        return drafts;
      }

      default:
        return []; // INITIATED and PROCESSING are not worth a notification
    }
  }
}

/**
 * Sends notifications asynchronously.
 *
 * The payment path only *enqueues* (microseconds). Delivery happens on queue workers, with
 * retries and a dead-letter queue, so a slow or failing SMS provider can never slow down or
 * fail a payment.
 */
export class NotificationService {
  constructor(
    private readonly queue: MessageQueue,
    private readonly channels: NotificationChannelFactory,
    private readonly notifications: NotificationRepository,
    private readonly composer: NotificationComposer,
  ) {}

  /** Registers the queue consumer. Call once at start-up. */
  startWorkers(): void {
    this.queue.subscribe<OutboundMessage>(NOTIFICATIONS_TOPIC, (message) => this.deliver(message), {
      onDeadLetter: (message) => this.recordUndeliverable(message),
    });
  }

  /** Producer side: fan out one job per (recipient, channel). */
  enqueueFor(event: TransactionEvent): number {
    let enqueued = 0;
    for (const draft of this.composer.compose(event)) {
      for (const type of draft.user.notificationChannels) {
        const channel = this.channels.create(type);
        const recipient = channel.recipientFor(draft.user);
        if (!recipient) continue;
        this.queue.publish<OutboundMessage>(NOTIFICATIONS_TOPIC, {
          notificationId: NotificationService.idFor(event.transaction.id, draft.user.id, type, event.transition.to),
          userId: draft.user.id,
          transactionId: event.transaction.id,
          channel: type,
          recipient,
          title: draft.title,
          body: draft.body,
        });
        enqueued += 1;
      }
    }
    if (enqueued > 0) {
      tracer.step('Queue', `Enqueued ${enqueued} notification job(s); the payment does not wait for them`);
    }
    return enqueued;
  }

  listFor(reader: SqlReader, userId: string, limit: number): NotificationView[] {
    return this.notifications.findByUser(reader, userId, limit).map(toNotificationView);
  }

  /** Consumer side. Throwing tells the queue to retry later. */
  private async deliver(message: QueueMessage<OutboundMessage>): Promise<void> {
    const job = message.payload;
    const delivered = await this.channels.create(job.channel).send(job);
    this.store(message, NotificationStatus.SENT);
    tracer.step('Notification', `${delivered}${message.attempt > 1 ? ` (attempt ${message.attempt})` : ''}`, 'ok', message.trace);
  }

  private recordUndeliverable(message: QueueMessage<OutboundMessage>): void {
    this.store(message, NotificationStatus.FAILED);
  }

  private store(message: QueueMessage<OutboundMessage>, status: NotificationStatus): void {
    const job = message.payload;
    this.notifications.upsert({
      id: job.notificationId,
      userId: job.userId,
      transactionId: job.transactionId,
      channel: job.channel,
      title: job.title,
      body: job.body,
      status,
      attempts: message.attempt,
      createdAt: new Date(),
    });
  }

  /**
   * Deterministic id: the same event for the same user and channel always produces the same
   * notification id. With at-least-once delivery a message can arrive twice; the upsert on
   * this id makes the second arrival harmless.
   */
  private static idFor(transactionId: string, userId: string, channel: string, status: string): string {
    const digest = createHash('sha1').update([transactionId, userId, channel, status].join('|')).digest('hex');
    return `ntf_${digest.slice(0, 20)}`;
  }
}

/** Observer that turns transaction events into notification jobs. */
export class NotificationObserver implements TransactionObserver {
  readonly name = 'Notifications';

  constructor(private readonly notifications: NotificationService) {}

  onTransactionEvent(event: TransactionEvent): void {
    this.notifications.enqueueFor(event);
  }
}
