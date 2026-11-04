import { defineCommand } from "citty";
import pkg from "../package.json" with { type: "json" };

export const main = defineCommand({
  meta: {
    name: "crit",
    version: pkg.version,
    description: pkg.description,
  },
  subCommands: {},
});
