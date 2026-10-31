import { useEffect, useRef, type ReactNode } from "react";

// A styled replacement for window.confirm(). Esc or clicking outside cancels.
export default function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm"
      onCancel={(e) => {
        e.preventDefault(); // let React close it, not the browser
        onCancel();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onCancel(); // clicked the backdrop
      }}
    >
      <div className="confirm-body">
        <h2 className="confirm-title">{title}</h2>
        <div className="confirm-message">{children}</div>
        <div className="confirm-actions">
          <button className="btn btn-ghost" onClick={onCancel} autoFocus>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
