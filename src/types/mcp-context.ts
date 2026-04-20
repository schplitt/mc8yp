import type { RestrictionRule } from '../utils/restrictions'

export interface C8yMcpCustomContext extends Record<string, unknown> {
  restrictions: RestrictionRule[]
}