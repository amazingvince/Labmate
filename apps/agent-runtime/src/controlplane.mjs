/**
 * HTTP client for the Labmate control plane (apps/web Cloudflare Worker).
 * All writes carry the shared internal bearer token. Shapes follow the OpenAPI
 * contract in apps/api-spec/openapi.yaml.
 */
import { config } from "./config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeControlPlaneClient({
  baseUrl,
  token,
  fetchImpl = fetch,
  // Bounded retry for TRANSIENT failures only (network throw, or a 5xx/429 status).
  // 4xx (402 approval gate, 422 banned-column, 400) are deterministic answers we must
  // relay unchanged — never retried. Tests can set retries:0 to keep the loop tight.
  retries = 2,
  retryBaseMs = 250,
} = {}) {
  const base = (baseUrl ?? config.controlPlaneUrl()).replace(/\/$/, "");
  const bearer = token ?? config.internalToken();

  async function request(method, path, body) {
    let lastTransport;
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${bearer}`,
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        // Transport-level failure (DNS, connection reset, timeout). Retry with
        // exponential backoff; surface a structured error once the budget is spent
        // so the dispatcher/loop can close subscribers instead of stranding them.
        lastTransport = err;
        if (attempt < retries) {
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        return { error: "controlplane_unreachable", detail: String(err?.message ?? err), http_status: 0 };
      }

      // Retry transient server-side failures (502/503/504 from the Worker/edge, or a
      // 429 rate limit) — but only those. Everything else is the server's real answer.
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }

      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (!res.ok) {
        // Return a structured error the dispatcher can relay to the agent (e.g. the
        // 402 approval gate or the 422 banned-column rejection) instead of throwing.
        return { error: json?.error ?? "request_failed", detail: json?.detail ?? text, http_status: res.status };
      }
      return json;
    }
    // unreachable (the loop always returns), but keeps linters happy:
    // eslint-disable-next-line no-unreachable
    return { error: "controlplane_unreachable", detail: String(lastTransport), http_status: 0 };
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    baseUrl: base,
  };
}
