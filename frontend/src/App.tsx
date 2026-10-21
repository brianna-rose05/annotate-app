import { useEffect, useState } from "react";
import Reader from "./Reader";

const API_URL = import.meta.env.VITE_API_URL;

type Doc = {
  docId: string;
  url: string;
  createdAt: string;
  title?: string;
  excerpt?: string;
  status?: string;
  error?: string;
  alreadySaved?: boolean;
};

type Message = { type: "error" | "info"; text: string } | null;

// "https://www.example.com/a/b" → "example.com"
function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

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
  const [busyId, setBusyId] = useState<string | null>(null); // card being retried/deleted
  const [message, setMessage] = useState<Message>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // GET /documents
  async function loadDocs() {
    try {
      const res = await fetch(`${API_URL}documents`);
      if (!res.ok) throw new Error();
      const data: Doc[] = await res.json();
      data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
      setDocs(data);
    } catch {
      setMessage({ type: "error", text: "Couldn't load your articles. Check your connection and refresh." });
    } finally {
      setLoading(false);
    }
  }

  // POST /documents (also used for retries, since saving the same URL re-fetches failed ones)
  async function saveUrl(link: string): Promise<Doc> {
    const res = await fetch(`${API_URL}documents`, {
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
      if (doc.alreadySaved) {
        setMessage({ type: "info", text: `Already saved: “${doc.title}”` });
      } else if (doc.status === "failed") {
        setMessage({ type: "error", text: `Saved the link, but couldn't fetch the article: ${doc.error}` });
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
      // Older links have random IDs; a retry saves under the new URL-based ID, so remove the old copy
      if (saved.docId !== doc.docId) {
        await fetch(`${API_URL}documents/${doc.docId}`, { method: "DELETE" });
      }
      if (saved.status === "failed") {
        setMessage({ type: "error", text: `Still couldn't fetch it: ${saved.error}` });
      }
      await loadDocs();
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(doc: Doc) {
    const name = doc.title ?? hostname(doc.url);
    if (!window.confirm(`Delete “${name}” and all of its highlights?`)) return;

    setBusyId(doc.docId);
    try {
      const res = await fetch(`${API_URL}documents/${doc.docId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error();
      setDocs((current) => current.filter((d) => d.docId !== doc.docId));
    } catch {
      setMessage({ type: "error", text: "Couldn't delete that article. Try again." });
    } finally {
      setBusyId(null);
    }
  }

  useEffect(() => {
    loadDocs();
  }, []);

  // ---------- Reading view ----------
  if (selectedId) {
    return (
      <main className="page">
        <Reader docId={selectedId} onBack={() => setSelectedId(null)} />
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
        <button className="btn btn-primary" type="submit" disabled={saving || !url.trim()}>
          {saving ? (
            <>
              <span className="spinner" /> Fetching…
            </>
          ) : (
            "Save"
          )}
        </button>
      </form>

      {message && <p className={`message message-${message.type}`}>{message.text}</p>}

      <section className="doc-list">
        {loading ? (
          [1, 2, 3].map((n) => <div key={n} className="card skeleton" />)
        ) : docs.length === 0 ? (
          <div className="empty">
            <p className="empty-title">No articles yet</p>
            <p className="muted">Paste a link above to save your first one.</p>
          </div>
        ) : (
          docs.map((doc) => {
            const failed = doc.status === "failed";
            const busy = busyId === doc.docId;
            return (
              <article
                key={doc.docId}
                className={`card ${failed ? "card-failed" : "card-clickable"} ${busy ? "card-busy" : ""}`}
                onClick={() => !failed && !busy && setSelectedId(doc.docId)}
              >
                <div className="card-meta">
                  <span>{hostname(doc.url)}</span>
                  <span aria-hidden>·</span>
                  <span>{formatDate(doc.createdAt)}</span>
                </div>

                <h2 className="card-title">{doc.title ?? doc.url}</h2>

                {failed ? (
                  <p className="card-error">Couldn't fetch this article: {doc.error}</p>
                ) : (
                  doc.excerpt && <p className="card-excerpt">{doc.excerpt}</p>
                )}

                {/* stopPropagation: clicking a button shouldn't also open the article */}
                <div className="card-actions" onClick={(e) => e.stopPropagation()}>
                  {failed && (
                    <button className="btn btn-small" onClick={() => handleRetry(doc)} disabled={busy}>
                      {busy ? "Retrying…" : "Retry"}
                    </button>
                  )}
                  <button className="btn btn-small btn-ghost" onClick={() => handleDelete(doc)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>
    </main>
  );
}