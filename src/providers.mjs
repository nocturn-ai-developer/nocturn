import Anthropic from '@anthropic-ai/sdk';

const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5']);

async function completeAnthropic({ cfg, system, messages, tools, onText, onThinking, signal }) {
  const client = new Anthropic(cfg.anthropicKey ? { apiKey: cfg.anthropicKey } : {});
  const useFallback = FALLBACK_MODELS.has(cfg.model);
  const stream = client.beta.messages.stream({
    model: cfg.model,
    max_tokens: 64000,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: cfg.effort },
    cache_control: { type: 'ephemeral' },
    system,
    messages,
    tools: tools.map((t) => ({ ...t, eager_input_streaming: true })),
    betas: useFallback ? ['server-side-fallback-2026-07-01'] : [],
    ...(useFallback ? { fallbacks: 'default' } : {}),
  }, { signal });
  stream.on('text', (delta) => onText(delta));
  stream.on('thinking', (delta) => onThinking(delta));
  const message = await stream.finalMessage();
  return { content: message.content, stopReason: message.stop_reason, refusal: message.stop_details?.explanation };
}

function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) },
      }));
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
        else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    }
  }
  return out;
}

async function completeOpenAi({ cfg, system, messages, tools, onText, signal }) {
  if (!cfg.openaiModel) throw new Error('Set a model name for the OpenAI-compatible provider in Settings.');
  const res = await fetch(`${cfg.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', ...(cfg.openaiKey ? { authorization: `Bearer ${cfg.openaiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.openaiModel,
      stream: true,
      messages: toOpenAiMessages(system, messages),
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  if (!res.ok) throw new Error(`Provider returned ${res.status}: ${(await res.text()).slice(0, 500)}`);

  let text = '';
  let finish = null;
  const calls = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      const choice = JSON.parse(data).choices?.[0];
      if (!choice) continue;
      finish = choice.finish_reason ?? finish;
      if (choice.delta?.content) { text += choice.delta.content; onText(choice.delta.content); }
      for (const c of choice.delta?.tool_calls ?? []) {
        const slot = (calls[c.index ?? 0] ??= { id: '', name: '', args: '' });
        slot.id ||= c.id ?? '';
        slot.name ||= c.function?.name ?? '';
        slot.args += c.function?.arguments ?? '';
      }
    }
  }

  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls) {
    let input = null;
    try { input = JSON.parse(c.args || '{}'); } catch { /* reported to the model by tool validation */ }
    content.push({ type: 'tool_use', id: c.id || `call_${content.length}`, name: c.name, input });
  }
  const stopReason = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : 'end_turn';
  return { content, stopReason };
}

export function complete(args) {
  return args.cfg.provider === 'openai' ? completeOpenAi(args) : completeAnthropic(args);
}
