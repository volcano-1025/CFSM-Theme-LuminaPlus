// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/utils/clipboard";

function stubClipboard(writeText: ((text: string) => Promise<void>) | null) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });
}

afterEach(() => {
  stubClipboard(null);
  Reflect.deleteProperty(document, "execCommand");
});

describe("copyText", () => {
  it("uses the async clipboard api when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);

    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the clipboard api is missing", async () => {
    // 纯 http 部署的站点没有 navigator.clipboard，没有兜底就永远复制失败。
    stubClipboard(null);
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    await expect(copyText("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // 兜底用的 textarea 必须收拾干净。
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back when the clipboard api rejects", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
    });

    await expect(copyText("hello")).resolves.toBe(true);
  });

  it("reports failure when neither path works", async () => {
    stubClipboard(null);
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });

    await expect(copyText("hello")).resolves.toBe(false);
  });
});
