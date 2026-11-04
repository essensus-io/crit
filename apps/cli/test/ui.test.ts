import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import { colors, duration, plural, table, visibleLength, when } from "../src/ui.ts";

describe("ui helpers", () => {
  it("formats durations", () => {
    expect([duration(850), duration(4200), duration(102_000), duration(120_000)]).toEqual([
      "850ms",
      "4.2s",
      "1m42s",
      "2m",
    ]);
  });

  it("formats relative times like the history mockup", () => {
    const now = new Date(2026, 10, 4, 15, 0).getTime();
    expect(when(new Date(2026, 10, 4, 14, 2).getTime(), now)).toBe("today 14:02");
    expect(when(new Date(2026, 10, 3, 17, 15).getTime(), now)).toBe("yesterday 17:15");
    expect(when(new Date(2026, 10, 1, 9, 0).getTime(), now)).toBe("Nov 1");
    expect(when(new Date(2025, 10, 1, 9, 0).getTime(), now)).toBe("Nov 1, 2025");
  });

  it("aligns tables ignoring color codes", () => {
    const c = colors(true);
    expect(visibleLength(c.red("abc"))).toBe(3);
    const rendered = table([
      [c.bold("A"), "B"],
      ["long", "x"],
    ]);
    expect(stripVTControlCharacters(rendered)).toBe("  A     B\n  long  x");
    expect(colors(false).red("x")).toBe("x");
    expect([plural(1, "shard"), plural(2, "shard"), plural(2, "child", "children")]).toEqual([
      "1 shard",
      "2 shards",
      "2 children",
    ]);
  });
});
