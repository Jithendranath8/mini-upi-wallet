// Small DOM helpers. Everything user-controlled is inserted as text nodes, never as HTML.

/** h('li', { class: 'row', onclick: fn }, 'text', childNode, ...) */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'class') element.className = value;
    else if (name.startsWith('on') && typeof value === 'function') element.addEventListener(name.slice(2), value);
    else if (value === true) element.setAttribute(name, '');
    else element.setAttribute(name, String(value));
  }
  append(element, children);
  return element;
}

function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function fill(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export const rupees = (amount) =>
  `₹${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

export const dayAndClock = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let toastTimer;
export function toast(message, bad = false) {
  const box = $('#toast');
  box.textContent = message;
  box.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (box.className = 'toast'), 3600);
}

/** Reads a form into a plain object of trimmed strings. */
export function formValues(form) {
  return Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value).trim()]));
}

/** Disables a button while an async action runs, so a double click cannot fire it twice. */
export async function busy(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    return await action();
  } finally {
    button.disabled = false;
  }
}
