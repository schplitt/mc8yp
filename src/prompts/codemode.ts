import { definePrompt } from 'tmcp/prompt'
import { prompt } from 'tmcp/utils'

export function createCodeModeGuidePrompt() {
  return definePrompt({
    name: 'code-mode-guide',
    description: 'Guide for the two code-mode tools: query and execute, including available shapes and examples.',
  }, () => {
    return prompt.message(
      `# Cumulocity Code Mode

You have exactly two MCP tools available.

## query
Use \`query\` when you need to inspect the OpenAPI spec.

- Input: JavaScript source that evaluates to a function
- The function receives one argument object with a frozen \`spec\` property
- Return the exact value you want back

### Available Shape
\`\`\`ts
type OperationInfo = {
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Array<{ name: string, in: string, required?: boolean, schema?: unknown, description?: string }>
  requestBody?: { required?: boolean, content?: Record<string, { schema?: unknown }> }
  responses?: Record<string, { description?: string, content?: Record<string, { schema?: unknown }> }>
}

type PathItem = {
  get?: OperationInfo
  post?: OperationInfo
  put?: OperationInfo
  patch?: OperationInfo
  delete?: OperationInfo
}

declare const spec: {
  paths: Record<string, PathItem>
}
\`\`\`

Example:
\`\`\`js
({ spec }) => {
  return Object.keys(spec.paths).filter((path) => path.includes('inventory'))
}
\`\`\`

\`\`\`js
async ({ spec }) => {
  const op = spec.paths['/inventory/managedObjects']?.get
  return op?.parameters
}
\`\`\`

## execute
Use \`execute\` when you want to call the real Cumulocity API.

- Input: JavaScript source that evaluates to a function
- The function receives one argument object with \`cumulocity\`
- It can call \`await cumulocity.request(pathOrDescriptor, init?)\`
- Do not build auth headers or tenant URLs yourself
- Return the exact value you want back

### Available Shape
\`\`\`ts
interface CumulocityRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  body?: unknown
  headers?: Record<string, string>
}

declare const cumulocity: {
  request<T = unknown>(path: string, init?: RequestInit): Promise<T>
  request<T = unknown>(options: CumulocityRequestOptions): Promise<T>
}
\`\`\`

Examples:
\`\`\`js
async ({ cumulocity }) => {
  return cumulocity.request('/inventory/managedObjects?pageSize=5', {
    method: 'GET',
  })
}
\`\`\`

\`\`\`js
async ({ cumulocity }) => {
  const alarms = await cumulocity.request({
    method: 'GET',
    path: '/alarm/alarms?pageSize=10',
  })
  return alarms.alarms
}
\`\`\`

\`\`\`js
async ({ cumulocity }) => {
  return cumulocity.request({
    method: 'GET',
    path: '/inventory/managedObjects?pageSize=20&withTotalPages=true',
  })
}
\`\`\`

## CLI Mode
When running in CLI mode, first use \`list-credentials\` to see available tenants. Then pass the chosen \`tenantUrl\` to \`execute\`.

## Working Pattern
1. Use \`query\` to find the right endpoint, parameters, and response shape.
2. Use \`execute\` to call that endpoint.
3. Keep functions small and return only the data needed for the next reasoning step.
`,
    )
  })
}
