export const venice = {
  id: 'venice',
  title: 'Venice',
  envPrefix: 'VENICE',
  credentialsDir: '.venice-acp',
  baseUrl: 'https://api.venice.ai/api/v1',
  defaultModel: 'zai-org-glm-5-2',

  settings: [
    { id: 'minimum_privacy', name: 'Minimum privacy', description: 'Venice models marked "private" keep no copy of your prompts; "anonymized" ones may pass through a third party',
      options: [
        { value: 'default', name: 'Default (any model, or VENICE_MIN_PRIVACY)' },
        { value: 'any', name: 'Any model' },
        { value: 'private', name: 'Private models only', description: 'Zero data retention' },
      ] },
    { id: 'web_search', name: 'Web search', description: 'Let Venice search the web for the model (extra credits apply)',
      options: [
        { value: 'default', name: 'Default (off)' },
        { value: 'off', name: 'Off' },
        { value: 'auto', name: 'Auto', description: 'The model decides when to search' },
        { value: 'on', name: 'Always on' },
      ] },
  ],

  parseModels(body) {
    return (body.data ?? [])
      .filter((m) => {
        const caps = m.model_spec?.capabilities ?? {};
        // End-to-end encrypted models need client-side encryption this agent doesn't implement.
        return m.id && m.type === 'text' && !m.model_spec?.offline && !caps.supportsE2EE && !m.id.startsWith('e2ee-');
      })
      .map((m) => {
        const spec = m.model_spec ?? {};
        const caps = spec.capabilities ?? {};
        const tools = !!caps.supportsFunctionCalling;
        return {
          id: m.id,
          name: `${spec.name || m.id}${spec.privacy ? ` · ${spec.privacy}` : ''}${tools ? '' : ' (no tools)'}`,
          tools,
          streaming: true,
          vision: !!caps.supportsVision,
          reasoning: !!caps.supportsReasoning,
          efforts: caps.supportsReasoningEffort ? caps.reasoningEffortOptions ?? [] : [],
          defaultEffort: caps.defaultReasoningEffort,
          context: spec.availableContextTokens ?? m.context_length,
          maxOut: spec.maxCompletionTokens,
          privacy: spec.privacy,
          pricing: spec.pricing?.input?.usd != null ? { in: spec.pricing.input.usd, out: spec.pricing.output?.usd } : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  requestExtras({ effort, env, settings = {} }) {
    const params = {
      // Venice prepends its own system prompt unless told not to; a coding agent wants only ours.
      include_venice_system_prompt: env.VENICE_SYSTEM_PROMPT === '1',
      enable_web_search: settings.web_search ?? (['off', 'on', 'auto'].includes(env.VENICE_WEB_SEARCH) ? env.VENICE_WEB_SEARCH : 'off'),
    };
    // The remaining switches are only sent when turned on, so models that lack the feature are not asked for it.
    if (env.VENICE_WEB_SCRAPING === '1') params.enable_web_scraping = true;
    if (env.VENICE_WEB_CITATIONS === '1') params.enable_web_citations = true;
    if (env.VENICE_X_SEARCH === '1') params.enable_x_search = true;
    if (env.VENICE_STRIP_THINKING === '1') params.strip_thinking_response = true;
    const extras = { venice_parameters: params };
    if (effort && effort !== 'default') extras.reasoning_effort = effort;
    return extras;
  },

  routeInfo() { return null; },

  /** Client-side privacy floor (Venice has no request parameter for it): null if allowed, else the reason. */
  allowsModel({ model, env, settings = {} }) {
    const floor = settings.minimum_privacy ?? env.VENICE_MIN_PRIVACY;
    if (floor !== 'private' || model.privacy === 'private') return null;
    return `${model.id ?? model.name} is not a private model (${model.privacy ?? 'privacy unknown'}), and your Minimum privacy setting allows private models only`;
  },

  /** Account balance from the response headers, e.g. { usd: '12.34', diem: '5' }. */
  balance(headers) {
    const usd = headers.get('x-venice-balance-usd');
    const diem = headers.get('x-venice-balance-diem');
    return usd || diem ? { usd, diem } : null;
  },

  // Docs: x-ratelimit-reset-requests is a Unix timestamp in ms; waiting until then is always safe.
  retryAfterMs(headers) {
    const reset = Number(headers.get('x-ratelimit-reset-requests'));
    if (!reset) return undefined;
    return Math.min(30000, Math.max(1000, reset - Date.now()));
  },
};
