import type { Config, Hooks, Plugin } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk/v2"
import { OAUTH_DUMMY_KEY } from "../auth"

/**
 * Subscription providers ported from the DeepSeek Harness provider catalog.
 * Each provider is a config-provider (so it survives models.dev refreshes)
 * plus an auth hook that injects the correct wire auth for the dialect it
 * actually speaks:
 *
 * - kimi-code / kimi-sub speak OpenAI-compatible chat completions against
 *   https://api.kimi.com/coding/v1 (the claude-dialect `/coding/messages`
 *   route does not exist).
 * - claude-sub speaks the anthropic messages API against api.anthropic.com
 *   with the OAuth beta header.
 * - grok-sub speaks OpenAI-compatible chat completions against the grok CLI
 *   subscription proxy with the CLI identity headers and real model ids
 *   (the old `api.x.ai/coding` claude route and `grok-code-*` ids are dead).
 * - gemini-sub reverse-engineers the Antigravity/Gemini Code Assist client:
 *   an OAuth bearer against `cloudcode-pa.googleapis.com/v1internal` with the
 *   code-assist request wrapper (`{model, user_prompt_id, request}`) and an
 *   SSE response whose chunks carry the generate-content response under a
 *   `response` field that must be unwrapped for the AI SDK.
 */
type AuthKind = "api-key" | "bearer" | "gemini-code-assist"

type Spec = {
  id: string
  name: string
  env: string[]
  npm: string
  api: string
  auth: AuthKind
  prompt: string
  headers?: Record<string, string>
  models: Record<
    string,
    {
      name: string
      context: number
      output: number
      reasoning?: boolean
    }
  >
}

const KIMI_CONTEXT = 1_000_000
const KIMI_MAX_OUTPUT = 256_000
const CLAUDE_CONTEXT = 1_000_000
const CLAUDE_MAX_OUTPUT = 128_000
const GEMINI_CONTEXT = 1_000_000
const GEMINI_MAX_OUTPUT = 64_000
const GROK_CONTEXT = 256_000
const GROK_MAX_OUTPUT = 32_000

const KIMI_MODELS: Spec["models"] = {
  "kimi-k3": { name: "Kimi K3", context: KIMI_CONTEXT, output: KIMI_MAX_OUTPUT },
  "kimi-k2.7-code": { name: "Kimi K2.7 Code", context: KIMI_CONTEXT, output: 128_000 },
  "kimi-k2.6": { name: "Kimi K2.6", context: KIMI_CONTEXT, output: 128_000 },
  "kimi-k2.5": { name: "Kimi K2.5", context: KIMI_CONTEXT, output: 128_000 },
}

const CLAUDE_MODELS: Spec["models"] = {
  "claude-opus-5": { name: "Claude Opus 5", context: CLAUDE_CONTEXT, output: CLAUDE_MAX_OUTPUT },
  "claude-sonnet-5": { name: "Claude Sonnet 5", context: CLAUDE_CONTEXT, output: CLAUDE_MAX_OUTPUT },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", context: CLAUDE_CONTEXT, output: CLAUDE_MAX_OUTPUT },
  "claude-opus-4-8": { name: "Claude Opus 4.8", context: CLAUDE_CONTEXT, output: CLAUDE_MAX_OUTPUT },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", context: 200_000, output: 64_000 },
}

const GROK_MODELS: Spec["models"] = {
  "grok-4.6": { name: "Grok 4.6", context: GROK_CONTEXT, output: GROK_MAX_OUTPUT },
  "grok-4.5": { name: "Grok 4.5", context: GROK_CONTEXT, output: GROK_MAX_OUTPUT },
  "grok-composer-2.5-fast": { name: "Grok Composer 2.5 Fast", context: GROK_CONTEXT, output: GROK_MAX_OUTPUT },
}

const GEMINI_MODELS: Spec["models"] = {
  "gemini-3.6-flash": { name: "Gemini 3.6 Flash", context: GEMINI_CONTEXT, output: GEMINI_MAX_OUTPUT },
  "gemini-3.5-flash": { name: "Gemini 3.5 Flash", context: GEMINI_CONTEXT, output: GEMINI_MAX_OUTPUT },
  "gemini-3.1-pro": { name: "Gemini 3.1 Pro", context: GEMINI_CONTEXT, output: GEMINI_MAX_OUTPUT },
  "gemini-3-pro": { name: "Gemini 3 Pro", context: GEMINI_CONTEXT, output: GEMINI_MAX_OUTPUT },
}

const SPECS: Spec[] = [
  {
    id: "kimi-code",
    name: "Kimi Code (API)",
    env: ["KIMI_API_KEY"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.kimi.com/coding/v1",
    auth: "api-key",
    prompt: "Kimi Code API key",
    models: KIMI_MODELS,
  },
  {
    id: "kimi-sub",
    name: "Kimi Code (Subscription)",
    env: ["KIMI_SUB_OAUTH_TOKEN"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://api.kimi.com/coding/v1",
    auth: "bearer",
    prompt: "Kimi subscription OAuth token",
    models: KIMI_MODELS,
  },
  {
    id: "claude-sub",
    name: "Claude (Subscription)",
    env: ["CLAUDE_SUB_OAUTH_TOKEN"],
    npm: "@ai-sdk/anthropic",
    api: "https://api.anthropic.com/v1",
    auth: "bearer",
    prompt: "Claude subscription OAuth token",
    headers: { "anthropic-beta": "oauth-2025-04-20" },
    models: CLAUDE_MODELS,
  },
  {
    id: "grok-sub",
    name: "Grok (Subscription)",
    env: ["GROK_SUB_OAUTH_TOKEN"],
    npm: "@ai-sdk/openai-compatible",
    api: "https://cli-chat-proxy.grok.com/v1",
    auth: "bearer",
    prompt: "Grok subscription OAuth token",
    headers: {
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-client-identifier": "grok-shell",
      "x-grok-client-version": "0.2.93",
    },
    models: GROK_MODELS,
  },
  {
    id: "gemini-sub",
    name: "Gemini (Subscription)",
    env: ["GEMINI_SUB_OAUTH_TOKEN"],
    npm: "@ai-sdk/google",
    api: "https://cloudcode-pa.googleapis.com/v1internal",
    auth: "gemini-code-assist",
    prompt:
      "Gemini subscription OAuth token, as JSON {\"access\":...,\"refresh\":...,\"expires\":...} or a bare access token",
    models: GEMINI_MODELS,
  },
]

function providerConfig(spec: Spec): NonNullable<Config["provider"]>[string] {
  const models: NonNullable<NonNullable<Config["provider"]>[string]["models"]> = {}
  for (const [id, model] of Object.entries(spec.models)) {
    models[id] = {
      name: model.name,
      ...(model.reasoning ? { reasoning: true } : {}),
      limit: { context: model.context, output: model.output },
    }
  }
  return {
    name: spec.name,
    env: spec.env,
    npm: spec.npm,
    api: spec.api,
    models,
  }
}

function tokenOf(auth: Auth): string | undefined {
  if (auth.type === "api") return auth.key
  if (auth.type === "oauth") return auth.access
  return undefined
}

function bearerFetch(getAuth: () => Promise<Auth>, extra?: Record<string, string>) {
  return async function fetchWithBearer(input: RequestInfo | URL, init?: RequestInit) {
    const auth = await getAuth()
    const token = tokenOf(auth)
    if (!token) return fetch(input, init)
    const headers = new Headers(init?.headers)
    headers.delete("x-api-key")
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${token}`)
    for (const [key, value] of Object.entries(extra ?? {})) headers.set(key, value)
    return fetch(input, { ...init, headers })
  }
}

const GEMINI_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
const GEMINI_OAUTH_CLIENT_SECRET = "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"
const GEMINI_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"

type GeminiToken = { access: string; refresh?: string; expires?: number }

function geminiToken(auth: Auth): GeminiToken | undefined {
  if (auth.type === "oauth") {
    return { access: auth.access, refresh: auth.refresh, expires: auth.expires }
  }
  if (auth.type === "api") {
    try {
      const parsed = JSON.parse(auth.key) as { access?: unknown; refresh?: unknown; expires?: unknown }
      if (typeof parsed.access === "string") {
        return {
          access: parsed.access,
          refresh: typeof parsed.refresh === "string" ? parsed.refresh : undefined,
          expires: typeof parsed.expires === "number" ? parsed.expires : undefined,
        }
      }
    } catch {
      // Bare access token.
    }
    return { access: auth.key }
  }
  return undefined
}

async function refreshGeminiToken(refreshToken: string): Promise<{ access: string; expires: number }> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    refresh_token: refreshToken,
  })
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params,
  })
  if (!res.ok) throw new Error(`Gemini token refresh failed: ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  return { access: data.access_token, expires: Date.now() + (data.expires_in - 120) * 1000 }
}

function unwrapGeminiSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""
  let pending: string[] = []
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const lines = (buffer + decoder.decode(chunk, { stream: true })).split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (line.startsWith("data:")) {
            pending.push(line.slice(5).trim())
          } else if (line.trim() === "" && pending.length > 0) {
            const json = pending.join("\n")
            pending = []
            let out: string
            try {
              const parsed = JSON.parse(json) as { response?: unknown }
              out = JSON.stringify(parsed.response ?? parsed)
            } catch {
              out = json
            }
            controller.enqueue(encoder.encode(`data: ${out}\n\n`))
          }
        }
      },
      flush(controller) {
        if (pending.length > 0) {
          const json = pending.join("\n")
          pending = []
          let out: string
          try {
            const parsed = JSON.parse(json) as { response?: unknown }
            out = JSON.stringify(parsed.response ?? parsed)
          } catch {
            out = json
          }
          controller.enqueue(encoder.encode(`data: ${out}\n\n`))
        }
      },
    }),
  )
}

function geminiFetch(getAuth: () => Promise<Auth>) {
  return async function fetchWithCodeAssist(input: RequestInfo | URL, init?: RequestInit) {
    const auth = await getAuth()
    const stored = geminiToken(auth)
    if (!stored) return fetch(input, init)
    let access = stored.access
    if (stored.refresh && stored.expires !== undefined && stored.expires < Date.now()) {
      const refreshed = await refreshGeminiToken(stored.refresh)
      access = refreshed.access
    }
    let model = "gemini-3.6-flash"
    try {
      const modelMatch = String(input).match(/models\/([^/:?]+)/)
      if (modelMatch) model = modelMatch[1]
    } catch {
      // Keep the default model id.
    }
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const payload = {
      model,
      project: "",
      user_prompt_id: crypto.randomUUID(),
      request: { ...body, session_id: "" },
    }
    const headers = new Headers(init?.headers)
    headers.delete("x-goog-api-key")
    headers.delete("authorization")
    headers.set("authorization", `Bearer ${access}`)
    headers.set("content-type", "application/json")
    const res = await fetch(GEMINI_CODE_ASSIST_URL, {
      ...init,
      headers,
      body: JSON.stringify(payload),
    })
    if (!res.ok || !res.body) return res
    const headersOut = new Headers(res.headers)
    headersOut.set("content-type", "text/event-stream")
    return new Response(unwrapGeminiSSE(res.body), { status: res.status, headers: headersOut })
  }
}

function authHook(spec: Spec): Hooks["auth"] {
  return {
    provider: spec.id,
    methods: [
      {
        type: "api",
        label: "Paste token",
        prompts: [
          {
            type: "text",
            key: "token",
            message: spec.prompt,
            placeholder: spec.auth === "gemini-code-assist" ? '{"access":...,"refresh":...}' : "token",
          },
        ],
        authorize: async (inputs) => {
          const token = inputs?.token?.trim()
          return token ? { type: "success" as const, key: token } : { type: "failed" as const }
        },
      },
    ],
    ...(spec.auth === "api-key"
      ? {}
      : {
          loader: async (getAuth) => ({
            apiKey: OAUTH_DUMMY_KEY,
            fetch:
              spec.auth === "gemini-code-assist"
                ? geminiFetch(getAuth)
                : bearerFetch(getAuth, spec.headers),
          }),
        }),
  }
}

function subscriptionPlugin(spec: Spec): Plugin {
  return async function () {
    return {
      config: async (input) => {
        input.provider = { ...(input.provider ?? {}), [spec.id]: providerConfig(spec) }
      },
      auth: authHook(spec),
    }
  }
}

export const KimiCodeAuthPlugin = subscriptionPlugin(SPECS.find((spec) => spec.id === "kimi-code")!)
export const KimiSubAuthPlugin = subscriptionPlugin(SPECS.find((spec) => spec.id === "kimi-sub")!)
export const ClaudeSubAuthPlugin = subscriptionPlugin(SPECS.find((spec) => spec.id === "claude-sub")!)
export const GrokSubAuthPlugin = subscriptionPlugin(SPECS.find((spec) => spec.id === "grok-sub")!)
export const GeminiSubAuthPlugin = subscriptionPlugin(SPECS.find((spec) => spec.id === "gemini-sub")!)
