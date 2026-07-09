import { describe, expect, it } from "vitest";

// Stage 0 scaffold用のダミーテスト。
// `npm test` がビルド構成のまま緑になることを確認するためのもの。
// Stage 3b以降で autosave.test.ts / answers.test.ts / export.test.ts に置き換わる。
describe("scaffold sanity check", () => {
  it("vitest が動作する", () => {
    expect(1 + 1).toBe(2);
  });
});
