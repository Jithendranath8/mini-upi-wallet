import { NotificationChannelType, UserStatus } from './enums';
import { Money } from './Money';
import { PinHasher } from './PinHasher';

export interface UserProps {
  id: string;
  name: string;
  upiId: string;
  phone: string;
  email: string | null;
  pinHash: string;
  pinSalt: string;
  status: UserStatus;
  dailyLimit: Money;
  notificationChannels: NotificationChannelType[];
  blacklisted: boolean;
  createdAt: Date;
}

/**
 * A person who holds a wallet. Encapsulates the PIN credential: callers can ask
 * "is this PIN right?" but can never read the hash.
 */
export class User {
  readonly id: string;
  readonly name: string;
  readonly upiId: string;
  readonly phone: string;
  readonly email: string | null;
  readonly status: UserStatus;
  readonly dailyLimit: Money;
  readonly notificationChannels: readonly NotificationChannelType[];
  readonly blacklisted: boolean;
  readonly createdAt: Date;
  readonly #pinHash: string;
  readonly #pinSalt: string;

  constructor(props: UserProps) {
    this.id = props.id;
    this.name = props.name;
    this.upiId = props.upiId;
    this.phone = props.phone;
    this.email = props.email;
    this.status = props.status;
    this.dailyLimit = props.dailyLimit;
    this.notificationChannels = [...props.notificationChannels];
    this.blacklisted = props.blacklisted;
    this.createdAt = props.createdAt;
    this.#pinHash = props.pinHash;
    this.#pinSalt = props.pinSalt;
  }

  verifyPin(pin: string): boolean {
    return PinHasher.verify(pin, this.#pinHash, this.#pinSalt);
  }

  isActive(): boolean {
    return this.status === UserStatus.ACTIVE;
  }

  /** Full state for the persistence layer only. */
  toProps(): UserProps {
    return {
      id: this.id,
      name: this.name,
      upiId: this.upiId,
      phone: this.phone,
      email: this.email,
      pinHash: this.#pinHash,
      pinSalt: this.#pinSalt,
      status: this.status,
      dailyLimit: this.dailyLimit,
      notificationChannels: [...this.notificationChannels],
      blacklisted: this.blacklisted,
      createdAt: this.createdAt,
    };
  }
}
