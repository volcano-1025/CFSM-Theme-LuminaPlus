import { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "@/services/api";

function shouldRetry(failureCount: number, error: unknown) {
  if (
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  ) {
    return false;
  }
  return failureCount < 1;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: shouldRetry,
    },
  },
});
