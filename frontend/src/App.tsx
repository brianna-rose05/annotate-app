import { useEffect, useState } from "react";
import Reader from "./Reader";

const API_URL = import.meta.env.VITE_API_URL;

type Doc = {
  docId: string;
  url: string;
  createdAt: string;
  title?: string;
  status?: string;
  error?: string;
};

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // GET /documents → load my saved links
  async function loadDocs() {
    const res = await fetch(`${API_URL}documents`);
    const data: Doc[] = await res.json();
    data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    setDocs(data);
  }

  // POST /documents → save a link (the Lambda fetches the article)
  async function saveDoc() {
    setError("");
    setSaving(true);
    const res = await fetch(`${API_URL}documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    setSaving(false);

    if (!res.ok) {
      setError("Couldn't save that link.");
      return;
    }
    setUrl("");
    loadDocs();
  }

  useEffect(() => {
    loadDocs();
  }, []);

  // Reading view
  if (selectedId) {
    return (
      <main className="page">
        <Reader docId={selectedId} onBack={() => setSelectedId(null)} />
      </main>
    );
  }

  // List view
  return (
    <main className="page">
      <h1>Annotate App</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveDoc();
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an article link"
          required
          style={{ flex: 1, padding: 8 }}
        />
        <button type="submit" disabled={saving}>
          {saving ? "Fetching…" : "Save"}
        </button>
      </form>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <ul className="doc-list">
        {docs.map((doc) => (
          <li key={doc.docId}>
            <button className="doc-link" onClick={() => setSelectedId(doc.docId)}>
              {doc.title ?? doc.url}
            </button>
            {doc.status === "failed" && (
              <span className="failed"> — couldn't fetch: {doc.error}</span>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}