type ProviderModel = { provider: string; model: string }

// Official aliases currently serve these exact releases (https://api-docs.deepseek.com/quick_start/pricing).
// OpenRouter lists both dated revisions and older same-family products as distinct deployments.
const releases: ReadonlyArray<Readonly<Record<string, readonly string[]>>> = [
  {
    deepseek: ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'],
    openrouter: ['deepseek/deepseek-v4.1-flash-1017'],
    opencode: ['deepseek-v4.1-flash'],
    qwen: ['deepseek-v4.1-flash-1017'],
    'qwen-intl': ['deepseek-v4.1-flash-1017'],
  },
  {
    deepseek: ['deepseek-v4-pro'],
    openrouter: ['deepseek/deepseek-v4-pro-0813'],
    qwen: ['deepseek-v4-pro-0813'],
    'qwen-intl': ['deepseek-v4-pro-0813'],
  },
]

/** A match must be offered by the target. Private, priced, dated and quantized IDs stay distinct. */
export function chooseEquivalentModel(
  from: ProviderModel,
  target: string,
  available: readonly string[]
) {
  if (available.includes(from.model)) {
    return from.model
  }
  const aliases = releases.find(
    (group) => Object.hasOwn(group, from.provider) && group[from.provider].includes(from.model)
  )
  if (!aliases || !Object.hasOwn(aliases, target)) {
    return undefined
  }
  return aliases[target].find((id) => available.includes(id))
}
