import { createHash, createHmac } from 'node:crypto'

export const sha256Hex = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')

export function callbackToken(secret: string, aiJobId: string): string {
  if (secret.length < 32)
    throw new Error('AI_CALLBACK_TOKEN_SECRET must contain at least 32 characters')
  return createHmac('sha256', secret)
    .update(`volleyball-ai-callback:${aiJobId}`)
    .digest('base64url')
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
