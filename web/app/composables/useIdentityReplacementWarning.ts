const STORAGE_KEY = 'vollyai.identity-replacement-warning'

export function useIdentityReplacementWarning() {
  const enabled = useState<boolean>('identity-replacement-warning', () => true)

  onMounted(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored !== null) enabled.value = stored !== 'false'
  })
  watch(enabled, value => localStorage.setItem(STORAGE_KEY, String(value)))

  return { enabled }
}
