/** Shared Pi / OMP native extension. No runtime imports or ambient home changes. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface ForeignExtensionConfig {
  url: string
  token: string
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function createForeignExtension(config: ForeignExtensionConfig): (api: ExtensionAPI) => void {
  return (api) => {
    api.registerTool({
      name: config.name,
      label: 'Super D Hub',
      description: config.description,
      promptSnippet: 'Use the Super D Hub for agent messaging, runtime status, and remote execution.',
      parameters: config.parameters as Parameters<ExtensionAPI['registerTool']>[0]['parameters'],
      async execute(_callId, args, signal) {
        const response = await fetch(config.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(args),
          ...(signal === undefined ? {} : { signal }),
        }).catch((error: unknown) => {
          if (signal?.aborted) throw error
          throw new Error('[E_HUB_UNAVAILABLE] Super D Hub connection is unavailable. Restart Super D, then resume this conversation to renew its session binding.')
        })
        const body = await response.json() as { result?: unknown; error?: string }
        if (!response.ok) throw new Error(body.error ?? `Super D Hub returned HTTP ${response.status}`)
        return { content: [{ type: 'text', text: JSON.stringify(body.result) }], details: body.result }
      },
    })
  }
}
