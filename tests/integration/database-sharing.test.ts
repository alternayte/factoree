import { describe, expect, it } from "vitest";
import { startDatabase } from "./support/database.js";

describe("database sharing", () => {
  it("gives two startDatabase calls the same container and different databases", async () => {
    const first = await startDatabase();
    const second = await startDatabase();
    try {
      const firstUrl = new URL(first.url);
      const secondUrl = new URL(second.url);

      expect(secondUrl.host).toBe(firstUrl.host);
      expect(secondUrl.pathname).not.toBe(firstUrl.pathname);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});
