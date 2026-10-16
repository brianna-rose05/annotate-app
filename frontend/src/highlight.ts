export type Anchor = { exact: string; prefix: string; suffix: string };

const CONTEXT = 30; // characters of surrounding text to save

// Turn the user's current text selection into an anchor
export function getSelectionAnchor(container: HTMLElement): Anchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null; // selected outside the article

  const exact = range.toString();
  if (!exact.trim()) return null;

  // Count how many characters of the article come before the selection
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const end = start + exact.length;

  const text = container.textContent ?? "";
  return {
    exact,
    prefix: text.slice(Math.max(0, start - CONTEXT), start),
    suffix: text.slice(end, end + CONTEXT),
  };
}

// Find where an anchor's text is, using prefix/suffix to pick the right match
function findPosition(text: string, anchor: Anchor): number {
  let best = -1;
  let bestScore = -1;
  let i = text.indexOf(anchor.exact);

  while (i !== -1) {
    const end = i + anchor.exact.length;
    let score = 0;
    if (text.slice(Math.max(0, i - anchor.prefix.length), i) === anchor.prefix) score++;
    if (text.slice(end, end + anchor.suffix.length) === anchor.suffix) score++;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
    i = text.indexOf(anchor.exact, i + 1); // look for the next match
  }
  return best;
}

// Wrap characters [start, end) of the article in <mark> tags
function wrapRange(container: HTMLElement, start: number, end: number, id: string) {
  // Collect every piece of text in the article, in order
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  let pos = 0;
  for (const node of nodes) {
    const nodeStart = pos;
    const nodeEnd = pos + node.length;
    pos = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) continue; // not part of the highlight

    // Cut out just the part of this text that's inside the highlight
    let target = node;
    const from = Math.max(start - nodeStart, 0);
    const to = Math.min(end - nodeStart, node.length);
    if (from > 0) target = target.splitText(from);
    if (to - from < target.length) target.splitText(to - from);

    // Wrap that part in <mark>
    const mark = document.createElement("mark");
    mark.dataset.id = id;
    target.parentNode!.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

// Find an anchor in the article and highlight it
export function applyHighlight(container: HTMLElement, anchor: Anchor, id: string): boolean {
  const text = container.textContent ?? "";
  const start = findPosition(text, anchor);
  if (start === -1) return false; // text not found (article may have changed)
  wrapRange(container, start, start + anchor.exact.length, id);
  return true;
}