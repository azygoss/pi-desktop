/** Display names for pi's provider ids ("openai-codex" → "OpenAI Codex"). */
const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  'azure-openai-responses': 'Azure OpenAI',
  google: 'Google',
  'google-gemini-cli': 'Gemini CLI',
  'google-antigravity': 'Antigravity',
  'google-vertex': 'Vertex AI',
  'github-copilot': 'GitHub Copilot',
  'amazon-bedrock': 'Amazon Bedrock',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  openrouter: 'OpenRouter',
  xai: 'xAI',
  zai: 'Z.ai',
  deepseek: 'DeepSeek',
  huggingface: 'Hugging Face',
  minimax: 'MiniMax',
  'kimi-coding': 'Kimi',
  lmstudio: 'LM Studio'
}

/** Unknown ids are title-cased word by word: "my-local_llm" → "My Local Llm". */
export function providerLabel(id: string): string {
  const known = PROVIDER_NAMES[id]
  if (known) {
    return known
  }
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}
