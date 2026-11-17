// Design documents: renders the Markdown files in /docs, including their Mermaid diagrams.
import { system } from './api.js';
import { $, fill, h } from './dom.js';

let documents = null;
let renderCount = 0;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const script = h('script', { src });
    script.addEventListener('load', resolve);
    script.addEventListener('error', () => reject(new Error(`Could not load ${src}`)));
    document.head.append(script);
  });
}

async function libraries() {
  await Promise.all([loadScript('/vendor/marked/marked.umd.js'), loadScript('/vendor/mermaid/mermaid.min.js')]);
  if (!libraries.ready) {
    // The documents are plain Markdown; raw HTML inside them is dropped rather than executed.
    window.marked.use({ renderer: { html: () => '' } });
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      themeVariables: {
        primaryColor: '#e6e9f8',
        primaryBorderColor: '#21309a',
        primaryTextColor: '#151a3d',
        lineColor: '#4e5677',
        secondaryColor: '#e0f2e8',
        tertiaryColor: '#fdf0d9',
        clusterBkg: '#f3f5fb',
        clusterBorder: '#bcc3d8',
        noteBkgColor: '#fdf0d9',
        noteBorderColor: '#f6a01a',
        fontSize: '14px',
      },
    });
    libraries.ready = true;
  }
}

export async function showDesign(file) {
  if (!documents) {
    const result = await system('GET', '/docs');
    documents = result.ok ? result.data : [];
  }
  const list = $('#doc-list');
  const body = $('#doc-body');
  if (documents.length === 0) {
    fill(list);
    return fill(body, h('p', {}, 'No design documents were found in the docs folder.'));
  }
  const current = documents.find((doc) => doc.file === file) ?? documents[0];
  fill(
    list,
    documents.map((doc) =>
      h('a', { href: `#design/${doc.file}`, 'aria-current': doc === current ? 'page' : null }, doc.title),
    ),
  );

  const token = (renderCount += 1);
  const [text] = await Promise.all([
    fetch(`/design-docs/${encodeURIComponent(current.file)}`).then((response) => (response.ok ? response.text() : '')),
    libraries(),
  ]);
  if (token !== renderCount) return; // another document was opened meanwhile

  body.innerHTML = window.marked.parse(text || 'This document is empty.');
  body.scrollIntoView({ block: 'start' });
  window.scrollTo({ top: 0 });

  // Images in the documents are written relative to the docs folder (so they also work on
  // GitHub); here they must be loaded from where that folder is served.
  body.querySelectorAll('img').forEach((image) => {
    const source = image.getAttribute('src') ?? '';
    if (!/^([a-z]+:|\/)/i.test(source)) image.src = `/design-docs/${source}`;
    image.style.maxWidth = '100%';
    image.style.height = 'auto';
  });

  body.querySelectorAll('table').forEach((table) => {
    const wrapper = h('div', { class: 'table-scroll' });
    table.replaceWith(wrapper);
    wrapper.append(table);
  });

  const blocks = [...body.querySelectorAll('pre > code.language-mermaid')];
  for (const [index, code] of blocks.entries()) {
    const holder = h('div', { class: 'diagram' });
    const id = `diagram-${token}-${index}`;
    code.parentElement.replaceWith(holder);
    try {
      const { svg } = await window.mermaid.render(id, code.textContent);
      if (token !== renderCount) return;
      holder.innerHTML = svg;
      // Mermaid shrinks a wide diagram to fit, which makes its text unreadable. Keep it close
      // to natural size instead and let the diagram scroll sideways inside its frame.
      const drawing = holder.querySelector('svg');
      const natural = parseFloat(drawing?.style.maxWidth ?? '');
      if (drawing && natural > holder.clientWidth) {
        drawing.style.minWidth = `${Math.min(natural, holder.clientWidth * 1.8)}px`;
        holder.style.textAlign = 'left';
        holder.tabIndex = 0; // scrollable regions must be reachable by keyboard
      }
    } catch (error) {
      document.getElementById(`d${id}`)?.remove(); // Mermaid leaves an error node behind
      holder.classList.add('broken');
      holder.dataset.error = String(error?.message ?? error);
      fill(holder, h('p', {}, `This diagram could not be drawn: ${error?.message ?? error}`), h('pre', {}, code.textContent));
    }
  }
}
