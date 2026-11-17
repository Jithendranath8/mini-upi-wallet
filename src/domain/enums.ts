export enum TransactionStatus {
  INITIATED = 'INITIATED',
  PROCESSING = 'PROCESSING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum TransactionType {
  /** Money sent from one user to another. */
  P2P = 'P2P',
  /** A user loading their own wallet from a linked bank account or card. */
  TOPUP = 'TOPUP',
}

export enum PaymentSourceType {
  WALLET = 'WALLET',
  BANK_ACCOUNT = 'BANK_ACCOUNT',
  CARD = 'CARD',
}

export enum LedgerEntryType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT',
}

export enum NotificationChannelType {
  SMS = 'SMS',
  PUSH = 'PUSH',
  EMAIL = 'EMAIL',
}

export enum NotificationStatus {
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum UserStatus {
  ACTIVE = 'ACTIVE',
  BLOCKED = 'BLOCKED',
}

export enum WalletStatus {
  ACTIVE = 'ACTIVE',
  FROZEN = 'FROZEN',
}

export enum ScheduledPaymentStatus {
  PENDING = 'PENDING',
  /** Claimed by the scheduler; the payment is in flight and can no longer be cancelled. */
  RUNNING = 'RUNNING',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}
