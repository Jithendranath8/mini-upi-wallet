// Renders a request trace as a rail: one stop per step the request made inside the system.
import { system } from './api.js';
import { fill, h } from './dom.js';

const watchers = new WeakMap();

/**
 * Shows the trace for `result` (an api() result) in `rail`, and keeps refreshing it for a few
 * seconds because queue workers and the replica add steps after the response was sent.
 */
export function watchTrace(result, rail, metaBox, { title } = {}) {
  const requestId = result.meta.requestId;
  const token = {};
  watchers.set(rail, token);

  fill(
    metaBox,
    title && h('span', { class: 'chip' }, title),
    h('span', { class: `chip ${result.ok ? '' : 'warn'}` }, `HTTP ${result.status} in ${result.ms} ms`),
    result.meta.servedBy && h('span', { class: 'chip' }, `served by ${result.meta.servedBy}`),
    result.meta.dataSource && h('span', { class: `chip ${result.meta.dataSource}` }, `read from ${result.meta.dataSource}`),
    result.meta.replayed && h('span', { class: 'chip warn' }, 'idempotent replay'),
  );

  if (!requestId) {
    fill(rail, h('li', { class: 'rail-empty' }, 'This request was not traced.'));
    return;
  }
  const refresh = async () => {
    if (watchers.get(rail) !== token) return; // a newer request took over this rail
    const { ok, data } = await system('GET', `/traces/${requestId}`);
    if (ok && watchers.get(rail) === token) drawRail(rail, data.steps);
  };
  refresh();
  [700, 1800, 4200].forEach((delay) => setTimeout(refresh, delay));
}

export function drawRail(rail, steps) {
  let previousComponent = null;
  const stops = [];
  for (const step of steps) {
    stops.push(
      h(
        'li',
        { class: `stop ${step.level}` },
        h('span', { class: 'stop-at' }, `${step.atMs} ms`),
        h('span', { class: 'stop-dot' }),
        h(
          'span',
          {},
          step.component !== previousComponent && h('span', { class: 'stop-name' }, step.component),
          h('span', { class: 'stop-text' }, step.message),
        ),
      ),
    );
    previousComponent = step.component;
    if (step.component === 'Response') {
      stops.push(h('li', { class: 'stop boundary' }, 'The client has its answer. Below: background work.'));
      previousComponent = null;
    }
  }
  // Drop the boundary marker if nothing followed it.
  if (stops.length > 0 && stops[stops.length - 1].classList.contains('boundary')) stops.pop();
  fill(rail, stops);
}

export function clearRail(rail, metaBox, message) {
  watchers.delete(rail);
  fill(metaBox);
  fill(rail, h('li', { class: 'rail-empty' }, message));
}
