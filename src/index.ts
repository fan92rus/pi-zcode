import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { getZCodeApiKey, loginZCode, refreshZCodeToken } from "./auth/index.js";
import { readStoredZCodeCredentials } from "./auth/credentials.js";
import {
  acquireCaptchaVerifyParam,
  DEFAULT_ENDPOINT,
  endpointCandidates,
  prewarmConnection,
} from "./client/index.js";
import { getLastDiagnostics, runWithDiagnostics } from "./diagnostics/index.js";
import {
  buildModelsForPlan,
  DEFAULT_THINKING_LEVEL_MAP,
  fetchModelCatalog,
  fetchModelIdsForPlan,
  PROVIDER_ID,
} from "./models/index.js";
import { detectAccountPlans } from "./plans/index.js";
import { setFallbackPlan, ZCODE_API, streamZCode } from "./stream/index.js";
import { ZCodePlan, ZCodePlanStatus } from "./types/enums.js";
import type { ZCodeAccountPlans, ZCodeParsedApiKey } from "./types/types.js";
import { fetchAccountUsage, formatUsageReport, resolveApiKeyFromContext } from "./usage/index.js";
import { redactSecrets } from "./utils/index.js";

/**
 * Models pi can resolve BEFORE the live entitlement probe finishes.
 *
 * Registering the provider with an empty model list made pi fall back to its
 * own default model (anthropic/claude-opus) while the async plan detection was
 * still in flight — the request went to a completely different provider. These
 * static entries keep `zcode/<model>` addressable from the first millisecond;
 * the live catalog replaces them as soon as detection completes.
 */
const STATIC_FALLBACK_MODELS = ["glm-5.3", "glm-5.3-flash"].map((id) => ({
  id,
  name: id === "glm-5.3" ? "GLM-5.3" : "GLM-5.3-Flash",
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  thinkingLevelMap: DEFAULT_THINKING_LEVEL_MAP,
}));

function emitCommandOutput(
  ctx: ExtensionCommandContext,
  text: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, type);
    return;
  }
  if (type === "warning" || type === "error") {
    console.error(text);
  } else {
    console.log(text);
  }
}

let activeExtensionAPI: ExtensionAPI | undefined = undefined;

export async function detectAndRegisterPlans(
  pi: ExtensionAPI,
  credentials: ZCodeParsedApiKey,
): Promise<ZCodeAccountPlans> {
  const credsPayload = credentials
    ? JSON.stringify({
        access: credentials.token,
        businessAccessToken: credentials.businessAccessToken,
        zcodeJwtToken: credentials.zcodeJwtToken,
        providerSource: credentials.providerSource,
      })
    : "";

  const plans = await runWithDiagnostics(() => detectAccountPlans(credsPayload));
  const catalog = await fetchModelCatalog(credentials.zcodeJwtToken);

  // Single provider policy: pi shows ONE provider (`zcode`); the extension
  // routes each request to the plan the account is actually entitled to.
  // Registering per-plan providers only cluttered /model and — worse — left
  // the plain `zcode` provider bound to START_PLAN, which answers 401 for a
  // paid account (and drags in a captcha solve).
  const activePlan =
    plans.individualPlan.status === ZCodePlanStatus.ACTIVE
      ? ZCodePlan.INDIVIDUAL_PLAN
      : plans.startPlan.status === ZCodePlanStatus.ACTIVE
        ? ZCodePlan.START_PLAN
        : undefined;
  setFallbackPlan(activePlan);

  const allActiveModels = [];

  if (activePlan === ZCodePlan.INDIVIDUAL_PLAN) {
    const ids = await fetchModelIdsForPlan(
      ZCodePlan.INDIVIDUAL_PLAN,
      credentials
        ? JSON.stringify({ access: credentials.token, providerSource: credentials.providerSource })
        : undefined,
      undefined,
    );
    allActiveModels.push(...buildModelsForPlan(ids, catalog));
  } else if (activePlan === ZCodePlan.START_PLAN) {
    const ids = await fetchModelIdsForPlan(
      ZCodePlan.START_PLAN,
      credentials
        ? JSON.stringify({
            access: credentials.token,
            providerSource: credentials.providerSource,
          })
        : undefined,
      plans.startPlan.models,
    );
    allActiveModels.push(...buildModelsForPlan(ids, catalog));
  }

  // Register active models on the single `zcode` provider so /model zcode/<model> works
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: allActiveModels.length > 0 ? allActiveModels : STATIC_FALLBACK_MODELS,
    oauth: {
      name: "ZCode",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        if (activeExtensionAPI) {
          const parsed = readStoredZCodeCredentials(true);
          if (parsed) {
            await detectAndRegisterPlans(activeExtensionAPI, parsed).catch(() => undefined);
          }
        }
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  return plans;
}

export default async function initZCodeExtension(pi: ExtensionAPI): Promise<void> {
  activeExtensionAPI = pi;

  const [primaryEndpoint] = endpointCandidates();
  if (primaryEndpoint) {
    prewarmConnection(primaryEndpoint);
  }

  registerApiProvider({
    api: ZCODE_API,
    stream: streamZCode,
    streamSimple: streamZCode,
  });

  // Base provider registration
  pi.registerProvider(PROVIDER_ID, {
    name: "ZCode",
    baseUrl: DEFAULT_ENDPOINT,
    api: ZCODE_API,
    models: STATIC_FALLBACK_MODELS,
    oauth: {
      name: "ZCode",
      login: async (callbacks) => {
        const creds = await loginZCode(callbacks);
        const parsed = readStoredZCodeCredentials(true);
        if (parsed) {
          await detectAndRegisterPlans(pi, parsed).catch(() => undefined);
        }
        return creds;
      },
      refreshToken: refreshZCodeToken,
      getApiKey: getZCodeApiKey,
    },
    streamSimple: streamZCode,
  });

  // If already logged in, register plan providers immediately on startup
  const stored = readStoredZCodeCredentials(true);
  if (stored) {
    await detectAndRegisterPlans(pi, stored).catch(() => undefined);
  }

  // Refresh plan registration on session start
  pi.on("session_start", async () => {
    const creds = readStoredZCodeCredentials(true);
    if (creds) {
      await detectAndRegisterPlans(pi, creds).catch(() => undefined);
    }
  });

  pi.registerCommand("zcode.usage", {
    description: "Show detected plans, daily balance, and subscription status",
    handler: async (_args, ctx) => {
      try {
        const apiKey = await resolveApiKeyFromContext(ctx);
        if (!apiKey) {
          emitCommandOutput(ctx, "No ZCode credentials found. Run /login zcode first.", "warning");
          return;
        }
        if (ctx.hasUI) {
          ctx.ui.notify("Fetching ZCode usage…", "info");
        }
        const creds = readStoredZCodeCredentials(true);
        const plans = creds
          ? await detectAccountPlans(
              JSON.stringify({
                access: creds.token,
                businessAccessToken: creds.businessAccessToken,
                zcodeJwtToken: creds.zcodeJwtToken,
                providerSource: creds.providerSource,
              }),
            )
          : await detectAccountPlans(apiKey);
        const usage = await fetchAccountUsage(apiKey, plans);
        emitCommandOutput(ctx, formatUsageReport(plans, usage));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        emitCommandOutput(ctx, `Failed to fetch ZCode usage: ${msg}`, "warning");
      }
    },
  });

  pi.registerCommand("zcode.doctor", {
    description: "Show ZCode diagnostics report",
    handler: async (_args, ctx) => {
      const d = getLastDiagnostics();
      const lines = [
        "ZCode Provider Doctor",
        `• providerId: ${PROVIDER_ID}`,
        `• endpoint: ${d.endpoint || "none"}`,
        `• status: ${d.status ?? "none"}`,
        `• model: ${d.resolvedRuntimeModel || "none"}`,
        `• latencyMs: ${d.latencyMs !== undefined ? `${d.latencyMs}ms` : "none"}`,
        `• requestId: ${d.requestId || "none"}`,
        `• error: ${d.error ? redactSecrets(d.error) : "none"}`,
        "• transport: native-streamSimple (SSE)",
        "• commands: /login zcode, /zcode.usage, /zcode.doctor",
      ];
      emitCommandOutput(ctx, lines.join("\n"));
    },
  });

  const OVERFLOW_PATTERN = /context_length_exceeded|maximum context length/i;
  pi.on("message_end", (event, _ctx) => {
    const { message } = event;
    if (message.role !== "assistant") {
      return;
    }
    if (message.stopReason !== "error") {
      return;
    }
    if (
      message.provider !== "zcode-start-plan" &&
      message.provider !== "zcode-individual-plan" &&
      message.provider !== PROVIDER_ID
    ) {
      return;
    }
    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) {
      return;
    }
    if (!OVERFLOW_PATTERN.test(errorMessage)) {
      return;
    }
    return {
      message: { ...message, errorMessage: `context_length_exceeded: ${errorMessage}` },
    };
  });
}
