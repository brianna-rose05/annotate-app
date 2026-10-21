import { useRef, useState, type KeyboardEvent } from "react";

type Option = { collectionId: string; name: string };

const FolderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

export default function CollectionPicker({
  values,
  onChange,
  options,
  autoFocus = false,
  dark = false,
  placeholder = "Add to collections…",
}: {
  values: string[];                    // selected collection names
  onChange: (values: string[]) => void;
  options: Option[];                   // all existing collections
  autoFocus?: boolean;
  dark?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<number | null>(null); // row chosen with arrow keys
  const inputRef = useRef<HTMLInputElement>(null);

  const isSelected = (name: string) => values.some((v) => v.toLowerCase() === name.toLowerCase());
  const query = text.trim().toLowerCase();

  // Menu: existing collections that aren't already picked, filtered by what's typed
  const matches = options.filter((o) => !isSelected(o.name) && o.name.toLowerCase().includes(query));

  function add(name: string) {
    const clean = name.trim();
    if (clean && !isSelected(clean)) onChange([...values, clean]);
    setText("");
    setActive(null);
  }

  function remove(name: string) {
    onChange(values.filter((v) => v !== name));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (matches.length) setActive(active === null ? 0 : Math.min(active + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (active !== null) setActive(Math.max(active - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active !== null && matches[active]) add(matches[active].name); // arrowed to one
      else if (text.trim()) add(text);                                   // typed a name
    } else if (e.key === "Backspace" && !text && values.length) {
      remove(values[values.length - 1]); // empty field + Backspace = remove the last tag
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // close just the menu, not the whole tooltip
      setOpen(false);
    }
  }

  return (
    <div
      className={`picker picker-multi ${dark ? "picker-dark" : ""}`}
      // Clicking empty space in the box focuses the input
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          inputRef.current?.focus();
        }
      }}
    >
      <FolderIcon />

      {values.map((v) => (
        <span key={v} className="picker-chip">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onMouseDown={(e) => {
              e.preventDefault(); // keep focus in the input
              remove(v);
            }}
          >
            ×
          </button>
        </span>
      ))}

      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={open}
        autoFocus={autoFocus}
        value={text}
        placeholder={values.length ? "" : placeholder}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setOpen(false);
          if (text.trim()) add(text); // don't lose a name that was typed but not Entered
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(null);
        }}
        onKeyDown={handleKeyDown}
      />

      {open && matches.length > 0 && (
        <ul className="picker-menu" role="listbox">
          {matches.map((o, i) => (
            <li
              key={o.collectionId}
              role="option"
              aria-selected={i === active}
              className={`picker-option ${i === active ? "picker-option-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onMouseDown={(e) => {
                e.preventDefault(); // add before the input loses focus
                add(o.name);
              }}
            >
              {o.name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}