import type { UseContext } from 'unctx'
import type { C8yAuth } from '../utils/credentials'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getContext, useContext } from 'unctx'

export const AUTH_CONTEXT_KEY = 'auth-context'

export const useAuth: () => C8yAuth = useContext<C8yAuth>(AUTH_CONTEXT_KEY, {
  asyncContext: true,
  AsyncLocalStorage,
})

export function getAuthContext(): UseContext<C8yAuth> {
  return getContext<C8yAuth>(AUTH_CONTEXT_KEY)
}
