import { useEffect, useState } from "react";
import Reader from "./Reader";
import ConfirmDialog from "./ConfirmDialog";
import {
  CollectionsList,
  CollectionView,
  type Collection,
} from "./Collections";
import { apiFetch, errorMessage } from "./auth";

type Doc = {
  docId: string;
  url: string;
  createdAt: string;
  title?: string;
  excerpt?: string;
  status?: string;
  error?: string;
  alreadySaved?: boolean;
  duplicate?: boolean;
};

type Message = { type: "error" | "info"; text: string } | null;
type Tab = "articles" | "collections";

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// Excerpts are often junk (all-caps banners, a repeat of the title, a stray word); hide those
function isUsefulExcerpt(excerpt: string, title: string) {
  const text = excerpt.trim();
  if (text.length < 40) return false;

  const letters = text.replace(/[^\p{L}]/gu, "");
  const upper = letters.replace(/[^\p{Lu}]/gu, "");
  if (letters.length > 0 && upper.length / letters.length > 0.6) return false;

  // PDF front matter: emails, footnote marks, affiliations
  if (/\S+@\S+\.\w/.test(text) || /[†‡∗]/.test(text)) return false;
  if (looksLikeAuthorLine(text)) return false;

  const words = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).filter(Boolean);
  const titleStart = words(title).slice(0, 5);
  const excerptStart = words(text).slice(0, titleStart.length);
  if (
    titleStart.length > 0 &&
    titleStart.every((w, i) => w === excerptStart[i])
  )
    return false;

  return true;
}

const AUTHOR_MARKERS = /\b(equal contribution|corresponding author|thanks:|affiliations?:)/i;
const INSTITUTIONS =
  /\b(universit(y|é|at|ät)|institute|department|laborator(y|ies)|college|school of|faculty of)\b/i;
// Two or more names in a row at the start: "Jane Doe, John Q. Smith, …"
const LEADING_NAMES =
  /^(\p{Lu}[\p{L}.'-]*\s+(\p{Lu}[\p{L}.'-]*\s+)?\p{Lu}[\p{L}'-]+\d*(,\d+)*[,;]?\s+(and\s+)?){2,}/u;

// "Arne Vanhoyweghen1,2, Vincent Holst1,2…" or "Jane Doe, John Smith, Stanford University"
function looksLikeAuthorLine(text: string) {
  if (AUTHOR_MARKERS.test(text)) return true;
  // Names with affiliation numbers stuck on the end, like "Holst1,2"
  const numberedNames = text.match(/\p{Ll}\d+(,\d+)*(?=[,\s*]|$)/gu) ?? [];
  if (numberedNames.length >= 2) return true;
  return (
    INSTITUTIONS.test(text) &&
    (numberedNames.length > 0 || LEADING_NAMES.test(text))
  );
}

const TrashIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [flashId, setFlashId] = useState<string | null>(null); // a row to briefly highlight
  const [tab, setTab] = useState<Tab>("articles");
  const [pendingDelete, setPendingDelete] = useState<Doc | null>(null);

  // What's open right now
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusAnnotationId, setFocusAnnotationId] = useState<string | null>(
    null,
  );
  const [selectedCollection, setSelectedCollection] =
    useState<Collection | null>(null);

  async function loadDocs() {
    try {
      const res = await apiFetch(`documents`);
      if (!res.ok) throw new Error();
      const data: Doc[] = await res.json();
      data.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setDocs(data);
    } catch {
      setMessage({
        type: "error",
        text: "Couldn't load your articles. Check your connection and refresh.",
      });
    } finally {
      setLoading(false);
    }
  }

  async function saveUrl(link: string): Promise<Doc> {
    const res = await apiFetch(`documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: link }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't save that link.");
    return data;
  }

  async function handleSave() {
    setMessage(null);
    setSaving(true);
    try {
      const doc = await saveUrl(url.trim());
      setUrl("");
      if (doc.duplicate || doc.alreadySaved) {
        // Nothing new was saved: point at the copy that's already in the list
        setMessage({ type: "info", text: "Already in your list" });
        setFlashId(doc.docId);
        return;
      }
      if (doc.status === "failed") {
        setMessage({
          type: "error",
          text: `Saved the link, but couldn't fetch the article: ${doc.error}`,
        });
      }
      await loadDocs();
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function handleRetry(doc: Doc) {
    setMessage(null);
    setBusyId(doc.docId);
    try {
      const saved = await saveUrl(doc.url);
      if (saved.docId !== doc.docId) {
        const res = await apiFetch(`documents/${doc.docId}`, { method: "DELETE" });
        if (res.status === 403) throw new Error(await errorMessage(res, ""));
      }
      if (saved.status === "failed") {
        setMessage({
          type: "error",
          text: `Still couldn't fetch it: ${saved.error}`,
        });
      }
      await loadDocs();
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(doc: Doc) {
    setPendingDelete(null);
    setBusyId(doc.docId);
    try {
      const res = await apiFetch(`documents/${doc.docId}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 404)
        throw new Error(
          await errorMessage(res, "Couldn't delete that article. Try again."),
        );
      setDocs((current) => current.filter((d) => d.docId !== doc.docId));
    } catch (err) {
      setMessage({
        type: "error",
        text:
          (err as Error).message || "Couldn't delete that article. Try again.",
      });
    } finally {
      setBusyId(null);
    }
  }

  function openArticle(docId: string, annotationId: string | null = null) {
    setSelectedId(docId);
    setFocusAnnotationId(annotationId);
  }

  useEffect(() => {
    loadDocs();
  }, []);

  // Info messages ("Already in your list") fade away on their own
  useEffect(() => {
    if (message?.type !== "info") return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);

  // Scroll to the highlighted row, then let the highlight fade
  useEffect(() => {
    if (!flashId) return;
    document
      .querySelector(`[data-doc-id="${flashId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(timer);
  }, [flashId]);

  // ---------- Reading an article ----------
  if (selectedId) {
    return (
      <main className="page">
        <Reader
          docId={selectedId}
          focusAnnotationId={focusAnnotationId}
          onBack={() => {
            setSelectedId(null);
            setFocusAnnotationId(null);
          }}
        />
      </main>
    );
  }

  // ---------- Looking at one collection ----------
  if (selectedCollection) {
    return (
      <main className="page">
        <CollectionView
          collection={selectedCollection}
          onBack={() => setSelectedCollection(null)}
          onOpenHighlight={(docId, annotationId) =>
            openArticle(docId, annotationId)
          }
          onRenamed={(updated) => setSelectedCollection(updated)}
          onDeleted={() => setSelectedCollection(null)}
        />
      </main>
    );
  }

  // ---------- Home ----------
  return (
    <main className="page">
      <header className="app-header">
        <h1 className="logo">Annotate</h1>
        <p className="tagline">Save articles. Highlight what matters.</p>
      </header>

      <nav className="tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "articles"}
          className={tab === "articles" ? "tab tab-active" : "tab"}
          onClick={() => setTab("articles")}
        >
          Articles
        </button>
        <button
          role="tab"
          aria-selected={tab === "collections"}
          className={tab === "collections" ? "tab tab-active" : "tab"}
          onClick={() => setTab("collections")}
        >
          Collections
        </button>
      </nav>

      {tab === "collections" ? (
        <CollectionsList onOpen={setSelectedCollection} />
      ) : (
        <>
          <form
            className="save-bar"
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
          >
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste an article link…"
              required
              disabled={saving}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={saving || !url.trim()}
            >
              {saving ? (
                <>
                  <span className="spinner" /> Fetching…
                </>
              ) : (
                "Save"
              )}
            </button>
          </form>

          {message && (
            <p className={`message message-${message.type}`}>{message.text}</p>
          )}

          <section className="doc-list">
            {loading ? (
              [1, 2, 3].map((n) => (
                <div key={n} className="doc-row" aria-hidden>
                  <div className="skeleton skeleton-line" />
                  <div className="skeleton skeleton-line skeleton-line-short" />
                </div>
              ))
            ) : docs.length === 0 ? (
              <div className="empty">
                <p className="empty-title">No articles yet</p>
                <p className="muted">
                  Paste a link above to save your first one.
                </p>
              </div>
            ) : (
              docs.map((doc) => {
                const failed = doc.status === "failed";
                const busy = busyId === doc.docId;
                const title = doc.title ?? doc.url;
                return (
                  <article
                    key={doc.docId}
                    data-doc-id={doc.docId}
                    className={`doc-row ${failed ? "doc-row-failed" : "doc-row-clickable"} ${busy ? "doc-row-busy" : ""} ${flashId === doc.docId ? "doc-row-flash" : ""}`}
                    onClick={() => !failed && !busy && openArticle(doc.docId)}
                  >
                    <div className="doc-title-line">
                      <h2 className="doc-title">{title}</h2>
                      <button
                        className="icon-btn doc-delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete(doc);
                        }}
                        disabled={busy}
                        aria-label="Delete article"
                        title="Delete"
                      >
                        <TrashIcon />
                      </button>
                    </div>

                    <p className="meta">
                      {hostname(doc.url)} · {formatDate(doc.createdAt)}
                    </p>

                    {failed ? (
                      <p className="doc-error">
                        Couldn't fetch this article: {doc.error}{" "}
                        <button
                          className="link-btn doc-retry"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetry(doc);
                          }}
                          disabled={busy}
                        >
                          {busy ? "Retrying…" : "Retry"}
                        </button>
                      </p>
                    ) : (
                      doc.excerpt &&
                      isUsefulExcerpt(doc.excerpt, title) && (
                        <p className="doc-excerpt">{doc.excerpt}</p>
                      )
                    )}
                  </article>
                );
              })
            )}
          </section>
        </>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this article?"
          confirmLabel="Delete"
          onConfirm={() => handleDelete(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        >
          <strong>{pendingDelete.title ?? hostname(pendingDelete.url)}</strong>{" "}
          and all of its highlights will be permanently deleted.
        </ConfirmDialog>
      )}
    </main>
  );
}
