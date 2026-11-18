import type { ReactNode } from "react";
import { Link } from "react-router-dom";

export function EmptyState({
  title,
  children,
  helpAnchor,
}: {
  title: string;
  children?: ReactNode;
  helpAnchor?: string;
}) {
  return (
    <div className="rounded-lg border border-dashed p-6 text-sm space-y-2">
      <p className="font-medium">{title}</p>
      {children && <div className="text-muted-foreground space-y-1">{children}</div>}
      {helpAnchor && (
        <Link to={`/help/${helpAnchor}`} className="inline-block text-xs underline">
          How this works →
        </Link>
      )}
    </div>
  );
}
