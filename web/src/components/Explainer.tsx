import { useEffect, useId, useRef, useState } from "react";

// a question mark beside a heading that opens two or three sentences saying
// what the thing is and what it does not promise. it exists so the panel can
// stop carrying that text as standing prose under every table
export function Explainer({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);

  // close on escape or on a click outside, so the bubble never traps the page
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span className="explainer" ref={wrap}>
      <button
        type="button"
        className="explainer-open"
        aria-label={`what ${label} means`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((was) => !was)}
      >
        ?
      </button>
      {open && (
        <span className="explainer-bubble" id={id} role="note">
          {children}
        </span>
      )}
    </span>
  );
}
