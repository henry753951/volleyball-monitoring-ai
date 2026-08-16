import { readonly, shallowRef, type DeepReadonly, type ShallowRef } from 'vue'

export type WorkstationFeedbackLevel = 'info' | 'success' | 'warning' | 'error'

export interface WorkstationFeedbackChange {
  code: string
  description: string
  entityId?: string
}

export interface WorkstationFeedbackMessage {
  id: string
  level: WorkstationFeedbackLevel
  title: string
  description?: string
  changes: WorkstationFeedbackChange[]
  createdAt: Date
}

export interface WorkstationFeedbackInput {
  level: WorkstationFeedbackLevel
  title: string
  description?: string
  changes?: WorkstationFeedbackChange[]
}

export interface WorkstationFeedbackService {
  messages: DeepReadonly<ShallowRef<WorkstationFeedbackMessage[]>>
  notify: (input: WorkstationFeedbackInput) => WorkstationFeedbackMessage
  clear: (messageId?: string) => void
  subscribe: (listener: (message: WorkstationFeedbackMessage) => void) => () => void
}

export function createWorkstationFeedbackService(options: { historyLimit?: number } = {}) {
  const historyLimit = Math.max(1, options.historyLimit ?? 20)
  const messages = shallowRef<WorkstationFeedbackMessage[]>([])
  const listeners = new Set<(message: WorkstationFeedbackMessage) => void>()

  function notify(input: WorkstationFeedbackInput) {
    const message: WorkstationFeedbackMessage = {
      id: crypto.randomUUID(),
      level: input.level,
      title: input.title,
      ...(input.description ? { description: input.description } : {}),
      changes: input.changes ?? [],
      createdAt: new Date(),
    }
    messages.value = [...messages.value, message].slice(-historyLimit)
    for (const listener of listeners) listener(message)
    return message
  }

  function clear(messageId?: string) {
    messages.value = messageId ? messages.value.filter(message => message.id !== messageId) : []
  }

  function subscribe(listener: (message: WorkstationFeedbackMessage) => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return {
    messages: readonly(messages),
    notify,
    clear,
    subscribe,
  } satisfies WorkstationFeedbackService
}
