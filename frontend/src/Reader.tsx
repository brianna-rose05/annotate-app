import { useEffect, useState } from "react";
import DOMPurify from "dompurify";

const API_URL = import.meta.env.VITE_API_URL;

type FullDoc = {
  docId: string;
  url: string;
  title?: string;
  byline?: string;
  status?: string;
  error?: string;
  content: string | null;
};

export default function Reader({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<FullDoc | null>(null);

  // GET /documents/{docId} → summary + article content
  useEffect(() => {
    fetch(`${API_URL}documents/${docId}`)
      .then((res) => res.json())
      .then(setDoc);
  }, [docId]);

  if (!doc) return <p>Loading…</p>;

  return (
    <article>
      <button onClick={onBack}>← Back</button>
      <h1>{doc.title ?? doc.url}</h1>
      {doc.byline && <p className="byline">{doc.byline}</p>}
      <a href={doc.url} target="_blank" rel="noreferrer">View original</a>

      {doc.content ? (
        <div
          className="article-body"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(doc.content) }}
        />
      ) : (
        <p>Couldn't load this article{doc.error ? `: ${doc.error}` : ""}.</p>
      )}
    </article>
  );
}