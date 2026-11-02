/**
 * "Does upstream actually believe we are the ZCode client?" — empirical probe.
 *
 * The identity headers we emit (User-Agent `ZCode/<ver>`, X-ZCode-App-Version,
 * X-Title, X-ZCode-Agent, X-Device-Mid, ...) are a *fingerprint*, not a
 * credential. The only way to know whether upstream checks that fingerprint is
 * to send the same request twice: once with the real-client header set, once
 * with a deliberately hostile one (curl UA, bogus app version, foreign
 * referer), and compare what comes back.
 *
 * Verdict rules:
 *   - hostile === real  -> identity is NOT enforced (our headers are cosmetic;
 *                          the plan entitlement rides on the API key)
 *   - hostile rejected (3001/3012/401 VERIFY_*) -> identity/signature IS
 *                          enforced; the fix is request signing (see below),
 *                          not more header puppetry.
 *
 * Signing note: ZCode >= 3.9.1 signs coding-plan traffic with an Ed25519
 * per-request signature + 8-bit proof of work (headers x-client-ts,
 * x-client-version, x-client-sig, x-client-nonce, x-app-id, x-client-pow,
 * x-client-sign-verified; handshake POST https://zcode.z.ai/api/paas/c1f3a7e2/v2/client
 * with method get_sign_key). Start-plan and off-peak LLM paths are exempt.
 * This probe reports `signingRequired` when an unsigned request starts being
 * rejected.
 *
 * Usage:  bun run scripts/identity-probe.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AUTH_PATH = path.join(os.homedir(), ".pi", "agent", "auth.json");

type Verdict = "not-enforced" | "enforced" | "inconclusive";

function readCredential(): string {
  const raw = JSON.parse(fs.readFileSync(AUTH_PATH, "utf8")) as Record<string, any>;
  const entry = raw["zcode"];
  if (!entry) throw new Error(`no "zcode" credential in ${AUTH_PATH} — run /login zcode first`);
  const access = entry.access ?? entry.key;
  if (!access) throw new Error("zcode credential has no access/key field");
  return String(access);
}

function realHeaders(): Record<string, string> {
  let language = "unknown";
  try {
    language = Intl.DateTimeFormat().resolvedOptions().locale || "unknown";
  } catch {
    /* keep fallback */
  }
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": "ZCode/3.14.3",
    "X-ZCode-App-Version": "3.14.3",
    "X-Title": "Z Code@cli",
    "X-Release-Channel": "production",
    "X-Client-Language": language,
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    "X-Os-Version": os.release(),
    "X-ZCode-Agent": "glm",
    "X-Device-Mid": "00000000-0000-4000-8000-000000000000",
  };
}

function hostileHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "curl/8.5.0",
    "HTTP-Referer": "https://example.com",
    "X-ZCode-App-Version": "0.0.1",
    "X-Title": "not-zcode",
  };
}

async function call(url: string, init: RequestInit): Promise<{ status: number; ms: number; body: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), redirect: "manual" });
    const text = await res.text();
    return { status: res.status, ms: Date.now() - started, body: text };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, body: `ERROR ${(error as Error).message}` };
  }
}

function firstKeys(body: string, limit = 90): string {
  return body.replace(/\s+/g, " ").slice(0, limit);
}

const credential = readCredential();
const key = `Bearer ${credential}`;
const base = "https://api.z.ai/api/coding/paas/v4";
const chatBody = JSON.stringify({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "reply with the single word: ok" }],
  max_tokens: 16,
  stream: false,
});

console.log("== 1. completion door (api.z.ai coding plan) ==");
const realChat = await call(`${base}/chat/completions`, {
  method: "POST",
  headers: { ...realHeaders(), Authorization: key },
  body: chatBody,
});
const hostileChat = await call(`${base}/chat/completions`, {
  method: "POST",
  headers: { ...hostileHeaders(), Authorization: key },
  body: chatBody,
});
console.log(`  real    http=${realChat.status} ${realChat.ms}ms ${firstKeys(realChat.body)}`);
console.log(`  hostile http=${hostileChat.status} ${hostileChat.ms}ms ${firstKeys(hostileChat.body)}`);

console.log("== 2. model catalog ==");
const realModels = await call(`${base}/models`, { headers: { ...realHeaders(), Authorization: key } });
const hostileModels = await call(`${base}/models`, { headers: { ...hostileHeaders(), Authorization: key } });
const countModels = (body: string): number => {
  try {
    return (JSON.parse(body).data ?? []).length;
  } catch {
    return -1;
  }
};
console.log(`  real    http=${realModels.status} models=${countModels(realModels.body)}`);
console.log(`  hostile http=${hostileModels.status} models=${countModels(hostileModels.body)}`);

console.log("== 3. entitlement control plane (subscription list) ==");
const realSub = await call("https://api.z.ai/api/biz/subscription/list", {
  headers: { ...realHeaders(), Authorization: key },
});
const hostileSub = await call("https://api.z.ai/api/biz/subscription/list", {
  headers: { ...hostileHeaders(), Authorization: key },
});
console.log(`  real    http=${realSub.status} ${firstKeys(realSub.body, 60)}`);
console.log(`  hostile http=${hostileSub.status} ${firstKeys(hostileSub.body, 60)}`);

console.log("== 4. ZCode client config plane (zcode.z.ai) ==");
const realCfg = await call("https://zcode.z.ai/api/v1/client/configs?app_version=3.14.3&platform=win32-x64", {
  headers: realHeaders(),
});
const hostileCfg = await call("https://zcode.z.ai/api/v1/client/configs?app_version=3.14.3&platform=win32-x64", {
  headers: hostileHeaders(),
});
const cfgCode = (body: string): number => {
  try {
    return Number(JSON.parse(body).code);
  } catch {
    return -1;
  }
};
const cfgHasSigningText = (body: string): boolean => /VERIFY_|signature|x-client-sig/i.test(body);
console.log(`  real    http=${realCfg.status} code=${cfgCode(realCfg.body)} ${firstKeys(realCfg.body, 60)}`);
console.log(`  hostile http=${hostileCfg.status} code=${cfgCode(hostileCfg.body)} ${firstKeys(hostileCfg.body, 60)}`);
console.log(`  signing hints in gate payload: ${cfgHasSigningText(realCfg.body) || cfgHasSigningText(hostileCfg.body)}`);

const signatureRejection = /VERIFY_SIGNATURE_INVALID|VERIFY_APIKEY_EXPIRED|x-client-sig|signature/i;

function classify(real: { status: number; body: string }, hostile: { status: number; body: string }): Verdict {
  if (signatureRejection.test(hostile.body) && !signatureRejection.test(real.body)) return "enforced";
  if (real.status === hostile.status && real.status >= 200 && real.status < 300) return "not-enforced";
  if (hostile.status === 0 || real.status === 0) return "inconclusive";
  if (real.status >= 200 && real.status < 300 && hostile.status >= 400) return "enforced";
  return "inconclusive";
}

const verdictChat = classify(realChat, hostileChat);
const verdictModels = classify(realModels, hostileModels);
const verdictCfg = classify(realCfg, hostileCfg);

console.log("== verdict ==");
console.log(`  completion identity enforced: ${verdictChat}`);
console.log(`  catalog identity enforced:    ${verdictModels}`);
console.log(`  config plane identity check:  ${verdictCfg}`);
const signingRequired = verdictChat === "enforced" || /VERIFY_|x-client-sig|signature/i.test(hostileChat.body);
console.log(`  request signing required now: ${signingRequired}`);
if (signingRequired) {
  console.log("  -> port ClientRequestSigningV4 (Ed25519 + PoW) from ZCode-Agent-Kit,");
  console.log("     headers x-client-ts/version/sig/nonce + x-app-id + x-client-pow.");
} else {
  console.log("  -> upstream does not check the fingerprint on this door: the plan");
  console.log("     entitlement rides on the API key alone. Impersonation here is cosmetic,");
  console.log("     so re-run this probe after upstream changes instead of tuning headers.");
}
process.exit(0);
