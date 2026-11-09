import type { Db } from "../db/connection.ts";
import { createReposRepository } from "./repos-repository.ts";
import { createReviewsRepository } from "./reviews-repository.ts";
import { createShardsRepository } from "./shards-repository.ts";
import { createFindingsRepository } from "./findings-repository.ts";
import { createFixesRepository } from "./fixes-repository.ts";
import { createMessagesRepository } from "./messages-repository.ts";
import { createSuppressionsRepository } from "./suppressions-repository.ts";
import { createCacheRepository } from "./cache-repository.ts";
import { createEventsRepository } from "./events-repository.ts";
import { createKvRepository } from "./kv-repository.ts";
import type { Repositories } from "./repositories-types.ts";

export const createRepositories = (db: Db): Repositories => ({
  repos: createReposRepository(db),
  reviews: createReviewsRepository(db),
  shards: createShardsRepository(db),
  findings: createFindingsRepository(db),
  fixes: createFixesRepository(db),
  messages: createMessagesRepository(db),
  suppressions: createSuppressionsRepository(db),
  cache: createCacheRepository(db),
  events: createEventsRepository(db),
  kv: createKvRepository(db),
});
