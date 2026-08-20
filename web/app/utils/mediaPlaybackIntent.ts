type MediaPlaybackIntent = {
  generation: number
  pendingPlay: Promise<void> | null
  playing: boolean
}

const intents = new WeakMap<HTMLMediaElement, MediaPlaybackIntent>()

function intentFor(element: HTMLMediaElement): MediaPlaybackIntent {
  const existing = intents.get(element)
  if (existing) return existing
  const created: MediaPlaybackIntent = { generation: 0, pendingPlay: null, playing: false }
  intents.set(element, created)
  return created
}

export function isInterruptedMediaPlay(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? String(error.name) : ''
  const message = 'message' in error ? String(error.message) : ''
  return name === 'AbortError' || message.toLowerCase().includes('play() request was interrupted')
}

export function requestMediaPlay(element: HTMLMediaElement): Promise<void> {
  const intent = intentFor(element)
  intent.playing = true
  intent.generation += 1
  if (intent.pendingPlay) return intent.pendingPlay
  if (!element.paused && !element.ended) return Promise.resolve()

  let pending: Promise<void>
  pending = element
    .play()
    .catch((error: unknown) => {
      if (!intent.playing || isInterruptedMediaPlay(error)) return
      throw error
    })
    .finally(() => {
      if (intent.pendingPlay !== pending) return
      intent.pendingPlay = null
      if (!intent.playing && !element.paused) element.pause()
    })
  intent.pendingPlay = pending
  return pending
}

export function requestMediaPause(element: HTMLMediaElement): void {
  const intent = intentFor(element)
  intent.playing = false
  const generation = ++intent.generation
  const pending = intent.pendingPlay
  if (!pending) {
    if (!element.paused) element.pause()
    return
  }

  void pending
    .catch(() => undefined)
    .then(() => {
      if (generation === intent.generation && !intent.playing && !element.paused) element.pause()
    })
}
