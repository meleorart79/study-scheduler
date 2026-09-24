import { describe, expect, it } from "vitest";
import { encryptOrder } from "../src/hyperplanning/session.js";

describe("Hyperplanning USPN request-order protocol", () => {
  it("matches the HAR's first anonymous request-order token", () => {
    expect(encryptOrder(1, Buffer.alloc(0))).toBe("3fa959b13967e0ef176069e01e23c8d7");
  });

  it("matches the HAR's second request-order token for its captured IV", () => {
    const iv = Buffer.from("fYy7vgjsKeR187/MdZqhNQ==", "base64");
    expect(encryptOrder(3, iv)).toBe("23bcf9645dcda7613703cdca4f96e297");
  });
});
