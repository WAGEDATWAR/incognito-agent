// Provider adapter: everything that differs between OpenAI-style backends lives here.
// parseModels() returns model infos:
//   { id, name, tools, streaming, vision, reasoning, efforts, context, maxOut, privacy, pricing, routes }
// pricing is { in, out } in USD per million tokens; routes maps a provider id to { privacy, pricing }.

// Friendlier text for Anonrouter's documented error codes (shown after the provider's own message).
const ERROR_HINTS = {
  reasoning_not_supported: 'this model does not reason; set Reasoning effort to Default',
  reasoning_effort_not_configurable: 'this model reasons but its effort is fixed; set Reasoning effort to Default',
  reasoning_effort_unsupported: 'that effort is not available for this model; pick another in Reasoning effort',
  reasoning_not_disableable: 'this model always reasons; do not choose "none"',
  no_provider_route: 'no provider can serve this model with your routing settings; relax them or pick another model',
  no_provider_route_meets_privacy: 'no provider for this model meets your Minimum privacy setting; lower it or pick another model',
  privacy_boundary_not_met: 'your workspace privacy boundary blocks this route; change it in the Anonrouter dashboard or pick another model',
  no_provider_route_meets_price: 'no provider for this model is within the price limit (ANONROUTER_MAX_PRICE_*)',
  provider_policy_conflict: 'a provider appears in both the only and ignore lists (ANONROUTER_PROVIDER_*)',
  invalid_provider_policy: 'check the ANONROUTER_PROVIDER_*, _SORT, _MIN_PRIVACY and _MAX_* settings',
  provider_fallback_exhausted: 'every provider tried failed; retry shortly or pick another model',
  insufficient_balance: 'your Anonrouter balance is too low',
  model_not_found: 'check the model ID in your settings or pick another from the model menu',
  rate_limited: 'Anonrouter rate limit; wait a moment',
  ticket_required: 'this key cannot be used directly; set Request mode to Private tickets',
  invalid_ticket: 'the single-use ticket expired or was already spent',
  ticket_model_mismatch: 'the ticket was issued for a different model',
  ticket_reasoning_mismatch: 'the ticket was issued for a different reasoning setting',
  ticket_provider_policy_mismatch: 'the ticket was issued for different routing settings',
  insufficient_scope: 'this key cannot issue tickets; use an inference key (ar_...)',
};

const PRIVACY = ['anonymous', 'private', 'tee', 'e2ee'];
const SORTS = ['privacy', 'price', 'latency', 'throughput'];
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const positive = (v) => (Number(v) > 0 ? Number(v) : undefined);

export const anonrouter = {
  id: 'anonrouter',
  title: 'Anonrouter',
  envPrefix: 'ANONROUTER',
  credentialsDir: '.anonrouter-acp',
  baseUrl: 'https://api.anonrouter.ai/v1',
  // Identity and billing origin: model listing and ticket issuance in ticket mode. Content goes to baseUrl.
  controlUrl: 'https://control.anonrouter.ai/v1',
  defaultModel: 'gpt-4o',

  // Menus shown in AI Chat. "default" falls back to the matching environment variable, then to Anonrouter's own default.
  settings: [
    { id: 'minimum_privacy', name: 'Minimum privacy', description: 'Lowest privacy tier any provider may use for your requests',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'anonymous', name: 'Anonymous', description: 'Provider may see prompts' },
        { value: 'private', name: 'Private', description: 'Provider does not retain prompts' },
        { value: 'tee', name: 'TEE', description: 'Runs in a trusted execution environment' },
        { value: 'e2ee', name: 'End-to-end encrypted' },
      ] },
    { id: 'sort', name: 'Provider sort', description: 'How eligible providers are ordered',
      options: [{ value: 'default', name: 'Default (privacy)' }, ...SORTS.map((v) => ({ value: v, name: v[0].toUpperCase() + v.slice(1) }))] },
    { id: 'request_mode', name: 'Request mode', description: 'How requests are authorized. Tickets keep your key apart from your prompts.',
      options: [
        { value: 'default', name: 'Default (Standard unless ANONROUTER_TICKETS=1)' },
        { value: 'key', name: 'Standard (API key)', description: 'The key is sent with each request' },
        { value: 'tickets', name: 'Private tickets', description: 'One single-use ticket per model call; the relay never sees your key' },
      ] },
    { id: 'fallbacks', name: 'Provider fallbacks', description: 'Whether another provider may be tried if the first fails',
      options: [{ value: 'default', name: 'On (default)' }, { value: 'off', name: 'Off: single attempt' }] },
  ],

  parseModels(body) {
    return (body.data ?? [])
      .filter((m) => m.id && (!m.model_type || m.model_type === 'text'))
      .map((m) => {
        const caps = m.capabilities ?? {};
        const r = caps.reasoning;
        const reasoning = typeof r === 'object' && r !== null ? !!r.supported : !!r;
        // Only configurable models accept an effort; models that can be switched off also accept "none".
        const efforts = r?.effort_configurable
          ? [...new Set([...(r.can_disable ? ['none'] : []), ...(r.supported_efforts ?? [])])]
          : [];
        const tools = caps.tools !== false;
        const price = (p) => (p ? { in: p.input_usd_per_million_tokens, out: p.output_usd_per_million_tokens } : undefined);
        const routes = Object.fromEntries((m.provider_routes ?? []).map((pr) => [pr.provider, { privacy: pr.privacy_class, pricing: price(pr.pricing) }]));
        return {
          id: m.id,
          name: `${m.id}${m.privacy_class ? ` · ${m.privacy_class}` : ''}${tools ? '' : ' (no tools)'}`,
          tools,
          streaming: caps.streaming !== false,
          vision: !!caps.vision,
          reasoning,
          efforts,
          defaultEffort: r?.default_effort ?? undefined,
          context: m.context_window,
          maxOut: m.max_output_tokens,
          privacy: m.privacy_class,
          pricing: price(m.pricing),
          routes,
        };
      });
  },

  /** Extra request-body fields for a chat request. `settings` holds the menu choices that aren't "default". */
  requestExtras({ effort, env, settings = {} }) {
    const extras = effort && effort !== 'default' ? { reasoning_effort: effort } : {};
    const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
    const routing = {
      order: list(env.ANONROUTER_PROVIDER_ORDER),
      only: list(env.ANONROUTER_PROVIDER_ONLY),
      ignore: list(env.ANONROUTER_PROVIDER_IGNORE),
      allow_fallbacks: settings.fallbacks === 'off' || env.ANONROUTER_ALLOW_FALLBACKS === '0' ? false : undefined,
      sort: pick(settings.sort ?? env.ANONROUTER_SORT, SORTS),
      minimum_privacy: pick(settings.minimum_privacy ?? env.ANONROUTER_MIN_PRIVACY, PRIVACY),
      max_price: positive(env.ANONROUTER_MAX_PRICE_INPUT) || positive(env.ANONROUTER_MAX_PRICE_OUTPUT)
        ? { input: positive(env.ANONROUTER_MAX_PRICE_INPUT), output: positive(env.ANONROUTER_MAX_PRICE_OUTPUT) } : undefined,
      // An agent needs tools (and the chosen reasoning effort) to work, so don't let routing pick a route without them.
      require_parameters: env.ANONROUTER_REQUIRE_PARAMETERS === '0' ? undefined : true,
      max_attempts: [1, 2, 3].includes(Number(env.ANONROUTER_MAX_ATTEMPTS)) ? Number(env.ANONROUTER_MAX_ATTEMPTS) : undefined,
    };
    const provider = Object.fromEntries(Object.entries(routing).filter(([, v]) => v !== undefined));
    if (provider.max_price) provider.max_price = Object.fromEntries(Object.entries(provider.max_price).filter(([, v]) => v !== undefined));
    return Object.keys(provider).length ? { ...extras, provider } : extras;
  },

  /** True when requests should use the private ticket flow (menu choice, else ANONROUTER_TICKETS=1). */
  useTickets({ env, settings = {} }) {
    return (settings.request_mode ?? (env.ANONROUTER_TICKETS === '1' ? 'tickets' : 'key')) === 'tickets';
  },

  /**
   * Body for POST {control}/inference/tickets. A ticket binds the model, the output ceiling, the reasoning choice and
   * the provider policy, so these must be exactly what the completion request then sends.
   */
  ticketBody({ model, extra }) {
    return {
      model,
      ...(extra.provider ? { provider: extra.provider } : {}),
      max_completion_tokens: extra.max_tokens,
      ...(extra.reasoning_effort ? { reasoning_effort: extra.reasoning_effort } : {}),
    };
  },

  explainError(status, body) {
    const code = body?.error?.code ?? body?.error?.type;
    return ERROR_HINTS[code];
  },

  /**
   * Which route served a reply, from the response headers. Streaming responses carry `x-anonrouter-selected-model`
   * ("provider/model") and `x-anonrouter-routing`; the privacy tier comes from the model list for that provider.
   */
  routeInfo(headers, info) {
    const selected = headers.get('x-anonrouter-selected-model');
    if (!selected) return null;
    const provider = headers.get('x-anonrouter-provider') ?? selected.split('/')[0];
    const privacy = headers.get('x-anonrouter-privacy-class') ?? info?.routes?.[provider]?.privacy ?? info?.privacy;
    return {
      provider, privacy, model: selected, routing: headers.get('x-anonrouter-routing'),
      fallback: headers.get('x-anonrouter-provider-fallback') === 'true',
      label: `${provider}${privacy ? ` (${privacy})` : ''}`,
    };
  },

  balance() { return null; },

  /** Milliseconds to wait after a 429, or undefined for the default backoff. */
  retryAfterMs() {
    return undefined;
  },
};
