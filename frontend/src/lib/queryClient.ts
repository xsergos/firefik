import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { APIError } from "@/lib/api";

function handleError(err: unknown) {
  if (err instanceof APIError) {
    toast.error(err.userMessage, { id: `api-${err.code}` });
    console.debug("query error", { status: err.status, code: err.code, details: err.details });
    return;
  }
  if (err instanceof Error && err.message) {
    toast.error("Unexpected error", { description: err.message });
    return;
  }
  toast.error("Unexpected error");
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleError }),
  mutationCache: new MutationCache({ onError: handleError }),
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (failureCount, err) => {
        if (err instanceof APIError && err.status >= 400 && err.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
  },
});
