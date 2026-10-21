import { useEffect, useRef, useState, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { applyHighlight, getSelectionAnchor, type Anchor } from "./highlight";
import CollectionPicker from "./CollectionPicker";

const API_URL = import.meta.env.VITE_API_URL;
const PENDING = "pending"; // id for the temporary highlight shown while the tooltip is open

type FullDoc = {
  docId: string;
  url: string;
  title?: string;
  byline?: string;
  error?: string;
  content: string | null;
};

type Annotation = Anchor & {
  annotationId: string;
  note: string;
  createdAt: string;
  collectionIds: string[]; // IDs only; names come from the collections list
};

type Collection = { collectionId: string; name: string };

// Which field to focus when the expanded editor opens (false = show the compact toolbar)
type EditorFocus = false | "note" | "collection";

type Popover =
  | { mode: "new"; anchor: Anchor; top: number; left: number; editing: EditorFocus }
  | { mode: "edit"; annotationId: string; notice?: string; top: number; left: number; editing: EditorFocus };

// ---------- Icons (from the Lucide icon set) ----------
const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
const HighlighterIcon = () => (
  <svg {...iconProps}>
    <path d="m9 11-6 6v3h9l3-3" />
    <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
  </svg>
);
const NoteIcon = () => (
  <svg {...iconProps}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);
const FolderIcon = () => (
  <svg {...iconProps}>
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);
const TrashIcon = () => (
  <svg {...iconProps}>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

// ---------- Helpers ----------
async function fetchAnnotations(docId: string): Promise<Annotation[]> {
  const res = await fetch(`${API_URL}documents/${docId}/annotations`);
  if (!res.ok) throw new Error();
  const data: Annotation[] = await res.json();
  return data
    .map((a) => ({ ...a, collectionIds: a.collectionIds ?? [] }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function fetchCollections(): Promise<Collection[]> {
  const res = await fetch(`${API_URL}collections`);
  if (!res.ok) throw new Error();
  return res.json();
}

// Some sites (like arXiv) put their own bullet or number inside each <li>; remove the duplicate
function removeDuplicateListMarkers(el: HTMLElement) {
  el.querySelectorAll("li").forEach((li) => {
    const first = li.firstElementChild;
    const text = first?.textContent?.trim() ?? "";
    if (first?.tagName === "SPAN" && /^([•·∙◦▪–\-*]|\(?\w{1,4}[.)])$/.test(text)) {
      first.remove();
    }
  });
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Place the tooltip centered just ABOVE something, without going off the screen edges
function positionAbove(rect: DOMRect) {
  const half = 160;
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(center, half + 8), window.innerWidth - half - 8);
  return { top: rect.top + window.scrollY - 10, left: left + window.scrollX };
}

export default function Reader({
  docId,
  onBack,
  focusAnnotationId = null,
}: {
  docId: string;
  onBack: () => void;
  focusAnnotationId?: string | null;
}) {
  const [doc, setDoc] = useState<FullDoc | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [collectionsDraft, setCollectionsDraft] = useState<string[]>([]);
  const [lastCollections, setLastCollections] = useState<string[]>([]); // remembered between highlights
  const [listEditingId, setListEditingId] = useState<string | null>(null);
  const [listNoteDraft, setListNoteDraft] = useState("");
  const [listCollectionsDraft, setListCollectionsDraft] = useState<string[]>([]);
  const [listFocus, setListFocus] = useState<"note" | "collection">("note");
  const [hover, setHover] = useState<{ note: string; collections: string[]; top: number; left: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrolledToFocus = useRef(false); // only jump to a highlight once, not on every redraw

  const pendingAnchor = popover?.mode === "new" ? popover.anchor : null;

  // Highlights store collection IDs; turn them into names for display
  const nameById = new Map(collections.map((c) => [c.collectionId, c.name]));
  function namesFor(a?: Annotation): string[] {
    return (a?.collectionIds ?? []).map((id) => nameById.get(id)).filter((n): n is string => Boolean(n));
  }

  // Load the article, its highlights, and the collections
  useEffect(() => {
    fetch(`${API_URL}documents/${docId}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(setDoc)
      .catch(() => setLoadError(true));
    fetchAnnotations(docId).then(setAnnotations).catch(() => {});
    fetchCollections().then(setCollections).catch(() => {});
  }, [docId]);

  // Draw the article → clean it up → saved highlights → the pending one on top
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !doc?.content) return;
    el.innerHTML = DOMPurify.sanitize(doc.content);
    removeDuplicateListMarkers(el);
    for (const a of annotations) applyHighlight(el, a, a.annotationId);
    if (pendingAnchor) applyHighlight(el, pendingAnchor, PENDING);

    // Opened from a collection? Scroll to that highlight once, with a flash
    if (focusAnnotationId && !scrolledToFocus.current) {
      const mark = el.querySelector<HTMLElement>(`mark[data-id="${focusAnnotationId}"]`);
      if (mark) {
        scrolledToFocus.current = true;
        mark.scrollIntoView({ behavior: "smooth", block: "center" });
        el.querySelectorAll(`mark[data-id="${focusAnnotationId}"]`).forEach((m) => m.classList.add("flash"));
      }
    }
  }, [doc, annotations, pendingAnchor, focusAnnotationId]);

  // Escape closes the tooltip
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reload collections first, then highlights, so new collection names are known before tags show
  async function refresh() {
    const [cols, anns] = await Promise.all([fetchCollections(), fetchAnnotations(docId)]);
    setCollections(cols);
    setAnnotations(anns);
  }

  function openExisting(annotationId: string, rect: DOMRect, notice?: string) {
    const existing = annotations.find((a) => a.annotationId === annotationId);
    setNoteDraft(existing?.note ?? "");
    setCollectionsDraft(namesFor(existing));
    setPopover({ mode: "edit", annotationId, notice, editing: false, ...positionAbove(rect) });
  }

  function openEditor(focus: "note" | "collection") {
    if (popover) setPopover({ ...popover, editing: focus });
  }

  // ---------- Hover preview ----------
  function handleMouseOver(e: MouseEvent<HTMLDivElement>) {
    if (popover) return;
    const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-id]");
    if (!mark || mark.dataset.id === PENDING) return;
    const a = annotations.find((x) => x.annotationId === mark.dataset.id);
    const names = namesFor(a);
    if (a && (a.note || names.length)) {
      setHover({ note: a.note, collections: names, ...positionAbove(mark.getBoundingClientRect()) });
    }
  }

  function handleMouseOut(e: MouseEvent<HTMLDivElement>) {
    const from = (e.target as HTMLElement).closest("mark[data-id]");
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest("mark[data-id]") : null;
    if (from && from !== to) setHover(null);
  }

  // ---------- Clicks and selections ----------
  function handleMouseUp(e: MouseEvent<HTMLDivElement>) {
    setHover(null);
    const el = bodyRef.current;
    if (!el) return;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    // 1. Plain click: on a saved highlight → open it; anywhere else → close
    if (!range || range.collapsed) {
      const mark = (e.target as HTMLElement).closest<HTMLElement>("mark[data-id]");
      if (mark && mark.dataset.id !== PENDING) openExisting(mark.dataset.id!, mark.getBoundingClientRect());
      else setPopover(null);
      return;
    }

    // 2. Selection touching a saved highlight → open that one, no duplicates
    const saved = Array.from(el.querySelectorAll<HTMLElement>("mark[data-id]")).filter(
      (m) => m.dataset.id !== PENDING
    );
    const overlapping = saved.find((m) => range.intersectsNode(m));
    if (overlapping) {
      selection!.removeAllRanges();
      openExisting(overlapping.dataset.id!, overlapping.getBoundingClientRect(), "Already highlighted");
      return;
    }

    // 3. New selection → show the toolbar
    const anchor = getSelectionAnchor(el);
    if (!anchor) {
      setPopover(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    selection!.removeAllRanges(); // the pending highlight shows the selection instead
    setNoteDraft("");
    setCollectionsDraft(lastCollections); // pre-fill the collections you used last
    setPopover({ mode: "new", anchor, editing: false, ...positionAbove(rect) });
  }

  // ---------- API calls ----------
  async function createHighlight(note: string, collectionNames: string[]) {
    if (popover?.mode !== "new") return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}documents/${docId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...popover.anchor, note: note.trim(), collections: collectionNames }),
      });
      if (!res.ok) throw new Error();
      if (collectionNames.length) setLastCollections(collectionNames);
      setPopover(null);
      await refresh();
    } catch {
      alert("Couldn't save that highlight. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function updateAnnotation(annotationId: string, note: string, collectionNames: string[]) {
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}documents/${docId}/annotations/${annotationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note.trim(), collections: collectionNames }),
      });
      if (!res.ok) throw new Error();
      if (collectionNames.length) setLastCollections(collectionNames);
      await refresh();
      return true;
    } catch {
      alert("Couldn't save your changes. Try again.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function removeHighlight(annotationId: string) {
    setSaving(true);
    try {
      await fetch(`${API_URL}documents/${docId}/annotations/${annotationId}`, { method: "DELETE" });
      setAnnotations((current) => current.filter((a) => a.annotationId !== annotationId));
      setPopover(null);
      if (listEditingId === annotationId) setListEditingId(null);
    } finally {
      setSaving(false);
    }
  }

  // Open the inline editor in the highlights list, with the cursor in the chosen field
  function startListEdit(a: Annotation, focus: "note" | "collection") {
    setListEditingId(a.annotationId);
    setListNoteDraft(a.note);
    setListCollectionsDraft(namesFor(a));
    setListFocus(focus);
  }

  function scrollToHighlight(annotationId: string) {
    document
      .querySelector(`mark[data-id="${annotationId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---------- Loading and error states ----------
  if (loadError) {
    return (
      <div>
        <button className="btn btn-ghost back" onClick={onBack}>← All articles</button>
        <p className="message message-error">Couldn't load this article.</p>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="reader-loading">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-text" />
      </div>
    );
  }

  const openAnnotation =
    popover?.mode === "edit" ? annotations.find((a) => a.annotationId === popover.annotationId) : undefined;

  // ---------- The reader ----------
  return (
    <article className="reader">
      <button className="btn btn-ghost back" onClick={onBack}>← All articles</button>

      <header className="reader-header">
        <div className="card-meta">
          <span>{hostname(doc.url)}</span>
          <span aria-hidden>·</span>
          <a href={doc.url} target="_blank" rel="noreferrer">View original ↗</a>
        </div>
        <h1 className="reader-title">{doc.title ?? doc.url}</h1>
        {doc.byline && <p className="byline">{doc.byline}</p>}
      </header>

      {/* ---------- Highlights list ---------- */}
      {annotations.length > 0 && (
        <details className="notes" open>
          <summary>Highlights ({annotations.length})</summary>
          <ul>
            {annotations.map((a) => {
              const editing = listEditingId === a.annotationId;
              const names = namesFor(a);
              return (
                <li key={a.annotationId}>
                  <button className="note-quote" onClick={() => scrollToHighlight(a.annotationId)}>
                    “{a.exact}”
                  </button>

                  {editing ? (
                    <div className="note-editor">
                      <textarea
                        autoFocus={listFocus === "note"}
                        rows={2}
                        value={listNoteDraft}
                        onChange={(e) => setListNoteDraft(e.target.value)}
                        placeholder="Add a note…"
                      />
                      <CollectionPicker
                        values={listCollectionsDraft}
                        onChange={setListCollectionsDraft}
                        options={collections}
                        autoFocus={listFocus === "collection"}
                      />
                      <div className="note-editor-actions">
                        <button className="btn btn-small btn-ghost" onClick={() => setListEditingId(null)}>
                          Cancel
                        </button>
                        <button
                          className="btn btn-small btn-primary"
                          disabled={saving}
                          onClick={async () => {
                            const ok = await updateAnnotation(a.annotationId, listNoteDraft, listCollectionsDraft);
                            if (ok) setListEditingId(null);
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {names.length > 0 && (
                        <div className="chip-row">
                          {names.map((n) => (
                            <button
                              key={n}
                              className="chip chip-button"
                              onClick={() => startListEdit(a, "collection")}
                              title="Edit collections"
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      )}
                      {a.note && <p className="note-text">{a.note}</p>}
                      <div className="note-actions">
                        <button className="link-btn" onClick={() => startListEdit(a, "note")}>
                          {a.note ? "Edit note" : "Add note"}
                        </button>
                        <button className="link-btn" onClick={() => startListEdit(a, "collection")}>
                          {names.length ? "Edit collections" : "Add to collection"}
                        </button>
                        <button className="link-btn link-danger" onClick={() => removeHighlight(a.annotationId)}>
                          Remove
                        </button>
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* ---------- Article ---------- */}
      {doc.content ? (
        <div
          ref={bodyRef}
          className="article-body"
          onMouseUp={handleMouseUp}
          onMouseOver={handleMouseOver}
          onMouseOut={handleMouseOut}
        />
      ) : (
        <p className="message message-error">
          Couldn't load this article{doc.error ? `: ${doc.error}` : ""}.
        </p>
      )}

      {/* ---------- Hover preview ---------- */}
      {hover && !popover && (
        <div className="note-preview" style={{ top: hover.top, left: hover.left }}>
          {hover.collections.length > 0 && (
            <div className="preview-chips">
              {hover.collections.map((n) => (
                <span key={n} className="chip chip-dark">{n}</span>
              ))}
            </div>
          )}
          {hover.note && <div>{hover.note}</div>}
        </div>
      )}

      {/* ---------- Tooltip ---------- */}
      {popover && (
        <div
          className={`tooltip ${popover.editing ? "tooltip-expanded" : ""}`}
          style={{ top: popover.top, left: popover.left }}
        >
          {!popover.editing ? (
            <div className="tooltip-toolbar">
              {popover.mode === "new" ? (
                <>
                  <button onClick={() => createHighlight("", [])} disabled={saving}>
                    <HighlighterIcon /> Highlight
                  </button>
                  <span className="tooltip-divider" />
                  <button onClick={() => openEditor("note")}>
                    <NoteIcon /> Note
                  </button>
                  <button onClick={() => openEditor("collection")}>
                    <FolderIcon /> Collections
                  </button>
                </>
              ) : (
                <>
                  {popover.notice && <span className="tooltip-label">{popover.notice}</span>}
                  <button onClick={() => openEditor("note")}>
                    <NoteIcon /> {openAnnotation?.note ? "Edit note" : "Note"}
                  </button>
                  <button onClick={() => openEditor("collection")}>
                    <FolderIcon /> Collections
                  </button>
                  <span className="tooltip-divider" />
                  <button onClick={() => removeHighlight(popover.annotationId)} disabled={saving}>
                    <TrashIcon /> Remove
                  </button>
                </>
              )}
            </div>
          ) : (
            <div className="tooltip-editor">
              <textarea
                autoFocus={popover.editing === "note"}
                rows={3}
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Write a note…"
              />
              <CollectionPicker
                dark
                values={collectionsDraft}
                onChange={setCollectionsDraft}
                options={collections}
                autoFocus={popover.editing === "collection"}
              />
              <div className="tooltip-editor-actions">
                <button className="tooltip-text-btn" onClick={() => setPopover(null)}>
                  Cancel
                </button>
                <button
                  className="tooltip-save-btn"
                  disabled={saving}
                  onClick={async () => {
                    if (popover.mode === "new") {
                      await createHighlight(noteDraft, collectionsDraft);
                    } else if (await updateAnnotation(popover.annotationId, noteDraft, collectionsDraft)) {
                      setPopover(null);
                    }
                  }}
                >
                  {saving ? "Saving…" : popover.mode === "new" ? "Save highlight" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}