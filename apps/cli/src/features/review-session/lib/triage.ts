import type { FindingView } from "@/features/review-session/model/session.ts";

export const isFiltered = (findingView: FindingView) =>
  findingView.finding.verdict === "rejected" || findingView.finding.status === "closed";

export const triage = (
  findingView: FindingView,
): "pending" | "accepted" | "dismissed" | "applied" =>
  findingView.finding.status === "applied" || findingView.finding.status === "fixed"
    ? "applied"
    : findingView.finding.status === "dismissed"
      ? "dismissed"
      : findingView.finding.selected
        ? "accepted"
        : "pending";
