/* eslint-disable vars-on-top */
import type {
  getCredentialsByTenantUrl,
  getStoredC8yAuth,
  requestTfaSession,
  updateStoredTfaSession,
} from './utils/credentials'

declare global {
  var _getStoredC8yAuth: typeof getStoredC8yAuth
  var _getCredentialsByTenantUrl: typeof getCredentialsByTenantUrl
  var _requestTfaSession: typeof requestTfaSession
  var _updateStoredTfaSession: typeof updateStoredTfaSession
}
