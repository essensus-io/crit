import { defineCommand } from "citty";
import type { CliContext } from "@/shared/lib/cli-context.ts";
import { doctor } from "@/views/doctor/run-doctor.ts";

export const doctorCommand = (ctx: CliContext) =>
  defineCommand({
    meta: { name: "doctor", description: "Check installed agent CLIs, logins and versions" },
    args: {
      test: { type: "boolean", description: "Also run a short test prompt on each provider" },
    },
    run: async ({ args }) => {
      process.exitCode = await doctor(ctx, args);
    },
  });
