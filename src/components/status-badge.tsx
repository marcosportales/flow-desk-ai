import { Badge } from "@/components/ui/badge";
import { label } from "@/lib/format";

type Variant = "default" | "secondary" | "destructive" | "outline";

// Semantic mapping only: destructive = broken, default = needs attention,
// outline = settled fine, secondary = neutral.
const variants: Record<string, Variant> = {
  failed: "destructive",
  invalid_output: "destructive",
  provider_error: "destructive",
  urgent: "destructive",
  high: "default",
  unknown: "default",
  needs_review: "default",
  succeeded: "outline",
  valid: "outline",
};

export function StatusBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={variants[value] ?? "secondary"}>{label(value)}</Badge>;
}
