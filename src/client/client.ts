import { release } from "node:os";
import { assertSafeApiBaseUrl } from "../utils/security.js";
import { zcodeEnv } from "../utils/util.js";
import { ZCodeProviderSource } from "../types/enums.js";
import { getDeviceMid } from "../identity/device.js";
import type { ZCodeParsedApiKey } from "../types/types.js";

export const DEFAULT_ZAI_ENDPOINT = "https://api.z.ai";
export const DEFAULT_BIGMODEL_ENDPOINT = "https://open.bigmodel.cn";
export const DEFAULT_ZCODE_APP_ENDPOINT = "https://zcode.z.ai";
export const DEFAULT_ZCODE_PLAN_ENDPOINT = "https://zcode.z.ai/api/v1/zcode-plan";

export const APP_VERSION = "3.14.3";
export const PLATFORM = `${process.platform}-${process.arch}`;
export const OS_CATEGORY =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";

export const ENDPOINT_FALLBACKS = [
  DEFAULT_ZAI_ENDPOINT,
  DEFAULT_BIGMODEL_ENDPOINT,
  DEFAULT_ZCODE_APP_ENDPOINT,
];

export function endpointCandidates(): string[] {
  const explicit = zcodeEnv("BASE_URL")?.trim();
  return explicit ? [assertSafeApiBaseUrl(explicit)] : ENDPOINT_FALLBACKS;
}

export const DEFAULT_ENDPOINT = endpointCandidates()[0] || DEFAULT_ZAI_ENDPOINT;

/**
 * Resolve the appropriate base host depending on user's authentication source.
 */
export function resolveBaseHost(auth?: ZCodeParsedApiKey): string {
  const explicit = zcodeEnv("BASE_URL")?.trim();
  if (explicit) {
    return assertSafeApiBaseUrl(explicit);
  }
  if (
    auth?.providerSource === ZCodeProviderSource.BIGMODEL ||
    auth?.providerSource === "bigmodel"
  ) {
    return DEFAULT_BIGMODEL_ENDPOINT;
  }
  return DEFAULT_ZAI_ENDPOINT;
}

/**
 * Prewarm TLS connection to minimize initial request latency.
 */
export function prewarmConnection(endpoint = DEFAULT_ENDPOINT): void {
  if (process.env.ZCODE_NO_PREWARM === "1") {
    return;
  }
  try {
    const url = new URL(endpoint);
    fetch(url.origin, { method: "HEAD", signal: AbortSignal.timeout(3000) }).catch(() => {});
  } catch {
    // Ignore prewarm failures
  }
}

/**
 * Source headers the ZCode client attaches to its requests.
 *
 * Two shapes exist in the real client: the control plane (billing, claim,
 * entitlement probing) always carries X-Device-Mid, while the LLM completion
 * path never does. Pass `includeDeviceMid: false` for completions so the
 * fingerprint matches the client instead of looking like a device-id-carrying
 * impostor.
 */
export function buildZCodeSourceHeaders(
  referer = "https://zcode.z.ai",
  opts: { includeDeviceMid?: boolean } = {},
): Record<string, string> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let language = "unknown";
  try {
    language = Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    // keep the "unknown" fallback, matching the client's own try/catch
  }
  return {
    "HTTP-Referer": referer,
    "User-Agent": `ZCode/${APP_VERSION}`,
    "X-Client-Language": language,
    "X-Client-Timezone": timezone,
    ...(opts.includeDeviceMid === false ? {} : { "X-Device-Mid": getDeviceMid() }),
    "X-Os-Category": OS_CATEGORY,
    "X-Os-Version": release(),
    "X-Platform": PLATFORM,
    "X-Release-Channel": "production",
    "X-Title": "Z Code@cli",
    "X-ZCode-App-Version": APP_VERSION,
    // Emitted by the real client's LLM header builder (x4i) as the last entry.
    "X-ZCode-Agent": "glm",
  };
}

/**
 * Build headers for the ZCode shared planning / entitlement endpoints.
 */
export function buildZCodePlanHeaders(
  auth: ZCodeParsedApiKey,
  extra?: Record<string, string>,
): Record<string, string> {
  const headers = {
    ...buildZCodeSourceHeaders(),
    ...(auth.zcodeJwtToken ? { Authorization: `Bearer ${auth.zcodeJwtToken}` } : {}),
    ...extra,
  };
  return headers;
}

/**
 * Parse an API key or stored OAuth credential string.
 */
export function parseApiKey(apiKeyOrToken: string | undefined): ZCodeParsedApiKey {
  if (!apiKeyOrToken) {
    return { token: "" };
  }

  const trimmed = apiKeyOrToken.trim();

  // If JSON encoded
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as {
          access?: string;
          token?: string;
          businessAccessToken?: string;
          zcodeJwtToken?: string;
          providerSource?: string;
          key?: string;
        },
        token = parsed.access || parsed.token || parsed.key || "";
      return {
        businessAccessToken: parsed.businessAccessToken,
        isOAuth: Boolean(parsed.access || parsed.zcodeJwtToken),
        providerSource: parsed.providerSource,
        token,
        zcodeJwtToken: parsed.zcodeJwtToken,
      };
    } catch {
      // Fall through to plain token
    }
  }

  return {
    isOAuth: trimmed.startsWith("eyJ"),
    token: trimmed,
  };
}

/**
 * Build standard headers for ZCode business / model API requests.
 */
export function buildZCodeHeaders(
  auth: ZCodeParsedApiKey,
  customHeaders?: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...buildZCodeSourceHeaders(),
    ...customHeaders,
  };

  if (auth.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }

  if (auth.zcodeJwtToken) {
    headers["X-Zcode-Token"] = auth.zcodeJwtToken;
  }

  return headers;
}

/**
 * Headers for the LLM completion request: the client's LLM shape (no
 * X-Device-Mid), plus credentials.
 */
export function buildLlmZCodeHeaders(auth: ZCodeParsedApiKey): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...buildZCodeSourceHeaders("https://zcode.z.ai", { includeDeviceMid: false }),
  };
  if (auth.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }
  if (auth.zcodeJwtToken) {
    headers["X-Zcode-Token"] = auth.zcodeJwtToken;
  }
  return headers;
}

/**
 * Headers required for Start Plan / ZCode Plan inference requests.
 */
export function buildStartPlanHeaders(
  auth: ZCodeParsedApiKey,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    ...buildZCodePlanHeaders(auth, extra),
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
}
