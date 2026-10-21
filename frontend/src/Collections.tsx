import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL;

export type Collection = { collectionId: string; name: string };

type CollectionHighlight = {
  annotationId: string;
  docId: string;
  docTitle?: string;
  exact: string;
  note: string;
  createdAt: string;
};

const FolderIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

// ---------- The grid of collections ----------
export function CollectionsList({ onOpen }: { onOpen: (c: Collection) => void }) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`${API_URL}collections`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(setCollections)
      .catch(() => setError(true));
  }, []);

  // POST /collections
  async function create() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setCreateError("");
    try {
      const res = await fetch(`${API_URL}collections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't create that collection.");
      setCollections((current) =>
        [...(current ?? []), data].sort((a, b) => a.name.localeCompare(b.name))
      );
      setNewName("");
      setCreating(false);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="message message-error">Couldn't load your collections.</p>;

  const toolbar = (
    <div className="collections-toolbar">
      {creating ? (
        <form
          className="new-collection-form"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Collection name"
          />
          <button className="btn btn-small btn-primary" type="submit" disabled={busy || !newName.trim()}>
            {busy ? "Creating…" : "Create"}
          </button>
          <button
            className="btn btn-small btn-ghost"
            type="button"
            onClick={() => {
              setCreating(false);
              setNewName("");
              setCreateError("");
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button className="btn btn-small" onClick={() => setCreating(true)}>
          + New collection
        </button>
      )}
      {createError && <p className="message message-error">{createError}</p>}
    </div>
  );

  if (!collections) {
    return (
      <div className="collection-grid">
        {[1, 2, 3].map((n) => <div key={n} className="collection-card skeleton" />)}
      </div>
    );
  }

  return (
    <>
      {toolbar}
      {collections.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No collections yet</p>
          <p className="muted">Create one above, or add a highlight to a collection while you read.</p>
        </div>
      ) : (
        <div className="collection-grid">
          {collections.map((c) => (
            <button key={c.collectionId} className="collection-card" onClick={() => onOpen(c)}>
              <FolderIcon />
              <span className="collection-name">{c.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
// ---------- One collection ----------
export function CollectionView({
  collection,
  onBack,
  onOpenHighlight,
  onRenamed,
  onDeleted,
}: {
  collection: Collection;
  onBack: () => void;
  onOpenHighlight: (docId: string, annotationId: string) => void;
  onRenamed: (updated: Collection) => void;
  onDeleted: () => void;
}) {
  const [highlights, setHighlights] = useState<CollectionHighlight[] | null>(null);
  const [error, setError] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    fetch(`${API_URL}collections/${collection.collectionId}/highlights`)
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.json();
      })
      .then(setHighlights)
      .catch(() => setError(true));
  }, [collection.collectionId]);

  // PATCH /collections/{id}
  async function rename() {
    const name = nameDraft.trim();
    if (!name || name === collection.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch(`${API_URL}collections/${collection.collectionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't rename this collection.");
      onRenamed({ ...collection, name: data.name });
      setRenaming(false);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // DELETE /collections/{id}
  async function remove() {
    const ok = window.confirm(
      `Delete the collection “${collection.name}”?\n\nYour highlights and notes will stay on their articles. They just won't be in this collection anymore.`
    );
    if (!ok) return;
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch(`${API_URL}collections/${collection.collectionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      onDeleted();
    } catch {
      setActionError("Couldn't delete this collection. Try again.");
      setBusy(false);
    }
  }

  // Group highlights by article, keeping newest-first order
  const groups: { docId: string; docTitle: string; items: CollectionHighlight[] }[] = [];
  for (const h of highlights ?? []) {
    let group = groups.find((g) => g.docId === h.docId);
    if (!group) {
      group = { docId: h.docId, docTitle: h.docTitle ?? "Untitled article", items: [] };
      groups.push(group);
    }
    group.items.push(h);
  }

  return (
    <div>
      <button className="btn btn-ghost back" onClick={onBack}>← All collections</button>

      <header className="reader-header">
        <p className="eyebrow">Collection</p>

        {renaming ? (
          <form
            className="rename-form"
            onSubmit={(e) => {
              e.preventDefault();
              rename();
            }}
          >
            <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
            <button className="btn btn-small btn-primary" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn btn-small btn-ghost" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="collection-title-row">
            <h1 className="reader-title">{collection.name}</h1>
            <div className="collection-actions">
              <button
                className="link-btn"
                onClick={() => {
                  setNameDraft(collection.name);
                  setActionError("");
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button className="link-btn link-danger" onClick={remove} disabled={busy}>
                Delete
              </button>
            </div>
          </div>
        )}

        {actionError && <p className="message message-error">{actionError}</p>}

        {highlights && (
          <p className="muted">
            {highlights.length} highlight{highlights.length === 1 ? "" : "s"} from {groups.length} article
            {groups.length === 1 ? "" : "s"}
          </p>
        )}
      </header>

      {error && <p className="message message-error">Couldn't load this collection.</p>}

      {!highlights && !error && <div className="skeleton skeleton-block" />}

      {highlights?.length === 0 && (
        <div className="empty">
          <p className="empty-title">Nothing here yet</p>
          <p className="muted">Highlights you add to “{collection.name}” will show up here.</p>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.docId} className="collection-group">
          <h2 className="collection-doc-title">{g.docTitle}</h2>
          <ul>
            {g.items.map((h) => (
              <li key={h.annotationId}>
                <button className="note-quote" onClick={() => onOpenHighlight(g.docId, h.annotationId)}>
                  “{h.exact}”
                </button>
                {h.note && <p className="note-text">{h.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}