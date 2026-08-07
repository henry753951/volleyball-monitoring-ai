import { GraphQLRequestError } from '../lib/coreDomain'
import { isProtectedPath } from '../utils/authBoundary'

export default defineNuxtRouteMiddleware(async (to) => {
  if (!isProtectedPath(to.path) || import.meta.server) return
  const state = useViewerState()
  if (!state.viewer.value) await state.refresh()
  if (state.viewer.value) return
  if (state.error.value instanceof GraphQLRequestError && state.error.value.code !== 'UNAUTHENTICATED') return
  return navigateTo({ path: '/', query: { auth: 'required' } })
})
