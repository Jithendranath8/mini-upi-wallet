import { randomUUID } from 'node:crypto';

/** Prefixed, unguessable identifiers, e.g. `txn_3f9c1a7e5b2d4c60`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}
