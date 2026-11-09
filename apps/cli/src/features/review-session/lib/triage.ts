import type { FindingView } from "@/features/review-session/model/session.ts";

export const isFiltered = (v: FindingView) =>
  v.finding.verdict === "rejected" || v.finding.status === "closed";

export const triage = (v: FindingView): "pending" | "accepted" | "dismissed" | "applied" =>
  v.finding.status === "applied" || v.finding.status === "fixed"
    ? "applied"
    : v.finding.status === "dismissed"
      ? "dismissed"
      : v.finding.selected
        ? "accepted"
        : "pending";
