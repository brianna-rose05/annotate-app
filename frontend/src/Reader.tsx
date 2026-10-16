import { useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { applyHighlight, getSelectionAnchor, type Anchor } from "./highlight";

const API_URL = import.meta.env.VITE_API_URL;

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
};

// GET /documents/{docId}/annotations
async function fetchAnnotations(docId: string): Promise<Annotation[]> {
  const res = await fetch(`${API_URL}documents/${docId}/annotations`);
  const data: Annotation[] = await res.json();
  return data.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export default function Reader({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<FullDoc | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pending, setPending] = useState<Anchor | null>(null); // current text selection
  const bodyRef = useRef<HTMLDivElement>(null);

  // Load the article and its highlights
  useEffect(() => {
    fetch(`${API_URL}documents/${docId}`)
      .then((res) => res.json())
      .then(setDoc);
    fetchAnnotations(docId).then(setAnnotations);
  }, [docId]);

  // Draw the article, then draw highlights on top
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !doc?.content) return;
    el.innerHTML = DOMPurify.sanitize(doc.content);
    for (const a of annotations) applyHighlight(el, a, a.annotationId);
  }, [doc, annotations]);

  // When the user finishes selecting text, remember the selection
  function handleMouseUp() {
    if (bodyRef.current) setPending(getSelectionAnchor(bodyRef.current));
  }

  // POST a new highlight
  async function saveHighlight() {
    if (!pending) return;
    const note = window.prompt("Add a note (optional):");
    if (note === null) return; // clicked Cancel

    await fetch(`${API_URL}documents/${docId}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...pending, note }),
    });
    setPending(null);
    window.getSelection()?.removeAllRanges();
    setAnnotations(await fetchAnnotations(docId));
  }

  // DELETE a highlight
  async function deleteHighlight(id: string) {
    await fetch(`${API_URL}documents/${docId}/annotations/${id}`, { method: "DELETE" });
    setAnnotations(await fetchAnnotations(docId));
  }

  if (!doc) return <p>Loading…</p>;

  return (
    <article>
      <button onClick={onBack}>← Back</button>
      <h1>{doc.title ?? doc.url}</h1>
      {doc.byline && <p className="byline">{doc.byline}</p>}
      <a href={doc.url} target="_blank" rel="noreferrer">View original</a>

      {annotations.length > 0 && (
        <section className="notes">
          <h2>Highlights ({annotations.length})</h2>
          <ul>
            {annotations.map((a) => (
              <li key={a.annotationId}>
                <mark>{a.exact}</mark>
                {a.note && <p>{a.note}</p>}
                <button onClick={() => deleteHighlight(a.annotationId)}>Delete</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {doc.content ? (
        <div ref={bodyRef} className="article-body" onMouseUp={handleMouseUp} />
      ) : (
        <p>Couldn't load this article{doc.error ? `: ${doc.error}` : ""}.</p>
      )}

      {pending && (
        <button className="highlight-bar" onClick={saveHighlight}>
          Highlight
        </button>
      )}
    </article>
  );
}