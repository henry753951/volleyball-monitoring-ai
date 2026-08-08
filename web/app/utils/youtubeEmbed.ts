export function youtubeEmbedUrl(value: string): string | null {
  if (!value.trim()) return null
  try {
    const url = new URL(value)
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)) return null
    const id = url.hostname === 'youtu.be'
      ? url.pathname.split('/').filter(Boolean)[0]
      : url.pathname.startsWith('/live/') || url.pathname.startsWith('/embed/')
        ? url.pathname.split('/').filter(Boolean)[1]
        : url.searchParams.get('v')
    if (!id || !/^[\w-]{6,20}$/.test(id)) return null
    const embed = new URL(`https://www.youtube.com/embed/${id}`)
    embed.searchParams.set('playsinline', '1')
    embed.searchParams.set('rel', '0')
    return embed.toString()
  }
  catch { return null }
}
