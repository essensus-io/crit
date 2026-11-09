import { type Connection, type Db, openDatabase } from "../db/connection.ts";
import { createRepositories } from "./create-repositories.ts";
import type { Repositories } from "./repositories-types.ts";

export type SqliteStore = Repositories & { connection: Connection; db: Db; close(): void };

export const openStore = (path: string = ":memory:"): SqliteStore => {
  const connection = openDatabase(path);
  return {
    ...createRepositories(connection.db),
    connection,
    db: connection.db,
    close: () => connection.close(),
  };
};
