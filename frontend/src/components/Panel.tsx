import type { ReactNode } from "react";
import { X } from "lucide-react";

interface PanelProps {
  className?: string;
  children: ReactNode;
}

// Shared floating-card look for every map overlay panel (legend, detail,
// spotting log, traffic volume, noise). Positioning/width stay with each
// caller via `className` since that varies (some panels self-position with
// `absolute`, others sit in a parent flex stack) — this only unifies the
// card surface itself.
export function Panel({ className = "", children }: PanelProps) {
  return <div className={`rounded-lg bg-white/95 shadow-lg backdrop-blur ${className}`}>{children}</div>;
}

interface PanelHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
}

export function PanelHeader({ title, subtitle, onClose }: PanelHeaderProps) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="text-lg font-semibold leading-tight">{title}</h2>
        {subtitle && <p className="text-sm text-gray-500">{subtitle}</p>}
      </div>
      <button onClick={onClose} className="shrink-0 text-gray-400 hover:text-gray-700" aria-label="Close">
        <X size={16} />
      </button>
    </div>
  );
}
