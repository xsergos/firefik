import { Loader2 } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";

interface TableLoadingProps {
  label?: string;
}

export function TableLoading({ label = "Loading…" }: TableLoadingProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 py-10 text-sm text-muted-foreground justify-center"
    >
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

interface TableEmptyProps {
  colSpan: number;
  label: string;
  hint?: string;
}

export function TableEmpty({ colSpan, label, hint }: TableEmptyProps) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="py-10 text-center text-sm text-muted-foreground">
        <p>{label}</p>
        {hint && <p className="mt-1 text-xs">{hint}</p>}
      </TableCell>
    </TableRow>
  );
}

interface TableErrorProps {
  label: string;
}

export function TableError({ label }: TableErrorProps) {
  return (
    <div role="alert" className="py-10 text-center text-sm text-destructive">
      {label}
    </div>
  );
}
