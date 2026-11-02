# Local patches: making the Individual (paid Coding) Plan usable

This fork carries fixes that were needed to run `pi-zcode` as a real coding
agent against a **GLM Coding Plan / Individual Plan** account. Every item below
was reproduced live against `api.z.ai` and `zcode.z.ai`; the numbers quoted are
measured, not inferred.

Base: upstream `xifan2333/pi-zcode` @ `47bbdbe` (v0.1.4).

---

## 1. Wrong upstream path for the paid plan → `429 1113`

`resolveEndpointForPlan()` appended `/api/paas/v4/chat/completions` to the
registered provider `baseUrl` (`https://api.z.ai`) and only chose
`/api/coding/paas/v4/...` when `baseUrl` was absent. `PI_ZCODE_BASE_URL` shared
the same flaw.

Consequence: the paid coding subscription answered

```
429 {"error":{"code":"1113","message":"Insufficient balance or no resource package."}}
```

which fell into the retry/captcha ladder and finally surfaced as
`ECONNRESET` after ~180 s, i.e. "pi hangs with no answer".

Fix: a bare host now maps to `/api/coding/paas/v4`, an existing `/api/paas/v4`
path is rewritten to the coding path, and only a full `/chat/completions` URL is
used verbatim.

## 2. Provider `zcode` was hard-wired to the Start Plan

`resolvePlanFromModel()` returned `INDIVIDUAL_PLAN` only for provider ids
`zcode-individual-plan` / `zcode-individual` and `START_PLAN` for everything
else — so the plain provider advertised in the README always took the
`zcode.z.ai` Start Plan path (JWT + Aliyun captcha), which a paid account is not
entitled to. That produced `401 Authentication failed` plus a 48 s captcha
solve.

Fix: one provider, routed internally.

- `index.ts` detects the active entitlements and calls `setFallbackPlan(plan)`.
- `resolvePlanFromModel()` keeps explicit plan providers working and otherwise
  uses the detected plan.
- Only the `zcode` provider is registered, so model names stay identical and the
  user does not pick a plan manually.

## 3. Static fallback models (pi raced the async detection)

pi resolves the default provider/model before the extension's async entitlement
probe (≈8 s of network) finishes. Without a synchronous model list it fell back
to its built-in default and the session actually ran
`anthropic/claude-opus-4-8` (visible in the session JSONL), dying on an Anthropic
rate limit.

Fix: `STATIC_FALLBACK_MODELS` (`glm-5.3`, `glm-5.3-flash`) is registered
synchronously on load and is also used whenever live detection yields nothing.

## 4. Anthropic payloads sent to an OpenAI endpoint → tools silently ignored

For the Individual Plan `buildRequestBody()` sent Anthropic-shaped data to the
OpenAI chat-completions endpoint: tools as `{name, description, input_schema}`,
`tool_use` / `tool_result` content blocks, tool results as `role:"user"`, and no
system prompt at all.

The upstream accepted the request and ignored every tool, so the model answered
"as an AI I have no terminal access".

Fix: `convertToolsOpenAI()` (`{type:"function", function:{name, description,
parameters}}`) and `convertMessagesOpenAI()` (leading `role:"system"`, images as
`image_url` data URLs, `assistant.tool_calls` with JSON-stringified arguments,
tool results as `role:"tool"` with `tool_call_id`), plus `tool_choice:"auto"` and
`stream_options:{include_usage:true}`.

## 5. System prompt and tools were never read (pi ≥ 0.8x transcripts)

pi passes an **empty** `context.systemPrompt` and `context.tools` to custom
stream providers; both live in the transcript as leading `role:"system"`
messages (`toolsAdded` / `toolsRemoved` deltas). Reading only the legacy fields
sent every request without a system prompt and without tools — the model
correctly reported having no tools.

Fix: `resolveTranscriptSystemPrompt()` / `resolveTranscriptTools()` fold the
transcript into the values both plans use (the equivalent of pi-ai's
`getCurrentSystemPrompt` / `getCurrentTools`, implemented locally so the
extension does not depend on a `./utils/transcript` subpath export).

## 6. Cached prompt tokens were billed twice

`prompt_tokens` already contains the cached prefix, and it was copied verbatim
into `usage.input`, so pi saw cached tokens as fresh input (inflated cost and a
context meter that reads near-full).

Fix: `usage.input = prompt_tokens - prompt_tokens_details.cached_tokens`, with
`cacheRead` carrying the cached part (pi's own convention, matching what the
built-in OpenAI transport does).

Measured with a ~19 k-token prefix: first call `input 19122 / cacheRead 0`,
second call `input 50 / cacheRead 19072` — i.e. upstream prefix caching works and
is now accounted for correctly.

## 7. Captcha solve destroyed Node globals (upstream issue #1)

`removeGlobalWindowAlias()` swept `Object.getOwnPropertyNames(w)` and deleted
every property with a getter, which on Node ≥ 22 includes native accessors
(`Buffer`, `performance`, `navigator`, `crypto`). After the first captcha solve
pi died with `ReferenceError: Buffer is not defined`.

Fix: record-restore. Each global's descriptor is captured before the alias is
installed and restored exactly afterwards; names that did not exist are deleted
instead of trusted to the sweep.

## 8. Client fingerprint aligned with the real client

The identity headers were close but not identical to what the ZCode 3.9.1+
client sends on the LLM path:

| header | before | after |
|---|---|---|
| `User-Agent`, `X-ZCode-App-Version` | `ZCode/3.10.2` | `ZCode/3.14.3` |
| `X-Title` | `Z Code@pi-zcode` | `Z Code@cli` |
| `X-Release-Channel` | `stable` | `production` |
| `X-Client-Language` | hardcoded `en-US` | resolved locale (`Intl`) |
| `X-Device-Mid` | on every request | control plane only — the client's completion path never sends it |
| `X-ZCode-Agent` | missing | `glm` |

Caveat, measured: the coding-plan gateway **does not verify this fingerprint at
all**. The same completion sent with `User-Agent: curl/8.5.0`,
`X-ZCode-App-Version: 0.0.1` and a foreign `HTTP-Referer` returns `200` with the
same catalog, subscription and quota payload. The entitlement rides on the API
key. The real gate is per-request request signing (Ed25519 + 8-bit proof of work,
headers `x-client-ts` / `x-client-version` / `x-client-sig` / `x-client-nonce` /
`x-app-id` / `x-client-pow`), which this extension does **not** implement; the
gate is currently fail-open and unsigned traffic is accepted.

## 9. `scripts/identity-probe.ts`

Reproducible answer to "does upstream believe we are the ZCode client?":

```bash
bun run scripts/identity-probe.ts
```

It reads the stored `zcode` credential from `~/.pi/agent/auth.json` (no key is
embedded in this repository), sends each probe twice — once with the real-client
header set, once with a deliberately hostile one — and prints a verdict:

```
completion identity enforced: not-enforced
catalog identity enforced:    not-enforced
config plane identity check:  not-enforced
request signing required now: false
```

Watch this output after upstream changes. `enforced` (together with
`VERIFY_SIGNATURE_INVALID` / `VERIFY_APIKEY_EXPIRED` / `3001 parameter error`)
means header puppetry is over and request signing has to be ported.

---

## Notes

- Everything above is verified on Windows with `pi` 1.4.0, `@earendil-works/pi-ai`
  from the same install, `bun` 1.4.4 and `node` 22.
- `npx tsc --noEmit` is clean.
- Live verification of the whole chain: `pi --model zcode/glm-5.3-flash -p
  "run bash: echo hi"` executes the tool and returns its output in ~30 s.
