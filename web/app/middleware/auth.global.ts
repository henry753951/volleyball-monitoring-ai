import { GraphQLRequestError } from '../lib/coreDomain'
import { authRedirectQuery, isProtectedPath } from '../utils/authBoundary'

export default defineNuxtRouteMiddleware(async (to) => {
  if (!isProtectedPath(to.path) || import.meta.server) return
  const state = useViewerState()
  if (!state.viewer.value) await state.refresh()
  if (state.viewer.value) return
  const error = state.error.value
  const code = error instanceof GraphQLRequestError ? error.code : undefined
  return navigateTo({ path: '/', query: { auth: authRedirectQuery(code ? { code } : null) } })
})
