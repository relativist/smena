const DIGIT = /\p{Decimal_Number}/u;
const EXCLUDED = ".brand, .admin-rail-brand, .students-brand, .teachers-brand, .auth-brand-name, .sp-sheet, .sp-measure-host, script, style, noscript";
const CONTROLS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON"]);
const BLOCKS = new Set(["DIV", "P", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "NAV", "FORM", "FIELDSET", "TABLE", "THEAD", "TBODY", "TR", "UL", "OL", "LI", "DIALOG"]);
const PHRASES = new Set(["SPAN", "B", "STRONG", "SMALL", "P", "H1", "H2", "H3", "H4", "H5", "H6", "TD", "TH", "LABEL", "BUTTON", "A", "LI", "DT", "DD", "SUMMARY", "LEGEND", "TIME", "OPTION"]);
type PhraseBoundary = (element: HTMLElement) => boolean;

// Controls are separate phrases: an unnumbered field label must not inherit
// the digits of every option in the select below it.
function inlineText(element: HTMLElement, isBoundary: PhraseBoundary): string {
  let text = "";
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    else if (child instanceof HTMLElement && !CONTROLS.has(child.tagName) && !isBoundary(child) && !child.matches(EXCLUDED)) text += inlineText(child, isBoundary);
  }
  return text;
}

function phraseText(element: HTMLElement, isBoundary: PhraseBoundary): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value || element.placeholder;
  if (element instanceof HTMLSelectElement) return Array.from(element.selectedOptions, option => option.textContent ?? "").join(" ");
  const directText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
  if (!directText && !PHRASES.has(element.tagName)) return null;
  // A lesson card or panel contains several independent phrases. Never make
  // the entire container use the numeric face because one child has a room.
  if (Array.from(element.children).some(child => child instanceof HTMLElement && !CONTROLS.has(child.tagName) && isBoundary(child))) return null;
  return inlineText(element, isBoundary);
}

/** Apply the numeric font policy to rendered phrases without wrapping or
 * replacing React-owned nodes. Only added subtrees and changed owners are
 * revisited; typing never scans the whole schedule. */
export function observeNumericTypography(root: HTMLElement): () => void {
  let active = true;
  let queued = false;
  const subtrees = new Set<HTMLElement>();
  const owners = new Set<HTMLElement>();
  const changes = new Map<HTMLElement, boolean>();
  let boundaries = new WeakMap<HTMLElement, boolean>();

  const isBoundary: PhraseBoundary = element => {
    if (BLOCKS.has(element.tagName)) return true;
    let boundary = boundaries.get(element);
    if (boundary === undefined) {
      // Flex/grid children can be spans while still forming separate lines
      // (for example, a subject name above its hour counter).
      const display = getComputedStyle(element).display;
      boundary = display !== "inline" && display !== "contents" && display !== "none";
      boundaries.set(element, boundary);
    }
    return boundary;
  };

  const applyChanges = () => {
    // Read phrase boundaries first, then write attributes, avoiding repeated
    // style recalculation between individual elements in a large schedule.
    for (const [element, numeric] of changes) element.toggleAttribute("data-numeric-font", numeric);
    changes.clear();
    boundaries = new WeakMap();
  };

  const update = (element: HTMLElement) => {
    if (!element.isConnected || element.closest(EXCLUDED)) return;
    const text = phraseText(element, isBoundary);
    const numeric = text !== null && DIGIT.test(text);
    if (numeric !== element.hasAttribute("data-numeric-font")) changes.set(element, numeric);
  };

  const scan = (element: HTMLElement) => {
    if (element.closest(EXCLUDED)) return;
    update(element);
    const walker = root.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => node instanceof HTMLElement && !node.matches(EXCLUDED) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });
    while (walker.nextNode()) update(walker.currentNode as HTMLElement);
  };

  const flush = () => {
    queued = false;
    if (!active) return;
    for (const subtree of subtrees) {
      let ancestor = subtree.parentElement;
      while (ancestor && !subtrees.has(ancestor)) ancestor = ancestor.parentElement;
      if (!ancestor) scan(subtree);
    }
    subtrees.clear();
    for (const owner of owners) update(owner);
    owners.clear();
    applyChanges();
  };

  const enqueue = (element: HTMLElement, includeAncestors = true) => {
    for (let owner: HTMLElement | null = element; owner && root.contains(owner); owner = includeAncestors ? owner.parentElement : null) owners.add(owner);
    if (!queued) {
      queued = true;
      queueMicrotask(flush);
    }
  };

  scan(root);
  applyChanges();
  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      if (target) enqueue(target);
      for (const added of record.addedNodes) {
        if (added instanceof HTMLElement) subtrees.add(added);
      }
    }
  });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["value", "placeholder", "selected", "type"] });
  const controlChanged = (event: Event) => {
    // A control's value is a separate phrase and is excluded from parent
    // labels. Typing only needs a digit check on that field, with no layout reads.
    if (event.target instanceof HTMLElement) enqueue(event.target, !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName));
  };
  root.addEventListener("input", controlChanged, true);
  root.addEventListener("change", controlChanged, true);

  return () => {
    active = false;
    observer.disconnect();
    root.removeEventListener("input", controlChanged, true);
    root.removeEventListener("change", controlChanged, true);
    subtrees.clear();
    owners.clear();
    changes.clear();
  };
}
