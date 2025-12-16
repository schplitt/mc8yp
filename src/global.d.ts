/* eslint-disable vars-on-top */
import type {
  getCredentialsByTenantUrl,
  getStoredC8yAuth,
} from './utils/credentials'

declare global {
  var _getStoredC8yAuth: typeof getStoredC8yAuth
  var _getCredentialsByTenantUrl: typeof getCredentialsByTenantUrl
  var executionEnvironment: 'cli' | 'server'
}
