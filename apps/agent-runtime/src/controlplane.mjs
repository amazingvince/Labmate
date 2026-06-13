/**
 * HTTP client for the Labmate control plane (apps/web Cloudflare Worker).
 * All writes carry the shared internal bearer token. Shapes follow the OpenAPI
 * contract in apps/api-spec/openapi.yaml.
 */
import { config } from "./config.mjs";

export function makeControlPlaneClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  const base = (baseUrl ?? config.controlPlaneUrl()).replace(/\/$/, "");
  const bearer = token ?? config.internalToken();

  async function request(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${bearer}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
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

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    baseUrl: base,
  };
}
