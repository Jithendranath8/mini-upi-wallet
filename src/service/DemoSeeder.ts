import { NotificationChannelType } from '../domain/enums';
import { Money } from '../domain/Money';
import type { User } from '../domain/User';
import type { ChaosController } from '../infrastructure/chaos/ChaosController';
import type { TransferService } from './TransferService';
import type { UserService } from './UserService';

export const DEMO_PIN = '1234';

/**
 * Creates a small, believable world to demo against. Everything goes through the real
 * services (registration, linking, top-ups, transfers), so the seeded balances are fully
 * explained by ledger entries, exactly like any other money in the system.
 */
export class DemoSeeder {
  constructor(
    private readonly users: UserService,
    private readonly transfers: TransferService,
    private readonly chaos: ChaosController,
  ) {}

  async seedIfEmpty(): Promise<boolean> {
    if (this.users.list().length > 0) return false;

    // Seed instantly: no simulated bank latency while loading wallets.
    const { bank, card, databaseLatencyMs } = this.chaos.state;
    this.chaos.update({ bank: { latencyMs: 0 }, card: { latencyMs: 0 }, databaseLatencyMs: 0 });
    try {
      await this.seed();
    } finally {
      this.chaos.update({ bank: { latencyMs: bank.latencyMs }, card: { latencyMs: card.latencyMs }, databaseLatencyMs });
    }
    return true;
  }

  private async seed(): Promise<void> {
    const { SMS, PUSH, EMAIL } = NotificationChannelType;

    const alice = this.users.register({
      name: 'Alice Sharma',
      upiHandle: 'alice',
      phone: '9876543210',
      email: 'alice@example.com',
      pin: DEMO_PIN,
      notificationChannels: [SMS, PUSH, EMAIL],
    });
    const bob = this.users.register({
      name: 'Bob Verma',
      upiHandle: 'bob',
      phone: '9876543211',
      email: 'bob@example.com',
      pin: DEMO_PIN,
      notificationChannels: [SMS, PUSH],
    });
    const charlie = this.users.register({
      name: 'Charlie Khan',
      upiHandle: 'charlie',
      phone: '9876543212',
      pin: DEMO_PIN,
      dailyLimitRupees: 5_000,
      notificationChannels: [PUSH],
    });
    const store = this.users.register({
      name: 'Diya Kirana Store',
      upiHandle: 'diya.store',
      phone: '9876543213',
      email: 'diya.store@example.com',
      pin: DEMO_PIN,
      notificationChannels: [SMS, EMAIL],
    });
    this.users.register({
      name: 'Quick Loan Offers',
      upiHandle: 'quickloan',
      phone: '9876543214',
      pin: DEMO_PIN,
      notificationChannels: [SMS],
      blacklisted: true,
    });

    const aliceBank = this.users.linkBankAccount(alice.id, {
      bankName: 'HDFC Bank',
      accountNumber: '50100123456789',
      ifsc: 'HDFC0001234',
    });
    this.users.linkCard(alice.id, {
      network: 'Visa',
      cardNumber: '4111111111111111',
      expiryMonth: 12,
      expiryYear: new Date().getFullYear() + 3,
    });
    const bobBank = this.users.linkBankAccount(bob.id, {
      bankName: 'State Bank of India',
      accountNumber: '30211234567',
      ifsc: 'SBIN0004321',
    });
    const charlieBank = this.users.linkBankAccount(charlie.id, {
      bankName: 'ICICI Bank',
      accountNumber: '000401567890',
      ifsc: 'ICIC0000004',
    });
    const storeBank = this.users.linkBankAccount(store.id, {
      bankName: 'Axis Bank',
      accountNumber: '917010012345678',
      ifsc: 'UTIB0000123',
    });

    await this.pay('seed-topup-alice', alice, alice.upiId, 25_000, 'Opening balance', aliceBank.id);
    await this.pay('seed-topup-bob', bob, bob.upiId, 8_000, 'Opening balance', bobBank.id);
    await this.pay('seed-topup-charlie', charlie, charlie.upiId, 2_500, 'Opening balance', charlieBank.id);
    await this.pay('seed-topup-store', store, store.upiId, 12_000, 'Opening balance', storeBank.id);

    await this.pay('seed-p2p-1', alice, bob.upiId, 450, 'Dinner split');
    await this.pay('seed-p2p-2', bob, alice.upiId, 120, 'Chai and samosa');
    await this.pay('seed-p2p-3', alice, store.upiId, 899, 'Groceries');
    await this.pay('seed-p2p-4', charlie, alice.upiId, 300, 'Movie tickets');
  }

  private async pay(key: string, sender: User, receiverUpiId: string, rupees: number, note: string, sourceId?: string) {
    const { result } = await this.transfers.transfer({
      idempotencyKey: key,
      senderId: sender.id,
      receiverUpiId,
      amount: Money.fromRupees(rupees),
      sourceId,
      note,
    });
    if (result.error) {
      throw new Error(`Seeding failed at "${note}" for ${sender.upiId}: ${result.error.code} ${result.error.message}`);
    }
  }
}
