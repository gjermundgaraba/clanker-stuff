export const USAGE_HTTP_TIMEOUT_MS = 12_000;

export interface FetchJsonSuccess {
  ok: true;
  json: unknown;
}

export interface FetchJsonFailure {
  ok: false;
  message: string;
}

export type FetchJsonResult = FetchJsonSuccess | FetchJsonFailure;

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs: number;
  method?: "GET" | "POST";
  body?: string;
}

export type FetchJson = (url: string, options: FetchJsonOptions) => Promise<FetchJsonResult>;

export const defaultFetchJson: FetchJson = async (url, options): Promise<FetchJsonResult> => {
  const signal = AbortSignal.timeout(options.timeoutMs);

  try {
    const response = await fetch(url, {
      body: options.body,
      headers: options.headers,
      method: options.method ?? "GET",
      signal,
    });

    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      return {
        message: "auth rejected by usage API",
        ok: false,
      };
    }
    if (!response.ok) {
      return {
        message: `HTTP ${response.status}`,
        ok: false,
      };
    }

    try {
      return {
        json: text.length > 0 ? JSON.parse(text) : undefined,
        ok: true,
      };
    } catch {
      return {
        message: "invalid JSON response",
        ok: false,
      };
    }
  } catch (error) {
    if (signal.aborted) {
      return { message: "request timed out", ok: false };
    }
    const message = error instanceof Error ? error.message : "network request failed";
    return { message, ok: false };
  }
};
