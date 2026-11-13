# OpenCode OpenAI Accounts

An OpenCode V2 plugin that lists saved ChatGPT accounts by their labels:

```text
Elva - GPT-6.1 Sol
Elva - GPT-6.1 Sol Fast
Stampen - GPT-6.1 Sol
Stampen - GPT-6.1 Sol Fast
```

Choose the account and model together. Sessions can use different accounts concurrently without changing OpenCode's active account. The plugin adds no commands, tools, or UI extensions.

## Install

Targets OpenCode **2.2.7**. Save and name accounts through `/connect`, using **Sign in with ChatGPT** or a legacy Codex login. API-key and environment connections are excluded.

Install the checkout's dependencies and add its directory to `~/.config/opencode/opencode.jsonc`:

```sh
npm ci
```

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-openai-accounts"]
}
```

Preserve other plugin entries. Configure the directory, not `index.ts`, and do not also load an installed copy. OpenCode reloads configuration automatically; `/reload` forces a refresh. No `cli.json` entry is needed.

## Behavior

- Model names are exactly `<account label> - <model name>`; provider headings use only the account label.
- Provider IDs follow account labels: `openai-<label slug>`, e.g. `openai-work` for an account labeled `Work`. The slug is lowercase, with runs of other characters collapsed to `-`. Saving the same label on every host gives the same provider ID, so synced sessions and `provider.use` policies resolve on each host even though separate sign-ins have different credential IDs.
- Renaming an account changes its provider ID; sessions bound to the old ID must select the account again. A blank label, or labels that produce the same slug, fall back to `openai-<credentialID>`, which never collides with a label slug.
- Credentials stay in OpenCode. Each request resolves its bound credential, including OAuth refresh; concurrent resolutions for the same account are shared.
- Missing or unusable credentials fail closed, without falling back to another account or an environment API key.
- OpenCode's native OpenAI runtime handles requests. The small adapter supplies account-specific authentication and restricts credentials to their intended endpoint.
- Current ChatGPT sign-ins use `https://api.openai.com/v1`, HTTP transport, summary compaction, and the OpenCode 2.2.7 token-sharing fallback inventory, including GPT-6.1 Terra.
- Legacy Codex sign-ins use `https://chatgpt.com/backend-api/codex`, account headers, GPT models newer than 5.5 except `gpt-5.6`, and `gpt-image-2` when present in the source catalog.
- Subscription entries have no token cost, exclude pro reasoning variants, and default to compressed requests. Input caps match OpenCode 2.2.7: 500,000 for GPT-6.1 and newer, 272,000 for older models, without increasing smaller catalog limits.
- Account requests omit explicit output-token overrides for prompts, compaction, transient generation, and titles.
- Account changes refresh the catalog. Generic OpenAI models are hidden while at least one named account has available models; the underlying integration and logins remain intact. If no account models remain, the generic models return.
- Existing sessions selected on `openai/...` must switch to a named account entry. Hiding is a model-catalog transform, not a UI patch or a change to authentication.

Models and reasoning variants come from OpenCode's OpenAI source catalog. Eligibility follows the targeted OpenCode release, not a per-account entitlement lookup. Review these policies when updating OpenCode dependencies.

## Development

```sh
npm run check
npm test
```

Existing tests cover labels and renames, concurrent account isolation, refreshed credentials, failure behavior, endpoint restrictions, output-limit omission, and cleanup without real credentials.

References: [plugin API](https://opencode.ai/v2/docs/build/plugins/server), [ChatGPT policy](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/plugin/provider/chatgpt.ts), [Codex policy](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/plugin/provider/openai.ts), [context caps](https://github.com/anomalyco/opencode/blob/v2.2.7/packages/core/src/plugin/provider/openai-context-caps.ts).
