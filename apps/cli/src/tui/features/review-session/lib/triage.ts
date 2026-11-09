import type { FindingView } from "../model/session.ts";

/** Findings the skeptic rejected, or that a re-check closed: out of the way, not gone. */
export const isFiltered = (v: FindingView) =>
  v.finding.verdict === "rejected" || v.finding.status === "closed";

/** Triage state of a finding. */
export const triage = (v: FindingView): "pending" | "accepted" | "dismissed" | "applied" =>
  v.finding.status === "applied" || v.finding.status === "fixed"
    ? "applied"
    : v.finding.status === "dismissed"
      ? "dismissed"
      : v.finding.selected
        ? "accepted"
        : "pending";
