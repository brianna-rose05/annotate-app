import { useEffect, useRef, useState, type MouseEvent } from "react";
import DOMPurify from "dompurify";
import { applyHighlight, getSelectionAnchor, type Anchor } from "./highlight";

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
  collectionId?: string;
  collectionName?: string;
};

type Collection = { collectionId: string; name: string };

// Which field to focus when the expanded editor opens (false = show the compact toolbar)
type EditorFocus = false | "note" | "collection";

type Popover =
  | {
      mode: "new";
      anchor: Anchor;
      top: number;
      left: number;
      editing: EditorFocus;
    }
  | {
      mode: "edit";
      annotationId: string;
      notice?: string;
      top: number;
      left: number;
      editing: EditorFocus;
    };

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
  return data.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function fetchCollections(): Promise<Collection[]> {
  const res = await fetch(`${API_URL}collections`);
  if (!res.ok) throw new Error();
  return res.json();
}

function removeDuplicateListMarkers(el: HTMLElement) {
  el.querySelectorAll("li").forEach((li) => {
    const first = li.firstElementChild;
    const text = first?.textContent?.trim() ?? "";
    if (
      first?.tagName === "SPAN" &&
      /^([•·∙◦▪–\-*]|\(?\w{1,4}[.)])$/.test(text)
    ) {
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

function positionAbove(rect: DOMRect) {
  const half = 160;
  const center = rect.left + rect.width / 2;
  const left = Math.min(
    Math.max(center, half + 8),
    window.innerWidth - half - 8,
  );
  return { top: rect.top + window.scrollY - 10, left: left + window.scrollX };
}

export default function Reader({
  docId,
  onBack,
}: {
  docId: string;
  onBack: () => void;
}) {
  const [doc, setDoc] = useState<FullDoc | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [popover, setPopover] = useState<Popover | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [collectionDraft, setCollectionDraft] = useState("");
  const [lastCollection, setLastCollection] = useState(""); // remembered between highlights
  const [listEditingId, setListEditingId] = useState<string | null>(null);
  const [listNoteDraft, setListNoteDraft] = useState("");
  const [listCollectionDraft, setListCollectionDraft] = useState("");
  const [listFocus, setListFocus] = useState<"note" | "collection">("note");
  const [hover, setHover] = useState<{
    note: string;
    collection?: string;
    top: number;
    left: number;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const pendingAnchor = popover?.mode === "new" ? popover.anchor : null;

  // Load the article, its highlights, and the collection names (for suggestions)
  useEffect(() => {
    fetch(`${API_URL}documents/${docId}`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(setDoc)
      .catch(() => setLoadError(true));
    fetchAnnotations(docId)
      .then(setAnnotations)
      .catch(() => {});
    fetchCollections()
      .then(setCollections)
      .catch(() => {});
  }, [docId]);

  // Draw the article → clean it up → saved highlights → the pending one on top
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !doc?.content) return;
    el.innerHTML = DOMPurify.sanitize(doc.content);
    removeDuplicateListMarkers(el);
    for (const a of annotations) applyHighlight(el, a, a.annotationId);
    if (pendingAnchor) applyHighlight(el, pendingAnchor, PENDING);
  }, [doc, annotations, pendingAnchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopover(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openExisting(annotationId: string, rect: DOMRect, notice?: string) {
    const existing = annotations.find((a) => a.annotationId === annotationId);
    setNoteDraft(existing?.note ?? "");
    setCollectionDraft(existing?.collectionName ?? "");
    setPopover({
      mode: "edit",
      annotationId,
      notice,
      editing: false,
      ...positionAbove(rect),
    });
  }

  function openEditor(focus: "note" | "collection") {
    if (popover) setPopover({ ...popover, editing: focus });
  }

  // ---------- Hover preview ----------
  function handleMouseOver(e: MouseEvent<HTMLDivElement>) {
    if (popover) return;
    const mark = (e.target as HTMLElement).closest<HTMLElement>(
      "mark[data-id]",
    );
    if (!mark || mark.dataset.id === PENDING) return;
    const a = annotations.find((x) => x.annotationId === mark.dataset.id);
    if (a && (a.note || a.collectionName)) {
      setHover({
        note: a.note,
        collection: a.collectionName,
        ...positionAbove(mark.getBoundingClientRect()),
      });
    }
  }

  function handleMouseOut(e: MouseEvent<HTMLDivElement>) {
    const from = (e.target as HTMLElement).closest("mark[data-id]");
    const to =
      e.relatedTarget instanceof Element
        ? e.relatedTarget.closest("mark[data-id]")
        : null;
    if (from && from !== to) setHover(null);
  }

  // ---------- Clicks and selections ----------
  function handleMouseUp(e: MouseEvent<HTMLDivElement>) {
    setHover(null);
    const el = bodyRef.current;
    if (!el) return;
    const selection = window.getSelection();
    const range =
      selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    // 1. Plain click: on a saved highlight → open it; anywhere else → close
    if (!range || range.collapsed) {
      const mark = (e.target as HTMLElement).closest<HTMLElement>(
        "mark[data-id]",
      );
      if (mark && mark.dataset.id !== PENDING)
        openExisting(mark.dataset.id!, mark.getBoundingClientRect());
      else setPopover(null);
      return;
    }

    // 2. Selection touching a saved highlight → open that one, no duplicates
    const saved = Array.from(
      el.querySelectorAll<HTMLElement>("mark[data-id]"),
    ).filter((m) => m.dataset.id !== PENDING);
    const overlapping = saved.find((m) => range.intersectsNode(m));
    if (overlapping) {
      selection!.removeAllRanges();
      openExisting(
        overlapping.dataset.id!,
        overlapping.getBoundingClientRect(),
        "Already highlighted",
      );
      return;
    }

    // 3. New selection → show the toolbar
    const anchor = getSelectionAnchor(el);
    if (!anchor) {
      setPopover(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    selection!.removeAllRanges();
    setNoteDraft("");
    setCollectionDraft(lastCollection); // pre-fill the last collection you used
    setPopover({ mode: "new", anchor, editing: false, ...positionAbove(rect) });
  }

  // ---------- API calls ----------
  async function createHighlight(note: string, collection: string) {
    if (popover?.mode !== "new") return;
    setSaving(true);
    try {
      const res = await fetch(`${API_URL}documents/${docId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...popover.anchor,
          note: note.trim(),
          collection: collection.trim(),
        }),
      });
      if (!res.ok) throw new Error();
      if (collection.trim()) setLastCollection(collection.trim());
      setPopover(null);
      setAnnotations(await fetchAnnotations(docId));
      setCollections(await fetchCollections()); // a new collection may have been created
    } catch {
      alert("Couldn't save that highlight. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function updateAnnotation(
    annotationId: string,
    note: string,
    collection: string,
  ) {
    setSaving(true);
    try {
      const res = await fetch(
        `${API_URL}documents/${docId}/annotations/${annotationId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            note: note.trim(),
            collection: collection.trim(),
          }),
        },
      );
      if (!res.ok) throw new Error();
      const updated: Annotation = await res.json();
      setAnnotations((current) =>
        current.map((a) => (a.annotationId === annotationId ? updated : a)),
      );
      if (collection.trim()) setLastCollection(collection.trim());
      setCollections(await fetchCollections());
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
      await fetch(`${API_URL}documents/${docId}/annotations/${annotationId}`, {
        method: "DELETE",
      });
      setAnnotations((current) =>
        current.filter((a) => a.annotationId !== annotationId),
      );
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
    setListCollectionDraft(a.collectionName ?? "");
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
        <button className="btn btn-ghost back" onClick={onBack}>
          ← All articles
        </button>
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

  // ---------- The reader ----------
  return (
    <article className="reader">
      {/* Suggestions for every collection field on this page */}
      <datalist id="collection-options">
        {collections.map((c) => (
          <option key={c.collectionId} value={c.name} />
        ))}
      </datalist>

      <button className="btn btn-ghost back" onClick={onBack}>
        ← All articles
      </button>

      <header className="reader-header">
        <div className="card-meta">
          <span>{hostname(doc.url)}</span>
          <span aria-hidden>·</span>
          <a href={doc.url} target="_blank" rel="noreferrer">
            View original ↗
          </a>
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
              return (
                <li key={a.annotationId}>
                  <button
                    className="note-quote"
                    onClick={() => scrollToHighlight(a.annotationId)}
                  >
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
                      <input
                        autoFocus={listFocus === "collection"}
                        list="collection-options"
                        value={listCollectionDraft}
                        onChange={(e) => setListCollectionDraft(e.target.value)}
                        placeholder="Collection (optional)"
                      />
                      <div className="note-editor-actions">
                        <button
                          className="btn btn-small btn-ghost"
                          onClick={() => setListEditingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btn-small btn-primary"
                          disabled={saving}
                          onClick={async () => {
                            const ok = await updateAnnotation(
                              a.annotationId,
                              listNoteDraft,
                              listCollectionDraft,
                            );
                            if (ok) setListEditingId(null);
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {a.collectionName && (
                        <button
                          className="chip chip-button"
                          onClick={() => startListEdit(a, "collection")}
                          title="Change collection"
                        >
                          {a.collectionName}
                        </button>
                      )}
                      {a.note && <p className="note-text">{a.note}</p>}
                      <div className="note-actions">
                        <button
                          className="link-btn"
                          onClick={() => startListEdit(a, "note")}
                        >
                          {a.note ? "Edit note" : "Add note"}
                        </button>
                        {!a.collectionName && (
                          <button
                            className="link-btn"
                            onClick={() => startListEdit(a, "collection")}
                          >
                            Add to collection
                          </button>
                        )}
                        <button
                          className="link-btn link-danger"
                          onClick={() => removeHighlight(a.annotationId)}
                        >
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
        <div
          className="note-preview"
          style={{ top: hover.top, left: hover.left }}
        >
          {hover.collection && (
            <span className="chip chip-dark">{hover.collection}</span>
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
                  <button
                    onClick={() => createHighlight("", "")}
                    disabled={saving}
                  >
                    <HighlighterIcon /> Highlight
                  </button>
                  <span className="tooltip-divider" />
                  <button onClick={() => openEditor("note")}>
                    <NoteIcon /> Note
                  </button>
                  <button onClick={() => openEditor("collection")}>
                    <FolderIcon /> Collection
                  </button>
                </>
              ) : (
                <>
                  {popover.notice && (
                    <span className="tooltip-label">{popover.notice}</span>
                  )}
                  <button onClick={() => openEditor("note")}>
                    <NoteIcon /> Edit
                  </button>
                  <button onClick={() => openEditor("collection")}>
                    <FolderIcon /> Collection
                  </button>
                  <span className="tooltip-divider" />
                  <button
                    onClick={() => removeHighlight(popover.annotationId)}
                    disabled={saving}
                  >
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
              <div className="tooltip-field">
                <FolderIcon />
                <input
                  autoFocus={popover.editing === "collection"}
                  list="collection-options"
                  value={collectionDraft}
                  onChange={(e) => setCollectionDraft(e.target.value)}
                  placeholder="Collection (optional)"
                />
              </div>
              <div className="tooltip-editor-actions">
                <button
                  className="tooltip-text-btn"
                  onClick={() => setPopover(null)}
                >
                  Cancel
                </button>
                <button
                  className="tooltip-save-btn"
                  disabled={saving}
                  onClick={async () => {
                    if (popover.mode === "new") {
                      await createHighlight(noteDraft, collectionDraft);
                    } else if (
                      await updateAnnotation(
                        popover.annotationId,
                        noteDraft,
                        collectionDraft,
                      )
                    ) {
                      setPopover(null);
                    }
                  }}
                >
                  {saving
                    ? "Saving…"
                    : popover.mode === "new"
                      ? "Save highlight"
                      : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
