import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildSdkTypes, SDK_TYPES_FILE } from "../../../scripts/sdk-types.ts";

describe("sdk-types.json", () => {
  test("SC103: the committed sdk-types.json equals what the SDK source builds today", () => {
    const committed: unknown = JSON.parse(readFileSync(SDK_TYPES_FILE, "utf8"));

    expect(
      committed,
      "packages/cli/src/sdk-types.json is stale: run `bun run sdk-types`",
    ).toStrictEqual(buildSdkTypes());
  });
});
