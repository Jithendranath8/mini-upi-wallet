import { setTimeout as sleep } from 'node:timers/promises';
import { NotificationChannelType } from '../domain/enums';
import { ValidationError } from '../domain/errors';
import type { User } from '../domain/User';
import type { ChaosController } from '../infrastructure/chaos/ChaosController';

/** A message addressed to one recipient on one channel. Plain data, so it can sit on a queue. */
export interface OutboundMessage {
  notificationId: string;
  userId: string;
  transactionId: string;
  channel: NotificationChannelType;
  recipient: string;
  title: string;
  body: string;
}

/**
 * PATTERN: Strategy. One delivery mechanism per class behind a common interface.
 * WhatsApp or in-app banners would be new classes; nothing that sends notifications changes.
 */
export interface NotificationChannel {
  readonly type: NotificationChannelType;
  /** Where this channel reaches the user, or null if the user has no such address. */
  recipientFor(user: User): string | null;
  /** Delivers the message. Throws if the provider fails, so the queue can retry. */
  send(message: OutboundMessage): Promise<string>;
}

/**
 * Template Method: talking to a (simulated) provider is identical for every channel;
 * only the wording and the address differ.
 */
abstract class SimulatedChannel implements NotificationChannel {
  abstract readonly type: NotificationChannelType;

  constructor(
    private readonly chaos: ChaosController,
    private readonly latencyMs: number,
  ) {}

  abstract recipientFor(user: User): string | null;
  protected abstract render(message: OutboundMessage): string;

  async send(message: OutboundMessage): Promise<string> {
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (Math.random() < this.chaos.state.notificationFailureRate) {
      throw new Error(`${this.type} provider timed out`);
    }
    return this.render(message);
  }
}

export class SmsChannel extends SimulatedChannel {
  readonly type = NotificationChannelType.SMS;

  recipientFor(user: User): string {
    return `+91 ******${user.phone.slice(-4)}`;
  }

  protected render(message: OutboundMessage): string {
    return `SMS to ${message.recipient}: ${message.body}`.slice(0, 160);
  }
}

export class PushChannel extends SimulatedChannel {
  readonly type = NotificationChannelType.PUSH;

  recipientFor(user: User): string {
    return `device of ${user.name}`;
  }

  protected render(message: OutboundMessage): string {
    return `Push to ${message.recipient}: ${message.title} | ${message.body}`;
  }
}

export class EmailChannel extends SimulatedChannel {
  readonly type = NotificationChannelType.EMAIL;

  recipientFor(user: User): string | null {
    return user.email;
  }

  protected render(message: OutboundMessage): string {
    const [local, domain] = message.recipient.split('@');
    const masked = `${local.slice(0, 1)}***@${domain ?? ''}`;
    return `Email to ${masked}, subject "${message.title}": ${message.body}`;
  }
}

/**
 * PATTERN: Factory (as a registry). Hands out the channel for a type. Channels are registered
 * at start-up in the composition root, so adding WhatsApp is a new class plus one `register`
 * call there; this class is never edited.
 */
export class NotificationChannelFactory {
  readonly #channels = new Map<NotificationChannelType, NotificationChannel>();

  register(channel: NotificationChannel): this {
    this.#channels.set(channel.type, channel);
    return this;
  }

  create(type: NotificationChannelType): NotificationChannel {
    const channel = this.#channels.get(type);
    if (!channel) throw new ValidationError('UNSUPPORTED_CHANNEL', `No notification channel for ${String(type)}.`);
    return channel;
  }

  supportedTypes(): NotificationChannelType[] {
    return [...this.#channels.keys()];
  }
}
