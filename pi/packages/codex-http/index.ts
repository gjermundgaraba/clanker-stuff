import { Cookie, CookieJar } from "tough-cookie";

// Codex 0.155.0 http-client/chatgpt_hosts.rs. This is infrastructure routing,
// never account/session authentication, so it may be shared across accounts.
const allowedHost = (host: string): boolean =>
  ["chatgpt.com", "chat.openai.com", "chatgpt-staging.com"].includes(host) ||
  host.endsWith(".chatgpt.com") ||
  host.endsWith(".chatgpt-staging.com");

/** Process-local and non-persistent; callers can create isolated stores for tests. */
const adapter = (jar: CookieJar) => {
  return (
    input: string | URL,
    init?: RequestInit,
    fetch: typeof globalThis.fetch = globalThis.fetch,
  ): Promise<Response> => {
    const url = new URL(input);

    if (url.protocol !== "https:" || !allowedHost(url.hostname)) {
      return fetch(input, init);
    }

    const headers = new Headers(init?.headers);
    // Explicit caller cookies take precedence. Never mix a caller's auth jar
    // with our infrastructure jar, or retain any cookie other than __oailb.

    if (!headers.has("cookie")) {
      const cookie = jar.getCookieStringSync(url.href);

      if (cookie) headers.set("cookie", cookie);
    }
    // Automatic redirects forward a manually supplied Cookie header without
    // reevaluating path/host scope. Even cookie-free requests must not follow:
    // cookies in a redirected response would be attributed to the original URL.
    // Manual responses retain their provenance and remain inspectable.
    // Preserve synchronous dispatch failures for the provider retry classifier.

    return fetch(input, {
      ...init,
      headers,
      redirect: init?.redirect === "manual" ? "manual" : "error",
    }).then((response) => {
      for (const raw of response.headers.getSetCookie()) {
        if (raw.length > 4096) continue;
        const cookie = Cookie.parse(raw);

        if (cookie?.key !== "__oailb" || (cookie.domain !== null && !allowedHost(cookie.domain)))
          continue;
        jar.setCookieSync(cookie, url.href, { ignoreError: true });
      }

      return response;
    });
  };
};

export const createCodexHttp = () => adapter(new CookieJar());

const jarKey = Symbol.for("@clanker-stuff/codex-http/jar");
// Separate Pi Jiti loaders share globalThis, not module caches. Retain only the
// jar across reloads, never a fetch function or credentials. Exit discards it.
// SAFETY: This package exclusively owns this namespaced global slot.

const host = globalThis as typeof globalThis & { [jarKey]?: CookieJar };

export const fetchCodexHttp = adapter((host[jarKey] ??= new CookieJar()));
