import type { ViewId } from "../lib/route";
import type { ViewTab } from "../lib/views";
import "../styles/nav.css";

interface Props {
  views: readonly ViewTab[];
  current: ViewId;
  // the address the view would have, so a middle click opens it in a tab and
  // the status bar says where it goes. the click itself is handled in place
  href: (id: ViewId) => string;
  onChange: (id: ViewId) => void;
}

export function ViewNav({ views, current, href, onChange }: Props) {
  if (views.length < 2) return null;
  const pick = (e: React.MouseEvent, id: ViewId) => {
    // a modified click is the reader asking the browser for a second tab
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    onChange(id);
  };
  return (
    <nav className="view-nav" aria-label="views">
      <div className="tabs">
        {views.map((view) => (
          <a
            key={view.id}
            href={href(view.id)}
            title={view.title}
            aria-current={view.id === current ? "page" : undefined}
            onClick={(e) => pick(e, view.id)}
          >
            {view.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
