import { NotificationChannelType, NotificationStatus } from './enums';

/** A message delivered (or attempted) to one user over one channel. */
export interface Notification {
  /** Deterministic: the same event for the same user and channel always maps to the same id. */
  id: string;
  userId: string;
  transactionId: string;
  channel: NotificationChannelType;
  title: string;
  body: string;
  status: NotificationStatus;
  attempts: number;
  createdAt: Date;
}
