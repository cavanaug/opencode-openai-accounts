import { AIError, AuthenticationError, LanguageModel } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { Auth } from "@opencode/ai/route"
import { Credential, Model, Plugin, Provider } from "@opencode/plugin"
import type { ModelHooks } from "@opencode/plugin/promise/registration"
import type { SessionHooks, SessionRequest } from "@opencode/plugin/promise/session"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { readFileSync } from "node:fs"

const codexBaseURL = "https://chatgpt.com/backend-api/codex"
const tokenBaseURL = "https://api.openai.com/v1"

/** The OpenCode release this plugin's @opencode/* dependencies were installed for. */
const targetOpenCode = (() => {
  try {
    const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"))
    const version = manifest?.dependencies?.["@opencode/ai"]
    return typeof version === "string" ? version : undefined
  } catch {
    return undefined
  }
})()

type RequestDefaults = { providerOptions?: Record<string, unknown> }

/**
 * Request defaults moved from `route.defaults` to `model.options` in OpenCode 2.2.7. A model built
 * against a different @opencode/ai than the running OpenCode silently loses them, and the ChatGPT
 * backend then rejects every request with "Store must be set to false".
 */
function requestDefaults(model: { options?: RequestDefaults; route?: unknown }): RequestDefaults | undefined {
  const current = model.options
  if (current?.providerOptions) return current
  return (model.route as { defaults?: RequestDefaults } | undefined)?.defaults
}

// Mirrors OpenCode 2.2.7's token-sharing fallback inventory.
const tokenSharingModels = new Set([
  "gpt-5.5",
  "gpt-5.5-fast",
  "gpt-5.6-luna",
  "gpt-5.6-luna-fast",
  "gpt-5.6-sol",
  "gpt-5.6-sol-fast",
  "gpt-5.6-terra",
  "gpt-5.6-terra-fast",
  "gpt-6-astra",
  "gpt-6-astra-fast",
  "gpt-6-luna",
  "gpt-6-luna-fast",
  "gpt-6-sol",
  "gpt-6-sol-fast",
  "gpt-6.1-sol",
  "gpt-6.1-sol-fast",
  "gpt-6.1-terra",
  "gpt-6.1-terra-fast",
])

type Context = {
  app: Plugin.Context["app"]
  integration: Pick<Plugin.Context["integration"], "get"> & {
    connection: Pick<Plugin.Context["integration"]["connection"], "active" | "resolve">
  }
  provider: Pick<Plugin.Context["provider"], "transform" | "reload">
  model: {
    transform(callback: (editor: {
      list(providerID?: string): readonly Model.Info[]
      remove(providerID: string, modelID: string): void
    }) => void): Promise<{ dispose(): Promise<void> }>
  }
  session: { hook: ModelHooks<Pick<SessionHooks, "context" | "compaction" | "generate" | "title">> }
  event: {
    subscribe(options?: { signal?: AbortSignal }): ReturnType<Plugin.Context["event"]["subscribe"]>
  }
}

type SavedConnection = Extract<Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0], { type: "credential" }>

type Binding = {
  resolve: () => Promise<Credential.Value | undefined>
  version: string
  kind: "codex" | "token"
  baseURL: string
}

type Runtime = {
  bindings: Map<string, Binding>
  pending: WeakMap<Context["app"], Map<string, Promise<Credential.Value | undefined>>>
}

declare global {
  var openCodeOpenAIAccountRuntime: Runtime | undefined
}

// OpenCode caches native provider modules separately from hot-reloaded plugin modules.
const runtime: Runtime = globalThis.openCodeOpenAIAccountRuntime ??= {
  bindings: new Map(),
  pending: new WeakMap(),
}

function resolveCredential(context: Context, connection: SavedConnection) {
  let pending = runtime.pending.get(context.app)
  if (!pending) {
    pending = new Map()
    runtime.pending.set(context.app, pending)
  }
  const current = pending.get(connection.id)
  if (current) return current
  const requests = pending
  const request = context.integration.connection.resolve(connection).finally(() => requests.delete(connection.id))
  requests.set(connection.id, request)
  return request
}

function isTokenSharing(value: Credential.Value | undefined): boolean {
  return value?.type === "oauth" && value.methodID === "chatgpt-token-sharing"
}

function isChatGPT(value: Credential.Value | undefined): value is Credential.OAuth {
  return value?.type === "oauth" &&
    ["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"].includes(value.methodID)
}

function authenticationError(message: string) {
  return new AIError({ reason: new AuthenticationError({ message }) })
}

/** OpenCode native provider entrypoint. Credentials are resolved at request time. */
export function model(modelID: string, settings: OpenAI.Settings) {
  const { openAIAccountBinding, ...options } = settings
  const initial = typeof openAIAccountBinding === "string" ? runtime.bindings.get(openAIAccountBinding) : undefined
  if (!initial) {
    throw new Error("OpenAI account binding is unavailable. Reload the plugin and select the account again.")
  }

  // The ChatGPT backend rejects any request without `store: false`, and the value is easy to lose to a
  // host version change, so ask for it explicitly and verify the model actually carries it.
  const native = OpenAI.model(modelID, { ...options, baseURL: initial.baseURL, store: false })
  if (requestDefaults(native)?.providerOptions?.store !== false) {
    throw new Error(
      `OpenCode did not apply the OpenAI request defaults to ${modelID}. This plugin targets OpenCode ` +
        `${targetOpenCode ?? "unknown"}; update its @opencode/* dependencies to match the running OpenCode.`,
    )
  }
  const auth = Auth.custom((input) => Effect.gen(function* () {
    const binding = typeof openAIAccountBinding === "string" ? runtime.bindings.get(openAIAccountBinding) : undefined
    if (!binding) {
      return yield* Effect.fail(authenticationError("OpenAI account binding was removed. Select a connected account."))
    }
    const destination = new URL(input.url)
    const endpoint = new URL(binding.baseURL)
    if (destination.origin !== endpoint.origin ||
      !destination.pathname.startsWith(`${endpoint.pathname}/`) || destination.username || destination.password) {
      return yield* Effect.fail(authenticationError("Refusing to send a ChatGPT credential to a different endpoint."))
    }

    const credential = yield* Effect.tryPromise({
      try: () => binding.resolve(),
      catch: () => authenticationError("Could not refresh the selected OpenAI account. Reconnect it through /connect."),
    })
    if (!isChatGPT(credential) || !credential.access || credential.expires <= Date.now()) {
      return yield* Effect.fail(authenticationError("The selected ChatGPT account is unavailable. Reconnect it through /connect."))
    }

    let headers = input.headers
    for (const name of ["authorization", "api-key", "x-api-key", "cookie", "openai-organization", "openai-project", "chatgpt-account-id"]) {
      headers = Headers.remove(headers, name)
    }
    if (isTokenSharing(credential)) {
      return Headers.setAll(headers, {
        authorization: `Bearer ${credential.access}`,
        "user-agent": headers["user-agent"] ?? `opencode/${binding.version}`,
        ...(headers["x-session-id"] ? {
          "session-id": headers["x-session-id"],
          "thread-id": headers["x-session-id"],
          "x-client-request-id": headers["x-session-id"],
        } : {}),
      })
    }
    const accountID = credential.metadata?.accountID
    if (typeof accountID !== "string" || !accountID) {
      return yield* Effect.fail(authenticationError("The selected ChatGPT credential has no account ID. Reconnect it through /connect."))
    }

    return Headers.setAll(headers, {
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": accountID,
      originator: "opencode",
      "x-codex-beta-features": "remote_compaction_v2",
      "user-agent": headers["user-agent"] ?? `opencode/${binding.version}`,
      ...(headers["x-session-id"] ? { "session-id": headers["x-session-id"] } : {}),
    })
  }))
  return LanguageModel.update(native, { route: native.route.with({ auth }) })
}

function isPro(body: Readonly<Record<string, unknown>> | undefined) {
  const reasoning = body?.reasoning
  return typeof reasoning === "object" && reasoning !== null && "mode" in reasoning && reasoning.mode === "pro"
}

function isTokenSharingModel(model: Model.Info) {
  if (!model.enabled || isPro(model.body)) return false
  const id = model.modelID ?? model.id
  return tokenSharingModels.has(id)
}

function isChatGPTModel(model: Model.Info) {
  if (!model.enabled || isPro(model.body)) return false
  const id = model.modelID ?? model.id
  if (model.type === "image") return id === "gpt-image-2"
  if (id === "gpt-5.6") return false
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?/)
  const major = Number(match?.[1])
  return major > 5 || (major === 5 && Number(match?.[2] ?? 0) > 5)
}

function contextLimit(model: Model.Info) {
  const match = (model.modelID ?? model.id).match(/^gpt-(\d+)(?:\.(\d+))?/)
  const major = Number(match?.[1])
  const input = !match || major > 6 || (major === 6 && Number(match[2] ?? 0) >= 1) ? 500_000 : 272_000
  return (model.limit.input || model.limit.context) <= input
    ? model.limit
    : { ...model.limit, input, context: input + model.limit.output }
}

function labelSlug(label: string) {
  return label.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

// Label-based IDs let synced sessions and policies resolve the same account on every host.
// Slugs never contain "_", so they cannot collide with the credential-ID fallback.
function providerIDs(connections: readonly SavedConnection[]) {
  const counts = new Map<string, number>()
  for (const connection of connections) {
    const slug = labelSlug(connection.label)
    counts.set(slug, (counts.get(slug) ?? 0) + 1)
  }
  return new Map(connections.map((connection) => {
    const slug = labelSlug(connection.label)
    const suffix = slug && counts.get(slug) === 1 ? slug : connection.id
    return [connection.id, Provider.ID.make(`openai-${suffix}`)]
  }))
}

/** Register one provider per saved ChatGPT account and follow account changes. */
export async function setup(context: Context) {
  // Patch releases have moved the provider APIs this plugin builds on, so a mismatch is worth saying out loud.
  if (targetOpenCode && /^\d+\.\d+\.\d+$/.test(targetOpenCode) && targetOpenCode !== context.app.version)
    console.warn(
      `opencode-openai-accounts targets OpenCode ${targetOpenCode} but OpenCode ${context.app.version} is running. ` +
        `Update the plugin's @opencode/* dependencies to match.`,
    )

  type Account = { connection: SavedConnection; bindingID: string; kind: Binding["kind"]; baseURL: string; providerID: Provider.ID }
  let accounts = new Map<string, Account>()
  let accountProviders = new Set<string>()
  const controller = new AbortController()
  const entrypoint = new URL(import.meta.url)
  entrypoint.searchParams.set("account-runtime", crypto.randomUUID())

  async function synchronize() {
    const { data } = await context.integration.get({ integrationID: "openai" })
    const next = new Map<string, Omit<Account, "providerID">>()
    for (const connection of data.connections) {
      if (connection.type !== "credential") continue
      let credential: Credential.Value | undefined
      try {
        credential = await resolveCredential(context, connection)
      } catch {
        console.warn(`OpenAI account ${connection.label} could not be resolved; reconnect it through /connect.`)
        continue
      }
      if (!isChatGPT(credential)) continue
      const kind: Binding["kind"] = isTokenSharing(credential) ? "token" : "codex"
      const baseURL = kind === "token" ? tokenBaseURL : codexBaseURL
      const bindingID = accounts.get(connection.id)?.bindingID ?? crypto.randomUUID()
      runtime.bindings.set(bindingID, {
        resolve: () => resolveCredential(context, connection),
        version: context.app.version,
        kind,
        baseURL,
      })
      next.set(connection.id, { connection, bindingID, kind, baseURL })
    }
    for (const [id, account] of accounts) {
      if (!next.has(id)) runtime.bindings.delete(account.bindingID)
    }
    const ids = providerIDs([...next.values()].map((account) => account.connection))
    accounts = new Map([...next].map(([id, account]) => [id, { ...account, providerID: ids.get(id)! }]))
    accountProviders = new Set(ids.values())
  }

  await synchronize()
  const registration = await context.provider.transform((editor) => {
    const source = editor.get("openai")
    if (!source) return
    for (const { connection, bindingID, kind, baseURL, providerID: id } of accounts.values()) {
      const filter = kind === "token" ? isTokenSharingModel : isChatGPTModel
      editor.add({
        info: {
          ...Provider.Info.empty(id),
          name: connection.label,
          canonical: Provider.ID.make("openai"),
          activation: "enabled",
          package: entrypoint.href,
          settings: {
            ...source.provider.settings,
            transport: kind === "token" ? "http" : (source.provider.settings?.transport ?? "websocket"),
            baseURL,
            encoding: source.provider.settings?.encoding ?? "zstd",
            ...(kind === "token" ? { compaction: { type: "summary" } } : {}),
            openAIAccountBinding: bindingID,
          },
        },
        models: [...source.models.values()].filter(filter).map((item) => ({
          ...item,
          name: `${connection.label} - ${item.name}`,
          providerID: id,
          canonical: Provider.ID.make("openai"),
          package: entrypoint.href,
          settings: {
            ...item.settings,
            baseURL,
            openAIAccountBinding: bindingID,
            ...(kind === "token" ? { compaction: { type: "summary" } } : {}),
          },
          compatibility: { ...item.compatibility, ...(kind === "token" ? { supportsEffortUpdates: false } : {}) },
          cost: [],
          limit: contextLimit(item),
          variants: item.variants?.filter((variant) => !isPro(variant.body)),
        })),
      })
    }
  })

  const modelRegistration = await context.model.transform((editor) => {
    const hasAccountModels = editor.list().some((item) => item.enabled && accountProviders.has(item.providerID))
    if (!hasAccountModels) return
    for (const item of editor.list("openai")) editor.remove(item.providerID, item.id)
  })

  const omitOutputLimit = (event: SessionRequest) => {
    if (accountProviders.has(event.model.providerID)) {
      delete event.options.maxTokens
    }
  }
  const hooks = await Promise.all([
    context.session.hook("context", omitOutputLimit),
    context.session.hook("compaction", omitOutputLimit),
    context.session.hook("generate", omitOutputLimit),
    context.session.hook("title", omitOutputLimit),
  ])

  const watching = (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      if (event.type !== "credential.updated" && event.type !== "credential.switched") continue
      await synchronize()
      await context.provider.reload()
    }
  })().catch(() => {
    if (!controller.signal.aborted) console.error("OpenAI account monitoring stopped. Reload the plugin to refresh the account list.")
  })

  return async () => {
    controller.abort()
    await watching
    await modelRegistration.dispose()
    await registration.dispose()
    await Promise.all(hooks.map((hook) => hook.dispose()))
    for (const account of accounts.values()) runtime.bindings.delete(account.bindingID)
  }
}

export default Plugin.define({ id: "openai-accounts", setup })
