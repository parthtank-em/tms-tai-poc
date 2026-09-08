import { Badge } from "@/components/ui/badge";
import type { JumioDecision, JumioVerificationStatus } from "@/generated/prisma/enums";
import { humanizeEnum } from "@/lib/format";

/**
 * Jumio-specific badges.
 *
 * Deliberately not added to `src/components/status-badge.tsx`: that file is the
 * TMS/TAI vocabulary, and mixing a second vendor's statuses into it is how the
 * two integrations start to tangle.
 */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost";

/** In-flight states read as neutral; only a finished workflow gets a strong colour. */
const STATUS_VARIANT: Record<JumioVerificationStatus, BadgeVariant> = {
  INITIATED: "outline",
  ACQUISITION_STARTED: "outline",
  ACQUIRED: "secondary",
  PROCESSING: "secondary",
  PROCESSED: "default",
  SESSION_EXPIRED: "outline",
  TOKEN_EXPIRED: "outline",
  FAILED: "destructive",
};

/**
 * `WARNING` is destructive-coloured on purpose. It sits between passed and
 * rejected in Jumio's bands, and an operator reading this screen needs it to
 * look like something to check, not something to skim past.
 */
const DECISION_VARIANT: Record<JumioDecision, BadgeVariant> = {
  PASSED: "default",
  WARNING: "destructive",
  REJECTED: "destructive",
  NOT_EXECUTED: "outline",
};

export function VerificationStatusBadge({ status }: { status: JumioVerificationStatus }) {
  return <Badge variant={STATUS_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

export function VerificationDecisionBadge({ decision }: { decision: JumioDecision | null }) {
  if (!decision) return <span className="text-muted-foreground">—</span>;
  return <Badge variant={DECISION_VARIANT[decision]}>{humanizeEnum(decision)}</Badge>;
}

/**
 * A capability outcome (liveness, face match), as Jumio labelled it.
 *
 * The labels are an open set — `OK`, `MATCH`, `MISMATCH`, and more the vendor
 * may add — so anything not recognisably good is shown plainly rather than
 * guessed at and coloured wrong.
 */
const GOOD_LABELS = new Set(["OK", "MATCH", "PASSED"]);

export function CapabilityBadge({ label }: { label: string | null }) {
  if (!label) return <span className="text-muted-foreground">—</span>;

  const normalized = label.toUpperCase();
  const variant: BadgeVariant = GOOD_LABELS.has(normalized) ? "default" : "destructive";

  return <Badge variant={variant}>{humanizeEnum(label)}</Badge>;
}

/** Jumio's own bands: 0–30 passed, 31–70 warning, 71–100 rejected. */
export function RiskScore({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;

  const tone =
    score <= 30 ? "text-foreground" : score <= 70 ? "text-muted-foreground" : "text-destructive";

  return <span className={`tabular-nums font-medium ${tone}`}>{score}</span>;
}
