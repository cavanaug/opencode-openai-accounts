import { Credential, Model, Plugin, Provider } from "@opencode/plugin"
import type { ModelHooks } from "@opencode/plugin/promise/registration"
import type { SessionHooks, SessionModelRequest, SessionRequest } from "@opencode/plugin/promise/session"

const codexBaseURL = "https://chatgpt.com/backend-api/codex"
const tokenBaseURL = "https://api.openai.com/v1"
// OpenCode bundles this entrypoint, so the host builds every account model with its own AI runtime.
const responsesPackage = "@opencode/ai/providers/openai/responses"

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
  session: {
    hook: ModelHooks<Pick<SessionHooks, "context" | "compaction" | "generate" | "title" | "model.request">>
  }
  event: {
    subscribe(options?: { signal?: AbortSignal }): ReturnType<Plugin.Context["event"]["subscribe"]>
  }
}

type SavedConnection = Extract<Parameters<Plugin.Context["integration"]["connection"]["resolve"]>[0], { type: "credential" }>

type Account = {
  connection: SavedConnection
  kind: "codex" | "token"
  baseURL: string
  providerID: Provider.ID
}

function isTokenSharing(value: Credential.Value | undefined): boolean {
  return value?.type === "oauth" && value.methodID === "chatgpt-token-sharing"
}

function isChatGPT(value: Credential.Value | undefined): value is Credential.OAuth {
  return value?.type === "oauth" &&
    ["chatgpt-browser", "chatgpt-headless", "chatgpt-token-sharing"].includes(value.methodID)
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

/** A credential only ever reaches the endpoint it was saved for. */
function permitted(endpoint: string, baseURL: string) {
  const target = new URL(baseURL)
  const origin = new URL(endpoint)
  const path = (url: URL) => url.pathname.replace(/\/+$/, "")
  return target.origin === origin.origin &&
    path(target) === path(origin) &&
    !target.username &&
    !target.password
}

/** Register one provider per saved ChatGPT account and follow account changes. */
export async function setup(context: Context) {
  let accounts = new Map<string, Account>()
  let byProvider = new Map<string, Account>()
  let accountProviders = new Set<string>()
  const pending = new Map<string, Promise<Credential.Value | undefined>>()
  const controller = new AbortController()

  function resolveCredential(connection: SavedConnection) {
    const current = pending.get(connection.id)
    if (current) return current
    const request = context.integration.connection.resolve(connection).finally(() => pending.delete(connection.id))
    pending.set(connection.id, request)
    return request
  }

  async function synchronize() {
    const { data } = await context.integration.get({ integrationID: "openai" })
    const next = new Map<string, Omit<Account, "providerID">>()
    for (const connection of data.connections) {
      if (connection.type !== "credential") continue
      let credential: Credential.Value | undefined
      try {
        credential = await resolveCredential(connection)
      } catch {
        console.warn(`OpenAI account ${connection.label} could not be resolved; reconnect it through /connect.`)
        continue
      }
      if (!isChatGPT(credential)) continue
      const kind: Account["kind"] = isTokenSharing(credential) ? "token" : "codex"
      next.set(connection.id, {
        connection,
        kind,
        baseURL: kind === "token" ? tokenBaseURL : codexBaseURL,
      })
    }
    const ids = providerIDs([...next.values()].map((account) => account.connection))
    accounts = new Map([...next].map(([id, account]) => [id, { ...account, providerID: ids.get(id)! }]))
    byProvider = new Map([...accounts.values()].map((account) => [account.providerID, account]))
    accountProviders = new Set(ids.values())
  }

  /**
   * Account requests carry a credential the host never sees, so the model asks for none (`apiKey: false`)
   * and this hook supplies the per-account one. Hooks are the plugin API, which OpenCode keeps stable.
   */
  const authorize = async (event: SessionModelRequest) => {
    const account = byProvider.get(event.model.providerID)
    if (!account) return
    if (event.baseURL !== undefined && !permitted(account.baseURL, event.baseURL))
      throw new Error("Refusing to send a ChatGPT credential to a different endpoint.")

    let credential: Credential.Value | undefined
    try {
      credential = await resolveCredential(account.connection)
    } catch {
      throw new Error("Could not refresh the selected OpenAI account. Reconnect it through /connect.")
    }
    if (!isChatGPT(credential) || !credential.access || credential.expires <= Date.now())
      throw new Error("The selected ChatGPT account is unavailable. Reconnect it through /connect.")

    const headers = event.headers
    for (const name of ["authorization", "api-key", "x-api-key", "cookie", "openai-organization", "openai-project", "chatgpt-account-id"]) {
      for (const key of Object.keys(headers))
        if (key.toLowerCase() === name) delete headers[key]
    }
    const session = headers["x-session-affinity"] ?? event.sessionID
    headers.authorization = `Bearer ${credential.access}`
    if (account.kind === "token") {
      headers["session-id"] = session
      headers["thread-id"] = session
      headers["x-client-request-id"] = session
      return
    }
    const accountID = credential.metadata?.accountID
    if (typeof accountID !== "string" || !accountID)
      throw new Error("The selected ChatGPT credential has no account ID. Reconnect it through /connect.")
    headers["chatgpt-account-id"] = accountID
    headers.originator = "opencode"
    headers["x-codex-beta-features"] = "remote_compaction_v2"
    headers["session-id"] = session
  }

  await synchronize()
  const registration = await context.provider.transform((editor) => {
    const source = editor.get("openai")
    if (!source) return
    for (const { connection, kind, baseURL, providerID: id } of accounts.values()) {
      const filter = kind === "token" ? isTokenSharingModel : isChatGPTModel
      // The source settings already carry the active account's transport and compaction, so the
      // account-specific ones are replaced instead of inherited.
      const settings: Record<string, unknown> = {
        ...source.provider.settings,
        // The credential arrives per request through the model.request hook.
        apiKey: false,
        transport: kind === "token" ? "http" : "websocket",
        baseURL,
        encoding: source.provider.settings?.encoding ?? "zstd",
      }
      if (kind === "token") settings.compaction = { type: "summary" }
      else delete settings.compaction
      editor.add({
        info: {
          ...Provider.Info.empty(id),
          name: connection.label,
          canonical: Provider.ID.make("openai"),
          activation: "enabled",
          // The host's own entrypoint, so request defaults and protocols always match the running OpenCode.
          package: source.provider.package || responsesPackage,
          settings,
        },
        models: [...source.models.values()].filter(filter).map((item) => ({
          ...item,
          name: `${connection.label} - ${item.name}`,
          providerID: id,
          canonical: Provider.ID.make("openai"),
          settings: {
            ...item.settings,
            baseURL,
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
    context.session.hook("model.request", authorize),
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
  }
}

export default Plugin.define({ id: "openai-accounts", setup })
