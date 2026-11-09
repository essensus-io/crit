import { createHash } from "node:crypto";

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
