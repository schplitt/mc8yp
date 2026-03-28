import { createCodeModeGuidePrompt } from './codemode'

// Create all prompts - called at server startup after execution context is set
export function createPrompts() {
  return [
    createCodeModeGuidePrompt(),
  ]
}
