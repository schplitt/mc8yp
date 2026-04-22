import type { UseContext } from 'unctx'
import type { AuthContext } from '../utils/credentials'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getContext, useContext } from 'unctx'

export const AUTH_CONTEXT_KEY = 'auth-context'

export const useAuth: () => AuthContext = useContext<AuthContext>(AUTH_CONTEXT_KEY, {
  asyncContext: true,
  AsyncLocalStorage,
})

export function getAuthContext(): UseContext<AuthContext> {
  return getContext<AuthContext>(AUTH_CONTEXT_KEY)
}
