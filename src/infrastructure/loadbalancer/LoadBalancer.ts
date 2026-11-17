import { NotFoundError, ServiceUnavailableError } from '../../domain/errors';

/** One stateless application server instance. Any node can serve any request. */
export class AppNode {
  healthy = true;
  served = 0;

  constructor(readonly id: string) {}
}

/** PATTERN: Strategy. How the next node is chosen is swappable (round robin, least connections, ...). */
export interface LoadBalancingStrategy {
  readonly name: string;
  pick(healthyNodes: AppNode[]): AppNode;
}

export class RoundRobinStrategy implements LoadBalancingStrategy {
  readonly name = 'round-robin';
  #cursor = 0;

  pick(healthyNodes: AppNode[]): AppNode {
    const node = healthyNodes[this.#cursor % healthyNodes.length];
    this.#cursor += 1;
    return node;
  }
}

/**
 * Spreads requests across app nodes and routes around unhealthy ones.
 * In this prototype the nodes are logical (one process); in production this is
 * Nginx / an ALB in front of N identical containers. It works because the app tier keeps no
 * state of its own: everything shared lives in the database, cache and queue.
 */
export class LoadBalancer {
  readonly #nodes: AppNode[];

  constructor(
    nodeCount: number,
    private readonly strategy: LoadBalancingStrategy,
  ) {
    this.#nodes = Array.from({ length: nodeCount }, (_, i) => new AppNode(`app-node-${i + 1}`));
  }

  route(): AppNode {
    const healthy = this.#nodes.filter((node) => node.healthy);
    if (healthy.length === 0) {
      throw new ServiceUnavailableError('NO_HEALTHY_NODES', 'No application server is available right now.');
    }
    const node = this.strategy.pick(healthy);
    node.served += 1;
    return node;
  }

  setHealth(nodeId: string, healthy: boolean): AppNode {
    const node = this.#nodes.find((n) => n.id === nodeId);
    if (!node) throw new NotFoundError('NODE_NOT_FOUND', `No app node named ${nodeId}.`);
    node.healthy = healthy;
    return node;
  }

  healAll(): void {
    this.#nodes.forEach((node) => (node.healthy = true));
  }

  stats(): { strategy: string; nodes: Array<{ id: string; healthy: boolean; served: number }> } {
    return {
      strategy: this.strategy.name,
      nodes: this.#nodes.map(({ id, healthy, served }) => ({ id, healthy, served })),
    };
  }
}
