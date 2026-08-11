import { describe, expect, it } from "vitest";
import {
  getNextViewMode,
  MOBILE_VIEW_MODE_QUERY,
  normalizeViewModeForDevice,
} from "@/hooks/useViewMode";

describe("view mode device contracts", () => {
  it("switches to the mobile cycle at the inclusive 720px media boundary", () => {
    expect(MOBILE_VIEW_MODE_QUERY).toBe("(max-width: 720px)");
    expect(normalizeViewModeForDevice("list", "mobile")).toBe("compact");
    expect(normalizeViewModeForDevice("list", "desktop")).toBe("list");
  });

  it("cycles every desktop view in order", () => {
    expect(getNextViewMode("large", "desktop")).toBe("compact");
    expect(getNextViewMode("compact", "desktop")).toBe("mini");
    expect(getNextViewMode("mini", "desktop")).toBe("list");
    expect(getNextViewMode("list", "desktop")).toBe("large");
  });

  it("cycles mobile views without exposing the desktop-only list view", () => {
    expect(getNextViewMode("large", "mobile")).toBe("compact");
    expect(getNextViewMode("compact", "mobile")).toBe("mini");
    expect(getNextViewMode("mini", "mobile")).toBe("large");
    expect(getNextViewMode("list", "mobile")).toBe("mini");
  });
});
