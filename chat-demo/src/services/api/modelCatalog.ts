import { providerPresets } from './providerPresets.js'

/** Token counts reported for this exact, case-sensitive provider/model pair. */
export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly inputLimit?: number
  readonly outputLimit?: number
  readonly source: string
  readonly sourceUrl: string
  /** False when the provider only exposes this model using a different chat protocol. */
  readonly supportsChatCompletions?: boolean
  /** Local library entries are references; the running server sets its own limits. */
  readonly scope: 'provider' | 'local-reference'
}

type PackedRow = [
  string,
  string | null,
  number | null,
  number | null,
  number | null,
  number,
  boolean?,
]
interface PackedCatalog {
  sources: [string, string][]
  rows: PackedRow[]
}
const providers = new Set(providerPresets.map((p) => p.value))
const indices = new Map<string, ReadonlyMap<string, CatalogModel>>()
const loads = new Map<string, Promise<readonly CatalogModel[]>>()
const empty: readonly CatalogModel[] = Object.freeze([])

/** Loads only the selected provider's bundled JSON chunk; concurrent callers share it. */
export function loadCatalogModels(providerId: string): Promise<readonly CatalogModel[]> {
  if (!providers.has(providerId)) {
    return Promise.resolve(empty)
  }
  const existing = loads.get(providerId)
  if (existing) {
    return existing
  }
  const pending = import(
    /* webpackChunkName: "model-catalog-[request]" */ `./catalog-data/${providerId}.json`,
    { with: { type: 'json' } }
  )
    .then(({ default: catalog }: { default: PackedCatalog }) => {
      const index = new Map<string, CatalogModel>()
      const scope =
        providerId === 'lmstudio' || providerId === 'ollama' ? 'local-reference' : 'provider'
      for (const [
        id,
        name,
        context,
        input,
        output,
        sourceIndex,
        supportsChatCompletions,
      ] of catalog.rows) {
        const [source, sourceUrl] = catalog.sources[sourceIndex]
        index.set(
          id,
          Object.freeze({
            id,
            name: name ?? id,
            contextWindow: context ?? undefined,
            inputLimit: input ?? undefined,
            outputLimit: output ?? undefined,
            source,
            sourceUrl,
            scope,
            supportsChatCompletions,
          })
        )
      }
      indices.set(providerId, index)
      return Object.freeze(Array.from(index.values()))
    })
    .catch((error: unknown) => {
      loads.delete(providerId) // A transient asset-load error can be retried.
      throw error
    })
  loads.set(providerId, pending)
  return pending
}

/** Synchronous lookup after awaiting loadCatalogModels(providerId). No alias or vendor inference. */
export function resolveCatalogModel(providerId: string, exactId: string): CatalogModel | undefined {
  return indices.get(providerId)?.get(exactId)
}
