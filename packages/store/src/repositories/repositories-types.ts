import type {
  Finding,
  Fix,
  Message,
  MessageRole,
  Repo,
  Review,
  Shard,
  Suppression,
} from "@crit/schema";

export type ReviewPatch = Partial<Omit<Review, "id" | "repoId">>;
export type ShardPatch = Partial<Omit<Shard, "id" | "reviewId">>;
export type FindingPatch = Partial<Omit<Finding, "id" | "reviewId">>;
export type FixPatch = Partial<Omit<Fix, "id" | "findingId">>;

export type CacheEntry = {
  key: string;
  reviewId: string | null;
  value: string;
  transcriptPath: string | null;
  createdAt: number;
};

export type Repositories = {
  repos: {
    upsert(input: { root: string; remoteUrl: string | null; name: string }): Promise<Repo>;
    get(id: string): Promise<Repo | undefined>;
    getByRoot(root: string): Promise<Repo | undefined>;
    list(): Promise<Repo[]>;
  };
  reviews: {
    create(review: Review): Promise<Review>;
    get(id: string): Promise<Review | undefined>;
    resolve(ref: string, repoId?: string): Promise<Review[]>;
    latest(repoId: string): Promise<Review | undefined>;
    update(id: string, patch: ReviewPatch): Promise<Review>;
    markSuperseded(review: Review): Promise<string[]>;
    delete(id: string): Promise<void>;
    deleteOlderThan(before: number, repoId?: string): Promise<string[]>;
  };
  shards: {
    create(shard: Shard): Promise<Shard>;
    update(id: string, patch: ShardPatch): Promise<Shard>;
    listByReview(reviewId: string): Promise<Shard[]>;
  };
  findings: {
    create(finding: Finding): Promise<Finding>;
    get(id: string): Promise<Finding | undefined>;
    listByReview(reviewId: string): Promise<Finding[]>;
    update(id: string, patch: FindingPatch): Promise<Finding>;
    reassign(id: string, reviewId: string): Promise<void>;
    delete(id: string): Promise<void>;
  };
  fixes: {
    create(fix: Fix): Promise<Fix>;
    get(id: string): Promise<Fix | undefined>;
    listByFinding(findingId: string): Promise<Fix[]>;
    listByReview(reviewId: string): Promise<Fix[]>;
    active(findingId: string): Promise<Fix | undefined>;
    setActive(id: string): Promise<void>;
    update(id: string, patch: FixPatch): Promise<Fix>;
  };
  messages: {
    add(findingId: string, role: MessageRole, body: string): Promise<Message>;
    listByFinding(findingId: string): Promise<Message[]>;
    listByReview(reviewId: string): Promise<Message[]>;
  };
  suppressions: {
    add(repoId: string, fingerprint: string, reason: Suppression["reason"]): Promise<Suppression>;
    list(repoId: string): Promise<Suppression[]>;
    remove(repoId: string, fingerprint: string): Promise<void>;
  };
  cache: {
    get(key: string): Promise<CacheEntry | undefined>;
    put(entry: Omit<CacheEntry, "createdAt"> & { createdAt?: number }): Promise<void>;
    pruneOlderThan(before: number): Promise<number>;
  };
  events: {
    append(reviewId: string, type: string, payload: unknown): Promise<string>;
    list(
      reviewId: string,
      type?: string,
    ): Promise<{ id: string; type: string; payload: unknown; createdAt: number }[]>;
  };
  kv: {
    get(key: string): Promise<string | undefined>;
    set(key: string, value: string): Promise<void>;
  };
};
