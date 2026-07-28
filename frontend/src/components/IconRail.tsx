import type { LucideIcon } from "lucide-react";

export interface RailItem {
  id: string;
  icon: LucideIcon;
  label: string;
  // Small status dot on the icon — currently only used to show "logged in"
  // on the auth entry without needing the panel open to see it.
  badge?: boolean;
}

interface Props {
  items: RailItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

// A single vertical dock replacing what used to be four independently
// `absolute`-positioned toggle buttons scattered across the map's corners —
// see docs/SPEC.md §6. Only one panel is active at a time (its id lives in
// App's state), matching the familiar VS Code activity-bar pattern rather
// than letting an unbounded number of panels stack and compete for space.
export function IconRail({ items, activeId, onSelect }: Props) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-white/95 p-1.5 shadow-lg backdrop-blur">
      {items.map(({ id, icon: Icon, label, badge }) => (
        <button
          key={id}
          onClick={() => onSelect(id)}
          aria-label={label}
          aria-pressed={activeId === id}
          title={label}
          className={`relative flex h-10 w-10 items-center justify-center rounded-md transition-colors ${
            activeId === id ? "bg-sky-600 text-white" : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          <Icon size={20} />
          {badge && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-1 ring-white" />
          )}
        </button>
      ))}
    </div>
  );
}
