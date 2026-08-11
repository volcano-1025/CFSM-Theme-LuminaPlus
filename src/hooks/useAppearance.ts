import { usePreferences } from "@/hooks/usePreferences";

// usePreferences 负责订阅和 DOM 同步，这里只暴露已解析外观。
export function useAppearance() {
  return usePreferences().resolvedAppearance;
}
