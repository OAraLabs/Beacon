// The pages the setup screens send people to (0.3.1, B11). Every one opens in the OS browser: a
// plain `<a target="_blank">` in the shell reaches main's setWindowOpenHandler, which passes only
// what safeExternalUrl accepts (http/https) to shell.openExternal. smoke:setup-links pins both
// halves: each URL here is one safeExternalUrl accepts, and each is used as such a link.
//
// No Node/Electron imports (same rule as the rest of src/shared).

export const SETUP_LINKS = {
  /** The public setup guide: how to install Prometheus, pair, and what the messages mean. */
  guide: 'https://github.com/OAraLabs/Beacon/blob/main/docs/SETUP.md',
  /** Apple's page on updating macOS, for a Mac too old to run Prometheus. */
  macUpdate: 'https://support.apple.com/en-us/108382',
  /** Beacon's page on the OAra website: what it does, and the download, for someone just looking. */
  website: 'https://oara.ai/beacon',
  /** Telegram's bot for creating bots (/newbot). */
  botfather: 'https://t.me/BotFather',
  /** Where a Slack app (Socket Mode) is created. */
  slackApps: 'https://api.slack.com/apps',
  /** O9's pasted keys: where each company makes a key, and where its account takes a payment method. */
  anthropicKeys: 'https://console.anthropic.com/settings/keys',
  anthropicBilling: 'https://console.anthropic.com/settings/billing',
  openaiKeys: 'https://platform.openai.com/api-keys',
  openaiBilling: 'https://platform.openai.com/settings/organization/billing/overview',
  /** Where an OpenRouter account buys credit (O9). */
  openrouterCredits: 'https://openrouter.ai/settings/credits',
  /** Where a Discord application and its bot are created. */
  discordApps: 'https://discord.com/developers/applications'
} as const

export type SetupLinkKey = keyof typeof SETUP_LINKS
