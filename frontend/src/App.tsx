import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL;

type Doc = {
  docId: string;
  url: string;
  createdAt: string;
};

export default function App() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  // GET /documents → load my saved links
  async function loadDocs() {
    const res = await fetch(`${API_URL}documents`);
    const data: Doc[] = await res.json();
    data.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    setDocs(data);
  }

  // POST /documents → save a new link
  async function saveDoc() {
    setError("");
    const res = await fetch(`${API_URL}documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
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

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px" }}>
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
        <button type="submit">Save</button>
      </form>

      {error && <p style={{ color: "red" }}>{error}</p>}

      <ul>
        {docs.map((doc) => (
          <li key={doc.docId}>
            <a href={doc.url} target="_blank" rel="noreferrer">{doc.url}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}