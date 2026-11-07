import assert from "node:assert/strict"
import { test } from "node:test"
import { Credential, Integration, Model, Provider } from "@opencode/plugin"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import { Effect } from "effect"
import { Headers } from "effect/http"
import { model, setup } from "./index.ts"

type Context = Parameters<typeof setup>[0]
type Event = ReturnType<Context["event"]["subscribe"]> extends AsyncIterable<infer Item> ? Item : never

function credential(accountID: string, access = `${accountID}-token`) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-browser"),
    access,
    refresh: `${accountID}-refresh`,
    expires: Date.now() + 3_600_000,
    metadata: { accountID },
  })
}

function tokenCredential(accountID: string, access = `${accountID}-token`) {
  return Credential.OAuth.make({
    type: "oauth",
    methodID: Integration.MethodID.make("chatgpt-token-sharing"),
    access,
    refresh: `${accountID}-refresh`,
    expires: Date.now() + 3_600_000,
    metadata: { clientID: "test-client", scopes: ["openid", "chatgpt.tokens.use.direct"] },
  })
}

function environment() {
  const providerID = Provider.ID.make("openai")
  const source: ProviderRecord & { models: Map<string, Model.Info> } = {
    provider: { ...Provider.Info.empty(providerID), settings: { transport: "websocket" } },
    models: new Map(["gpt-6-astra", "gpt-5.4", "gpt-5.5-pro", "gpt-5.6"].map((id) => [id, {
      ...Model.Info.default(providerID, Model.ID.make(id)),
      name: id === "gpt-6-astra" ? "GPT-6 Astra" : id,
      variants: [{ id: Model.VariantID.make("high"), settings: { reasoningEffort: "high" } }],
    }])),
  }
  const providers = new Map<string, ProviderRecord>()
  const credentials = new Map<string, Credential.Value>([
    ["cred_personal", credential("personal")],
    ["cred_stampen", credential("stampen")],
    ["cred_key", Credential.Key.make({ type: "key", key: "api-key" })],
  ])
  const calls: string[] = []
  const hooks = new Map<string, (event: SessionContext) => Promise<void> | void>()
  const resolution: { error?: Error } = {}
  const labels = new Map([...credentials.keys()].map((id) => [id, id.slice(5)]))
  let eventController: ReadableStreamDefaultController<Event> | undefined
  const events = new ReadableStream<Event>({ start(controller) { eventController = controller } })
  let transform: ((editor: ProviderEditor) => void) | undefined
  let modelTransform: Parameters<Context["model"]["transform"]>[0] | undefined
  let notification = Promise.withResolvers<void>()
  const unexpected = () => { throw new Error("Unexpected registry operation") }
  const editor: ProviderEditor = {
    get: (id) => id === "openai" ? source : providers.get(id),
    list: () => [source, ...providers.values()],
    add: ({ info, models }) => providers.set(info.id, {
      provider: info,
      models: new Map(models.map((item) => [item.id, item])),
    }),
    update: unexpected,
    remove: (id) => { providers.delete(id) },
    models: { set: unexpected, update: unexpected, remove: unexpected },
  }
  const context: Context = {
    app: { name: "opencode", version: "2.2.5", channel: "release" },
    integration: {
      get: async () => ({
        location: { directory: "/project" },
        data: {
          id: "openai",
          name: "OpenAI",
          methods: [],
          connections: [...credentials.keys()].map((id) => ({ type: "credential", method: credentials.get(id)?.type === "oauth" ? "oauth" : "key", id, label: labels.get(id) ?? id })),
        },
      }),
      connection: {
        active: async () => { throw new Error("Account-bound requests must not select the active account") },
        resolve: async (connection) => {
          if (resolution.error) throw resolution.error
          assert.equal(connection.type, "credential")
          if (connection.type !== "credential") throw new Error("Expected a saved credential")
          calls.push(connection.id)
          return credentials.get(connection.id)
        },
      },
    },
    provider: {
      transform: async (callback) => {
        transform = callback
        callback(editor)
        return { dispose: async () => { providers.clear() } }
      },
      reload: async () => {
        providers.clear()
        transform?.(editor)
        notification.resolve()
      },
    },
    model: {
      transform: async (callback) => {
        modelTransform = callback
        return { dispose: async () => { modelTransform = undefined } }
      },
    },
    session: {
      hook: async (name, callback) => {
        hooks.set(name, callback)
        return { dispose: async () => { hooks.delete(name) } }
      },
    },
    event: {
      subscribe(options) {
        options?.signal?.addEventListener("abort", () => eventController?.close(), { once: true })
        return events.values()
      },
    },
  }
  function selected(id: string) {
    const entry = providers.get(`openai-${id}`)
    assert.ok(entry)
    const selected = entry.models.get("gpt-6-astra")
    assert.ok(selected)
    return model(selected.id, { ...entry.provider.settings, ...selected.settings })
  }
  async function changed() {
    notification = Promise.withResolvers<void>()
    assert.ok(eventController)
    eventController.enqueue({ type: "credential.updated", id: "evt_changed", created: Date.now(), data: {} })
    await notification.promise
  }
  function availableModels() {
    const models = new Map([source, ...providers.values()].flatMap((entry) =>
      [...entry.models.values()].map((item): [string, Model.Info] => [`${item.providerID}/${item.id}`, item])))
    modelTransform?.({
      list: (providerID) => [...models.values()].filter((item) => !providerID || item.providerID === providerID),
      remove: (providerID, modelID) => { models.delete(`${providerID}/${modelID}`) },
    })
    return [...models.values()]
  }
  return { context, providers, credentials, calls, selected, resolution, labels, changed, hooks, source, availableModels }
}

function authorize(selected: ReturnType<typeof model>, url = "https://chatgpt.com/backend-api/codex/responses") {
  return Effect.runPromise(selected.route.auth.apply({
    request: {},
    method: "POST",
    url,
    body: "{}",
    headers: Headers.fromInput({
      Authorization: "Bearer wrong-account",
      "ChatGPT-Account-ID": "wrong-account",
      "OpenAI-Organization": "wrong-organization",
      "OpenAI-Project": "wrong-project",
      "X-Session-Id": "session-123",
    }),
  }))
}

test("saved ChatGPT accounts become separate providers with their model variants", async (t) => {
  const state = environment()
  const source = structuredClone(state.source)
  t.after(await setup(state.context))
  assert.deepEqual([...state.providers.keys()], ["openai-personal", "openai-stampen"])
  assert.deepEqual([...state.providers.values()].map((entry) => entry.provider.name), ["personal", "stampen"])
  for (const entry of state.providers.values()) {
    assert.deepEqual([...entry.models.keys()], ["gpt-6-astra"])
    const item = entry.models.get("gpt-6-astra")
    assert.ok(item)
    assert.equal(item.name, `${entry.provider.name} - GPT-6 Astra`)
    assert.equal(item.id, "gpt-6-astra")
    assert.equal(item.modelID, "gpt-6-astra")
    assert.equal(item.providerID, entry.provider.id)
    assert.equal(item.variants?.[0]?.id, "high")
  }
  assert.deepEqual(state.source, source)
  const catalog = JSON.stringify([...state.providers.values()].map((entry) => ({
    provider: entry.provider,
    models: [...entry.models.values()],
  })))
  assert.ok(!catalog.includes("personal-token"))
  assert.ok(!catalog.includes("stampen-token"))
})

test("provider IDs follow account labels so the same account matches across hosts", async (t) => {
  const state = environment()
  state.credentials.delete("cred_personal")
  state.credentials.set("cred_otherhost", credential("personal"))
  state.labels.set("cred_otherhost", "personal")
  state.labels.set("cred_stampen", "  Work Account! ")
  t.after(await setup(state.context))
  assert.deepEqual([...state.providers.keys()].sort(), ["openai-personal", "openai-work-account"])
  assert.equal(state.providers.get("openai-work-account")?.provider.name, "  Work Account! ")
  assert.equal(state.providers.get("openai-work-account")?.models.get("gpt-6-astra")?.providerID, "openai-work-account")
  assert.equal((await authorize(state.selected("personal"))).authorization, "Bearer personal-token")
})

test("blank or colliding labels fall back to credential-based provider IDs", async (t) => {
  const state = environment()
  state.labels.set("cred_personal", "Team")
  state.labels.set("cred_stampen", "team")
  state.credentials.set("cred_blank", credential("blank"))
  state.labels.set("cred_blank", " !! ")
  state.credentials.set("cred_lookalike", credential("lookalike"))
  state.labels.set("cred_lookalike", "cred_personal")
  t.after(await setup(state.context))
  assert.deepEqual([...state.providers.keys()].sort(), [
    "openai-cred-personal",
    "openai-cred_blank",
    "openai-cred_personal",
    "openai-cred_stampen",
  ])
  assert.equal((await authorize(state.selected("cred_personal"))).authorization, "Bearer personal-token")
  assert.equal((await authorize(state.selected("cred_stampen"))).authorization, "Bearer stampen-token")
})

test("generic OpenAI models are hidden only while named account models are available", async () => {
  const state = environment()
  const otherID = Provider.ID.make("other-provider")
  state.providers.set(otherID, {
    provider: Provider.Info.empty(otherID),
    models: new Map([["other-model", Model.Info.default(otherID, Model.ID.make("other-model"))]]),
  })
  const source = structuredClone(state.source)
  const cleanup = await setup(state.context)
  try {
    const visible = state.availableModels()
    assert.equal(visible.some((item) => item.providerID === "openai"), false)
    assert.equal(visible.some((item) => item.providerID === "openai-personal"), true)
    assert.equal(visible.some((item) => item.providerID === "openai-stampen"), true)
    assert.equal(visible.some((item) => item.providerID === otherID), true)
    assert.deepEqual(state.source, source)

    state.source.models.clear()
    await state.changed()
    for (const [id, item] of source.models) state.source.models.set(id, { ...item, enabled: false })
    assert.equal(state.availableModels().some((item) => item.providerID === "openai"), true)

    state.credentials.delete("cred_personal")
    state.credentials.delete("cred_stampen")
    for (const [id, item] of source.models) state.source.models.set(id, item)
    await state.changed()
    assert.deepEqual(state.availableModels(), [...source.models.values()])
  } finally {
    await cleanup()
  }
  assert.deepEqual(state.availableModels(), [...source.models.values()])
})

test("concurrent requests stay account-bound and reuse a pending credential resolution", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  const stampen = state.selected("stampen")
  state.calls.length = 0
  const [first, second, work] = await Promise.all([authorize(personal), authorize(personal), authorize(stampen)])
  assert.equal(first.authorization, "Bearer personal-token")
  assert.equal(second["chatgpt-account-id"], "personal")
  assert.equal(work.authorization, "Bearer stampen-token")
  assert.equal(work["chatgpt-account-id"], "stampen")
  assert.equal(work["session-id"], "session-123")
  assert.equal(work["openai-organization"], undefined)
  assert.equal(work["openai-project"], undefined)
  assert.equal(state.calls.filter((id) => id === "cred_personal").length, 1)

  state.credentials.set("cred_personal", credential("personal", "refreshed-token"))
  assert.equal((await authorize(personal)).authorization, "Bearer refreshed-token")
  assert.equal((await authorize(stampen)).authorization, "Bearer stampen-token")
})

test("missing, expired, and incomplete credentials fail without falling back to another account", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.credentials.delete("cred_personal")
  await assert.rejects(authorize(personal), /selected ChatGPT account is unavailable/)
  state.credentials.set("cred_personal", { ...credential("personal"), expires: 0 })
  await assert.rejects(authorize(personal), /selected ChatGPT account is unavailable/)
  state.credentials.set("cred_personal", { ...credential("personal"), metadata: {} })
  await assert.rejects(authorize(personal), /no account ID/)
  assert.equal((await authorize(state.selected("stampen"))).authorization, "Bearer stampen-token")
})

test("credential refresh failures do not expose credential material", async (t) => {
  const state = environment()
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.resolution.error = new Error("secret-refresh-token")
  await assert.rejects(authorize(personal), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /Could not refresh the selected OpenAI account/)
    assert.ok(!error.message.includes("secret-refresh-token"))
    return true
  })
})

test("account additions, renames, and removals update the catalog without rebinding sessions", { timeout: 2000 }, async (t) => {
  const state = environment()
  const source = structuredClone(state.source)
  t.after(await setup(state.context))
  const personal = state.selected("personal")
  state.labels.set("cred_personal", "Private")
  state.credentials.set("cred_additional", credential("additional"))
  await state.changed()
  assert.equal(state.providers.has("openai-personal"), false)
  assert.equal(state.providers.get("openai-private")?.provider.name, "Private")
  const renamed = state.providers.get("openai-private")?.models.get("gpt-6-astra")
  assert.ok(renamed)
  assert.equal(renamed.name, "Private - GPT-6 Astra")
  assert.equal(renamed.id, "gpt-6-astra")
  assert.equal(renamed.modelID, "gpt-6-astra")
  assert.equal(renamed.providerID, "openai-private")
  assert.equal(state.providers.get("openai-stampen")?.models.get("gpt-6-astra")?.name, "stampen - GPT-6 Astra")
  assert.deepEqual(state.source, source)
  assert.equal(state.providers.size, 3)
  assert.equal((await authorize(personal)).authorization, "Bearer personal-token")

  state.credentials.delete("cred_personal")
  await state.changed()
  assert.equal(state.providers.has("openai-private"), false)
  await assert.rejects(authorize(personal), /binding was removed/)
  assert.equal((await authorize(state.selected("stampen"))).authorization, "Bearer stampen-token")
})

test("credentials are withheld from other endpoints and unloaded bindings", async () => {
  const state = environment()
  const cleanup = await setup(state.context)
  const personal = state.selected("personal")
  try {
    state.calls.length = 0
    for (const url of ["https://example.com/responses", "https://chatgpt.com/other", "http://chatgpt.com/backend-api/codex/responses"]) {
      await assert.rejects(authorize(personal, url), /different endpoint/)
    }
    assert.equal(state.calls.length, 0)
  } finally {
    await cleanup()
  }
  await assert.rejects(authorize(personal), /binding was removed/)
})

test("all account request kinds omit output limits without changing other providers", async () => {
  const state = environment()
  const cleanup = await setup(state.context)
  try {
    assert.deepEqual([...state.hooks.keys()], ["context", "compaction", "generate", "title"])
    for (const hook of state.hooks.values()) {
      for (const providerID of ["openai-personal", "openai-stampen", "openai", "openai-unknown", "anthropic"]) {
        const event: SessionContext = {
          sessionID: Session.ID.make("session_output_limit"),
          agent: Agent.ID.make("build"),
          tools: {},
          model: { providerID: Provider.ID.make(providerID), id: Model.ID.make("gpt-6-astra") },
          system: [],
          messages: [],
          options: { maxTokens: 8192, reasoningEffort: "high" },
        }
        await hook(event)
        assert.equal(event.options.maxTokens, ["openai-personal", "openai-stampen"].includes(providerID) ? undefined : 8192)
        assert.equal(event.options.reasoningEffort, "high")
      }
    }
  } finally {
    await cleanup()
  }
  assert.equal(state.hooks.size, 0)
})

test("token-sharing accounts become providers without an account ID", async (t) => {
  const state = environment()
  state.credentials.set("cred_personal", tokenCredential("personal"))
  state.credentials.delete("cred_stampen")
  t.after(await setup(state.context))
  assert.deepEqual([...state.providers.values()].map((entry) => entry.provider.name), ["personal"])
  const entry = state.providers.get("openai-personal")
  assert.ok(entry)
  assert.equal(entry.provider.settings?.baseURL, "https://api.openai.com/v1")
  assert.equal(entry.provider.settings?.transport, "http")
  assert.deepEqual([...entry.models.keys()], ["gpt-6-astra"])

  const selected = entry.models.get("gpt-6-astra")
  assert.ok(selected)
  const token = model(selected.id, { ...entry.provider.settings, ...selected.settings })
  const headers = await authorize(token, "https://api.openai.com/v1/responses")
  assert.equal(headers.authorization, "Bearer personal-token")
  assert.equal(headers["chatgpt-account-id"], undefined)
  assert.equal(headers.originator, undefined)
  await assert.rejects(authorize(token), /different endpoint/)
  await assert.rejects(authorize(token, "https://chatgpt.com/backend-api/codex/responses"), /different endpoint/)
})

test("mixed codex and token-sharing accounts use their own endpoints", async (t) => {
  const state = environment()
  state.credentials.set("cred_personal", tokenCredential("personal"))
  t.after(await setup(state.context))
  assert.equal(state.providers.size, 2)
  const tokenEntry = state.providers.get("openai-personal")
  const codexEntry = state.providers.get("openai-stampen")
  assert.ok(tokenEntry)
  assert.ok(codexEntry)
  assert.equal(tokenEntry.provider.settings?.baseURL, "https://api.openai.com/v1")
  assert.equal(codexEntry.provider.settings?.baseURL, "https://chatgpt.com/backend-api/codex")

  const tokenModel = tokenEntry.models.get("gpt-6-astra")
  const codexModel = codexEntry.models.get("gpt-6-astra")
  assert.ok(tokenModel)
  assert.ok(codexModel)
  const token = model(tokenModel.id, { ...tokenEntry.provider.settings, ...tokenModel.settings })
  const codex = model(codexModel.id, { ...codexEntry.provider.settings, ...codexModel.settings })
  assert.equal((await authorize(token, "https://api.openai.com/v1/responses")).authorization, "Bearer personal-token")
  assert.equal((await authorize(codex)).authorization, "Bearer stampen-token")
  await assert.rejects(authorize(token), /different endpoint/)
  await assert.rejects(authorize(codex, "https://api.openai.com/v1/responses"), /different endpoint/)
})

test("OpenCode 2.2.5 model eligibility and context caps apply independently to each account", async (t) => {
  const state = environment()
  state.credentials.set("cred_personal", tokenCredential("personal"))
  for (const id of ["gpt-5.5", "gpt-5.3-codex-spark", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6.1-terra-fast", "gpt-6.1-pro", "gpt-image-2"]) {
    state.source.models.set(id, {
      ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make(id)),
      name: id,
      type: id === "gpt-image-2" ? "image" : "chat",
      body: id === "gpt-6.1-pro" ? { reasoning: { mode: "pro" } } : {},
      limit: { context: 1_000_000, output: 128_000 },
    })
  }
  t.after(await setup(state.context))
  const token = state.providers.get("openai-personal")
  const codex = state.providers.get("openai-stampen")
  assert.ok(token)
  assert.ok(codex)
  assert.equal(token.models.has("gpt-5.5"), true)
  assert.equal(codex.models.has("gpt-5.5"), false)
  assert.equal(codex.models.has("gpt-5.3-codex-spark"), false)
  assert.equal(token.models.has("gpt-image-2"), false)
  assert.equal(codex.models.has("gpt-image-2"), true)
  for (const entry of [token, codex]) {
    assert.equal(entry.models.has("gpt-6.1-pro"), false)
    assert.equal(entry.models.has("gpt-6.1-terra"), true)
    assert.equal(entry.models.has("gpt-6.1-terra-fast"), true)
    assert.deepEqual(entry.models.get("gpt-6.1-sol")?.limit, { input: 500_000, context: 628_000, output: 128_000 })
    assert.deepEqual(entry.models.get("gpt-6-astra")?.limit, state.source.models.get("gpt-6-astra")?.limit)
  }
  assert.deepEqual(token.models.get("gpt-5.5")?.limit, { input: 272_000, context: 400_000, output: 128_000 })
  assert.equal(token.models.get("gpt-6.1-sol")?.settings?.compaction?.type, "summary")
  assert.equal(token.models.get("gpt-6.1-sol")?.compatibility?.supportsEffortUpdates, false)
})
