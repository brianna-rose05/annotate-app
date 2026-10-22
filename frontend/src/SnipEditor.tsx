import { useEffect, useMemo, useState } from "react";
import CollectionPicker from "./CollectionPicker";
import { apiFetch } from "./auth";

const MAX_WIDTH = 2000; // shrink huge screenshots so they upload fast

type Collection = { collectionId: string; name: string };

// Turn any image into a PNG (shrinking it if it's huge), since the upload link expects a PNG
async function toPng(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * ratio);
  canvas.height = Math.round(bitmap.height * ratio);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Couldn't read that image")),
      "image/png",
    ),
  );
}

export default function SnipEditor({
  docId,
  file,
  collections,
  initialCollections,
  onClose,
  onSaved,
}: {
  docId: string;
  file: Blob;
  collections: Collection[];
  initialCollections: string[];
  onClose: () => void;
  onSaved: (collectionNames: string[]) => void;
}) {
  // A temporary local URL so the browser can show the image before it's uploaded
  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(previewUrl), [previewUrl]); // free the memory when closed

  const [note, setNote] = useState("");
  const [names, setNames] = useState<string[]>(initialCollections);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      const png = await toPng(file);

      // 1. Ask the API for a short-lived upload link
      const linkRes = await apiFetch(`documents/${docId}/snips/upload-url`, {
        method: "POST",
      });
      if (!linkRes.ok)
        throw new Error("Couldn't get an upload link. Try again.");
      const { uploadUrl, imageKey } = await linkRes.json();

      // 2. Upload the image straight to S3 (it never passes through the Lambda)
      const upload = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" }, // must match what the link was signed for
        body: png,
      });
      if (!upload.ok) throw new Error("The upload failed. Try again.");

      // 3. Save it as a highlight of kind "area"
      const res = await apiFetch(`documents/${docId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "area",
          imageKey,
          note: note.trim(),
          collections: names,
        }),
      });
      if (!res.ok) throw new Error("Couldn't save the snip. Try again.");

      onSaved(names);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      // Clicking the dark area outside the box closes it (unless it's mid-save)
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !saving) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-label="Save snip">
        <h2 className="modal-title">Save snip</h2>
        <img className="snip-preview" src={previewUrl} alt="Your screenshot" />
        <textarea
          autoFocus
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What's this? Add a note (optional)"
        />
        <CollectionPicker
          values={names}
          onChange={setNames}
          options={collections}
        />
        {error && <p className="message message-error">{error}</p>}
        <div className="modal-actions">
          <button
            className="btn btn-small btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            className="btn btn-small btn-primary"
            onClick={save}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save snip"}
          </button>
        </div>
      </div>
    </div>
  );
}
