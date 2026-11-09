import type { ReviewEvent } from "@crit/schema";
import { useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  emptyProgress,
  type ProgressState,
  reduceProgress,
  type RunRecovery,
  type Selection,
} from "@/features/run-progress/lib/progress-state.ts";
import { ProgressView } from "./progress-view.tsx";
import { useScreen } from "@/shared/ui/screen.tsx";
import type { ReviewSession } from "@/features/review-session/model/session.ts";
import { type Switcher } from "@/features/model-switching/lib/create-switcher.ts";
import { useSwitching } from "@/features/model-switching/hooks/use-switching.tsx";
import { ReviewView } from "@/views/review/review-view.tsx";
type Props = {
  subscribe: (fn: (e: ReviewEvent) => void) => () => void;
  makeSession: (reviewId: string) => Promise<ReviewSession>;
  onStop: () => void;
  onRecover?: (action: RunRecovery) => void;
  onExit?: () => void;
  switcher?: Switcher;
};

export const RunView = (props: Props) => {
  const app = useApp();
  const { width, height } = useScreen();
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const [reviewId, setReviewId] = useState<string>();
  const [session, setSession] = useState<ReviewSession>();
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [, bump] = useState(0);
  const initial = useRef(props.switcher?.current());

  useEffect(
    () =>
      props.subscribe((e) => {
        setProgress((p) => reduceProgress(p, e));
        if (e.type === "review-started") setReviewId(e.reviewId);
        if (e.type === "finding" || e.type === "verified" || e.type === "review-done")
          void session?.load();
      }),
    [props, session],
  );
  useEffect(() => {
    if (
      progress.done &&
      !progress.failed &&
      !progress.rateLimited &&
      !progress.partial &&
      ![...progress.shards.values()].some((s) => s.status === "failed")
    )
      setOpen(true);
  }, [progress]);
  useEffect(() => {
    if (open && reviewId && !session) void props.makeSession(reviewId).then(setSession);
  }, [open, reviewId, session, props]);

  const now = props.switcher?.current();
  const was = initial.current;
  const selection: Selection = {};
  if (now && was) {
    if (now.provider !== was.provider) selection.provider = now.provider;
    if (now.model !== was.model) selection.model = now.model;
    if (now.effort !== was.effort) selection.effort = now.effort;
    if (now.depth !== was.depth) selection.depth = now.depth;
  }
  const connect = () => {
    props.onRecover?.({ kind: "provider" });
    app.exit();
  };
  const { overlay, modal } = useSwitching({
    switcher: props.switcher,
    active: !session,
    onNotice: setNotice,
    ...(props.onRecover ? { onConnect: connect } : {}),
    onChange: () => bump((n) => n + 1),
  });

  useInput(
    (typed, key) => {
      const input = typed.toLowerCase();
      if (input === "r" && progress.done && props.onRecover) {
        props.onRecover({ kind: "retry", ...selection });
        app.exit();
        return;
      }
      if (input === "b" && progress.budget && props.onRecover) {
        props.onRecover({ kind: "budget", maxShards: progress.budget.required });
        app.exit();
        return;
      }
      if (input === "q" || (key.ctrl && input === "c")) {
        if (progress.done) {
          props.onExit?.();
          app.exit();
        } else props.onStop();
        return;
      }
      if (key.return && reviewId) setOpen(true);
    },
    { isActive: !session && !modal },
  );

  if (session)
    return (
      <ReviewView
        session={session}
        {...(props.onExit ? { onExit: props.onExit } : {})}
        {...(props.switcher ? { switcher: props.switcher } : {})}
        {...(props.onRecover
          ? {
              onRerun: (fresh) =>
                props.onRecover!({ kind: "retry", ...selection, ...(fresh ? { fresh } : {}) }),
              onBack: () => props.onRecover!({ kind: "home" }),
            }
          : {})}
      />
    );
  if (overlay) return overlay;
  return (
    <ProgressView
      progress={progress}
      width={width}
      height={height}
      selection={selection}
      {...(was ? { depth: was.depth, effort: was.effort } : {})}
      {...(notice ? { notice } : {})}
    />
  );
};
