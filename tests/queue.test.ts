import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InMemoryMessageQueue, type QueueMessage } from '../src/infrastructure/queue/MessageQueue';
import { eventually, keepAlive, sleep } from './helpers';

const TOPIC = 'notifications';

const queueWith = (overrides: Partial<{ concurrency: number; maxAttempts: number; backoffBaseMs: number }> = {}) =>
  new InMemoryMessageQueue({ concurrency: 4, maxAttempts: 3, backoffBaseMs: 5, ...overrides });

/** Retries wait on unref'd timers, so a pending drain() needs something to keep the process alive. */
const drained = (queue: InMemoryMessageQueue) => keepAlive(queue.drain());

describe('InMemoryMessageQueue: delivery', () => {
  test('delivers a published message to the subscriber, first attempt numbered 1', async () => {
    const queue = queueWith();
    const received: QueueMessage<{ text: string }>[] = [];
    queue.subscribe<{ text: string }>(TOPIC, async (message) => void received.push(message));

    const id = queue.publish(TOPIC, { text: 'hello' });
    assert.equal(received.length, 0, 'publishing never runs the consumer inline');
    await drained(queue);

    assert.equal(received.length, 1);
    assert.equal(received[0].id, id);
    assert.equal(received[0].topic, TOPIC);
    assert.equal(received[0].attempt, 1);
    assert.deepEqual(received[0].payload, { text: 'hello' });
    assert.deepEqual(queue.stats()[TOPIC], {
      depth: 0,
      inFlight: 0,
      scheduledRetries: 0,
      published: 1,
      processed: 1,
      retried: 0,
      deadLettered: 0,
    });
  });

  test('messages published before anyone subscribed wait and are delivered on subscribe', async () => {
    const queue = queueWith();
    queue.publish(TOPIC, 'first');
    queue.publish(TOPIC, 'second');
    assert.equal(queue.stats()[TOPIC].depth, 2);

    const received: string[] = [];
    queue.subscribe<string>(TOPIC, async (message) => void received.push(message.payload));
    await drained(queue);
    assert.deepEqual(received.sort(), ['first', 'second']);
    assert.equal(queue.stats()[TOPIC].depth, 0);
  });

  test('with a single worker, messages are processed in publish order', async () => {
    const queue = queueWith({ concurrency: 1 });
    const received: number[] = [];
    queue.subscribe<number>(TOPIC, async (message) => {
      await sleep(message.payload === 0 ? 5 : 0); // the first one is the slowest
      received.push(message.payload);
    });
    for (let i = 0; i < 10; i += 1) queue.publish(TOPIC, i);
    await drained(queue);
    assert.deepEqual(received, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test('never runs more handlers at once than the configured concurrency', async () => {
    const queue = queueWith({ concurrency: 2 });
    let running = 0;
    let maxRunning = 0;
    queue.subscribe(TOPIC, async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(3);
      running -= 1;
    });
    for (let i = 0; i < 9; i += 1) queue.publish(TOPIC, i);
    await drained(queue);
    assert.equal(maxRunning, 2);
    assert.equal(queue.stats()[TOPIC].processed, 9);
  });

  test('topics are independent', async () => {
    const queue = queueWith();
    const received: string[] = [];
    queue.subscribe<string>('emails', async (message) => void received.push(`email:${message.payload}`));
    queue.subscribe<string>('sms', async (message) => void received.push(`sms:${message.payload}`));
    queue.publish('emails', 'a');
    queue.publish('sms', 'b');
    queue.publish('unsubscribed', 'c');
    await eventually(() => received.length === 2);
    assert.deepEqual(received.sort(), ['email:a', 'sms:b']);
    assert.equal(queue.stats().unsubscribed.depth, 1, 'a topic without a consumer just accumulates');
  });

  test('handles a burst of 2,000 messages', async () => {
    const queue = queueWith({ concurrency: 8 });
    let sum = 0;
    queue.subscribe<number>(TOPIC, async (message) => void (sum += message.payload));
    for (let i = 1; i <= 2_000; i += 1) queue.publish(TOPIC, i);
    await drained(queue);
    assert.equal(sum, (2_000 * 2_001) / 2);
    assert.equal(queue.stats()[TOPIC].processed, 2_000);
  });
});

describe('InMemoryMessageQueue: retries and dead letters', () => {
  test('a failing message is retried with exponential backoff until it succeeds', async () => {
    const queue = queueWith({ concurrency: 1, maxAttempts: 4, backoffBaseMs: 15 });
    const attempts: Array<{ attempt: number; at: number }> = [];
    queue.subscribe<string>(TOPIC, async (message) => {
      attempts.push({ attempt: message.attempt, at: Date.now() });
      if (message.attempt < 3) throw new Error('provider timed out');
    });
    queue.publish(TOPIC, 'sms');
    await drained(queue);

    assert.deepEqual(
      attempts.map((a) => a.attempt),
      [1, 2, 3],
    );
    // Backoff is base * 2^(attempt-1): 15 ms, then 30 ms. Allow 2 ms of timer granularity.
    assert.ok(attempts[1].at - attempts[0].at >= 13, `first retry came after ${attempts[1].at - attempts[0].at} ms`);
    assert.ok(attempts[2].at - attempts[1].at >= 28, `second retry came after ${attempts[2].at - attempts[1].at} ms`);
    assert.deepEqual(queue.stats()[TOPIC], {
      depth: 0,
      inFlight: 0,
      scheduledRetries: 0,
      published: 1,
      processed: 1,
      retried: 2,
      deadLettered: 0,
    });
    assert.deepEqual(queue.deadLetters(TOPIC), []);
  });

  test('a waiting retry is visible in the stats', async () => {
    const queue = queueWith({ maxAttempts: 2, backoffBaseMs: 150 });
    let calls = 0;
    queue.subscribe(TOPIC, async () => {
      calls += 1;
      if (calls === 1) throw new Error('first attempt fails');
    });
    queue.publish(TOPIC, 'x');
    await eventually(() => calls === 1);
    await sleep(1); // let the queue book the failure; the retry itself is 150 ms away
    assert.equal(queue.stats()[TOPIC].scheduledRetries, 1);
    assert.equal(queue.stats()[TOPIC].retried, 1);
    assert.equal(queue.stats()[TOPIC].inFlight, 0);
    await drained(queue);
    assert.equal(calls, 2);
  });

  test('after the maximum number of attempts the message is dead-lettered', async () => {
    const queue = queueWith({ maxAttempts: 3, backoffBaseMs: 2 });
    const attempts: number[] = [];
    const deadLettered: Array<{ attempt: number; error: string }> = [];
    queue.subscribe<string>(
      TOPIC,
      async (message) => {
        attempts.push(message.attempt);
        throw new Error('SMS provider is down');
      },
      { onDeadLetter: (message, error) => deadLettered.push({ attempt: message.attempt, error: error.message }) },
    );
    const id = queue.publish(TOPIC, 'otp');
    await drained(queue);

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.deepEqual(deadLettered, [{ attempt: 3, error: 'SMS provider is down' }], 'onDeadLetter fires exactly once');

    const dead = queue.deadLetters(TOPIC);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].message.id, id);
    assert.equal(dead[0].message.payload, 'otp');
    assert.equal(dead[0].message.attempt, 3);
    assert.equal(dead[0].error, 'SMS provider is down');
    assert.ok(!Number.isNaN(Date.parse(dead[0].failedAt)));
    assert.deepEqual(queue.stats()[TOPIC], {
      depth: 0,
      inFlight: 0,
      scheduledRetries: 0,
      published: 1,
      processed: 0,
      retried: 2,
      deadLettered: 1,
    });
  });

  test('per-subscription options override the queue defaults', async () => {
    const queue = queueWith({ maxAttempts: 5, backoffBaseMs: 1_000 });
    let calls = 0;
    queue.subscribe(
      TOPIC,
      async () => {
        calls += 1;
        throw new Error('nope');
      },
      { maxAttempts: 1 },
    );
    queue.publish(TOPIC, 'x');
    await drained(queue);
    assert.equal(calls, 1, 'maxAttempts 1 means no retry at all');
    assert.equal(queue.deadLetters(TOPIC).length, 1);
  });

  test('a handler that throws something other than an Error is still handled', async () => {
    const queue = queueWith({ maxAttempts: 1 });
    queue.subscribe(TOPIC, async () => {
      throw 'a bare string'; // eslint-disable-line no-throw-literal
    });
    queue.publish(TOPIC, 'x');
    await drained(queue);
    assert.equal(queue.deadLetters(TOPIC)[0].error, 'a bare string');
  });

  test('a dead-letter hook that throws does not stall the topic or leave drain() hanging', async (t) => {
    const logged = t.mock.method(console, 'error', () => undefined); // the queue reports the broken hook
    const queue = queueWith({ concurrency: 1, maxAttempts: 1 });
    const seen: string[] = [];
    queue.subscribe<string>(
      TOPIC,
      async (message) => {
        seen.push(message.payload);
        if (message.payload === 'bad') throw new Error('handler failed');
      },
      {
        onDeadLetter: () => {
          throw new Error('dead-letter hook failed'); // e.g. the database write that records the failure
        },
      },
    );
    queue.publish(TOPIC, 'bad');
    queue.publish(TOPIC, 'good');

    const outcome = await Promise.race([
      queue.drain().then(() => 'drained'),
      sleep(150).then(() => 'drain() still pending after 150 ms'),
    ]);
    assert.deepEqual(seen, ['bad', 'good'], 'the message queued behind the dead letter is still delivered');
    assert.equal(outcome, 'drained');
    assert.equal(queue.deadLetters(TOPIC).length, 1);
    assert.equal(queue.stats()[TOPIC].processed, 1);
    assert.equal(logged.mock.callCount(), 1, 'the failure of the hook is logged, not swallowed silently');
  });

  test('one poisoned message does not block the others', async () => {
    const queue = queueWith({ concurrency: 1, maxAttempts: 2, backoffBaseMs: 2 });
    const processed: string[] = [];
    queue.subscribe<string>(TOPIC, async (message) => {
      if (message.payload === 'poison') throw new Error('cannot process');
      processed.push(message.payload);
    });
    for (const payload of ['a', 'poison', 'b', 'c']) queue.publish(TOPIC, payload);
    await drained(queue);
    assert.deepEqual(processed.sort(), ['a', 'b', 'c']);
    assert.equal(queue.deadLetters(TOPIC).length, 1);
    assert.equal(queue.deadLetters(TOPIC)[0].message.payload, 'poison');
  });

  test('redrive puts dead letters back for a fresh round of attempts', async () => {
    const queue = queueWith({ maxAttempts: 2, backoffBaseMs: 2 });
    let providerUp = false;
    const delivered: Array<{ payload: string; attempt: number }> = [];
    queue.subscribe<string>(TOPIC, async (message) => {
      if (!providerUp) throw new Error('down');
      delivered.push({ payload: message.payload, attempt: message.attempt });
    });
    queue.publish(TOPIC, 'one');
    queue.publish(TOPIC, 'two');
    await drained(queue);
    assert.equal(queue.deadLetters(TOPIC).length, 2);

    providerUp = true;
    assert.equal(queue.redrive(TOPIC), 2);
    await drained(queue);

    assert.deepEqual(
      delivered.sort((a, b) => a.payload.localeCompare(b.payload)),
      [
        { payload: 'one', attempt: 1 },
        { payload: 'two', attempt: 1 },
      ],
      'redriven messages start again at attempt 1',
    );
    assert.deepEqual(queue.deadLetters(TOPIC), []);
    assert.equal(queue.stats()[TOPIC].deadLettered, 0);
    assert.equal(queue.stats()[TOPIC].processed, 2);
  });

  test('redrive with nothing dead-lettered returns 0', () => {
    const queue = queueWith();
    assert.equal(queue.redrive(TOPIC), 0);
    assert.deepEqual(queue.deadLetters('never-used'), []);
  });

  test('a redriven message that fails again goes back to the dead-letter queue', async () => {
    const queue = queueWith({ maxAttempts: 2, backoffBaseMs: 2 });
    let calls = 0;
    queue.subscribe(TOPIC, async () => {
      calls += 1;
      throw new Error('still down');
    });
    queue.publish(TOPIC, 'x');
    await drained(queue);
    queue.redrive(TOPIC);
    await drained(queue);
    assert.equal(calls, 4);
    assert.equal(queue.deadLetters(TOPIC).length, 1);
  });
});

describe('InMemoryMessageQueue: drain and clear', () => {
  test('drain resolves immediately when the queue is idle', async () => {
    const queue = queueWith();
    await queue.drain();
    queue.subscribe(TOPIC, async () => undefined);
    await queue.drain();
  });

  test('drain waits for queued, in-flight and retrying messages', async () => {
    const queue = queueWith({ concurrency: 1, maxAttempts: 2, backoffBaseMs: 10 });
    const done: string[] = [];
    queue.subscribe<string>(TOPIC, async (message) => {
      await sleep(3);
      if (message.payload === 'flaky' && message.attempt === 1) throw new Error('retry me');
      done.push(`${message.payload}#${message.attempt}`);
    });
    queue.publish(TOPIC, 'slow');
    queue.publish(TOPIC, 'flaky');

    let resolved = false;
    const waiting = drained(queue).then(() => (resolved = true));
    await sleep(1);
    assert.equal(resolved, false);
    await waiting;
    assert.deepEqual(done, ['slow#1', 'flaky#2']);
  });

  test('several drain() callers are all released', async () => {
    const queue = queueWith();
    queue.subscribe(TOPIC, async () => sleep(3));
    queue.publish(TOPIC, 'x');
    const results = await keepAlive(Promise.all([queue.drain(), queue.drain(), queue.drain()]));
    assert.equal(results.length, 3);
  });

  test('clear drops queued messages and dead letters', async () => {
    const queue = queueWith({ maxAttempts: 1 });
    queue.subscribe(TOPIC, async () => {
      throw new Error('fail');
    });
    queue.publish(TOPIC, 'dead');
    await drained(queue);
    assert.equal(queue.deadLetters(TOPIC).length, 1);

    queue.publish('unsubscribed', 'pending');
    queue.clear();
    assert.deepEqual(queue.deadLetters(TOPIC), []);
    assert.equal(queue.stats().unsubscribed.depth, 0);
    await queue.drain();
  });

  test('clear makes an in-flight handler a no-op and releases drain()', async () => {
    const queue = queueWith();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let started = false;
    queue.subscribe(TOPIC, async () => {
      started = true;
      await gate;
    });
    queue.publish(TOPIC, 'x');
    await eventually(() => started);
    assert.equal(queue.stats()[TOPIC].inFlight, 1);

    const waiting = queue.drain();
    queue.clear();
    await waiting;
    assert.equal(queue.stats()[TOPIC].inFlight, 0);

    finish();
    await sleep(5);
    assert.equal(queue.stats()[TOPIC].processed, 0, 'work finished after a clear is not counted');
    assert.equal(queue.stats()[TOPIC].inFlight, 0, 'and must not push the in-flight count below zero');
  });

  test('clear cancels retries that were already scheduled', async () => {
    const queue = queueWith({ maxAttempts: 3, backoffBaseMs: 100 });
    let calls = 0;
    queue.subscribe(TOPIC, async () => {
      calls += 1;
      throw new Error('fail');
    });
    queue.publish(TOPIC, 'x');
    await eventually(() => calls === 1);
    await sleep(1);
    assert.equal(queue.stats()[TOPIC].scheduledRetries, 1);

    queue.clear();
    assert.equal(queue.stats()[TOPIC].scheduledRetries, 0);
    await sleep(130); // well past the 100 ms the retry was scheduled for
    assert.equal(calls, 1, 'the cancelled retry never ran');
    assert.equal(queue.stats()[TOPIC].depth, 0);
  });

  test('a message already handed to a worker is not delivered once the queue was cleared', async () => {
    const queue = queueWith();
    const received: string[] = [];
    queue.subscribe<string>(TOPIC, async (message) => void received.push(message.payload));
    queue.publish(TOPIC, 'before'); // dispatched to a worker, which has not started yet
    queue.clear();
    queue.publish(TOPIC, 'after');
    await drained(queue);
    await sleep(5);
    assert.deepEqual(received, ['after']);
    assert.equal(queue.stats()[TOPIC].processed, 1);
    assert.equal(queue.stats()[TOPIC].inFlight, 0);
  });

  test('the queue keeps working after a clear', async () => {
    const queue = queueWith();
    const received: string[] = [];
    queue.publish(TOPIC, 'before'); // still queued: nobody has subscribed yet
    queue.clear();
    queue.subscribe<string>(TOPIC, async (message) => void received.push(message.payload));
    queue.publish(TOPIC, 'after');
    await drained(queue);
    assert.deepEqual(received, ['after']);
    assert.equal(queue.stats()[TOPIC].processed, 1);
    assert.equal(queue.stats()[TOPIC].inFlight, 0);
  });
});
