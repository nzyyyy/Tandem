import { Agent, runToolCall } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { AgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { ResourceLoader } from '@earendil-works/pi-coding-agent';
import { AppError, requireValue } from './errors.ts';
import type { BoundModel, ChatMessage, ModelResult, ToolCall, ToolDefinition } from './model.ts';

type PiRun = {
  model: BoundModel;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  signal: AbortSignal;
  request: (onText: (text: string) => void) => Promise<ModelResult>;
  execute: (call: ToolCall) => Promise<Record<string, any> | null>;
};

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

// Tandem owns resource discovery and persistence; never discover ~/.pi or project instructions.
function resources(): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '', getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}

export async function runWithPi(options: PiRun): Promise<void> {
  const { messages, signal } = options;
  requireValue(!signal.aborted, 'CANCELLED');
  const model: Model<string> = {
    id: options.model.modelName, name: options.model.modelName, api: 'tandem',
    provider: options.model.id, baseUrl: options.model.url, reasoning: false,
    input: ['text'], contextWindow: 0, maxTokens: 4096, cost: usage().cost,
  };
  const assistant = (message: ChatMessage): AssistantMessage => ({
    role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [ ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
      ...(message.toolCalls ?? []).map(call => ({ type: 'toolCall' as const, id: call.callId, name: call.name, arguments: JSON.parse(call.arguments) })) ],
    usage: usage(), stopReason: message.toolCalls?.length ? 'toolUse' : 'stop', timestamp: Date.now(),
  });
  const manager = SessionManager.inMemory();
  for (const message of messages) {
    const converted: Message = message.role === 'assistant' ? assistant(message)
      : message.role === 'user' ? { role: 'user', content: message.content, timestamp: Date.now() }
      : { role: 'toolResult', toolCallId: message.callId!,
        toolName: messages.flatMap(m => m.toolCalls ?? []).find(call => call.callId === message.callId)!.name,
        content: [{ type: 'text', text: message.content }], isError: !!JSON.parse(message.content).error, timestamp: Date.now() };
    manager.appendMessage(converted);
  }
  let failure: unknown;
  let halted = false;
  const completed = new Set(messages.filter(m => m.role === 'tool').map(m => m.callId));
  const fail = (error: unknown) => { failure ??= error; agent.abort(); };
  const tools: AgentTool[] = options.tools.map(definition => ({
    ...definition, label: definition.name, executionMode: 'sequential',
    async execute(callId) {
      try {
        requireValue(!halted && !signal.aborted && !failure, 'CANCELLED');
        const call = messages.flatMap(m => m.toolCalls ?? []).find(c => c.callId === callId);
        requireValue(call && call.name === definition.name, 'TOOL_UNAVAILABLE');
        // SDK validation may coerce arguments. Execute the persisted original, never that converted copy.
        const result = await options.execute(call);
        if (result === null) { halted = true; agent.abort(); return { content: [], details: {}, terminate: true }; }
        completed.add(callId);
        if (call.name === 'complete_task' && result.completed) halted = true;
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {},
          isError: !!result.error, terminate: halted };
      } catch (error) { fail(error); throw error; }
    },
  }));
  const agent = new Agent({
    initialState: { model, messages: manager.buildSessionContext().messages },
    toolExecution: 'sequential',
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const partial = assistant({ role: 'assistant', content: '' });
      partial.content = [{ type: 'text', text: '' }];
      stream.push({ type: 'start', partial });
      stream.push({ type: 'text_start', contentIndex: 0, partial });
      void (async () => {
        try {
          requireValue(!halted && !failure && !signal.aborted, 'CANCELLED');
          let previous = '';
          const result = await options.request(text => {
            const delta = text.slice(previous.length); previous = text;
            partial.content = [{ type: 'text', text }];
            stream.push({ type: 'text_delta', contentIndex: 0, delta, partial });
          });
          const message = assistant({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
          message.usage.totalTokens = result.usage ?? 0;
          stream.push({ type: 'done', reason: result.toolCalls.length ? 'toolUse' : 'stop', message });
        } catch (error) {
          fail(error);
          partial.stopReason = signal.aborted ? 'aborted' : 'error';
          partial.errorMessage = error instanceof AppError ? error.code : 'MODEL_FAILED';
          stream.push({ type: 'error', reason: partial.stopReason, error: partial });
        }
      })();
      return stream;
    },
  });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const session = new AgentSession({
    agent, sessionManager: manager, modelRuntime, cwd: process.cwd(), resourceLoader: resources(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false },
      cacheWarming: 'off', enableAnalytics: false, enableInstallTelemetry: false }),
    baseToolsOverride: Object.fromEntries(tools.map(tool => [tool.name, tool])),
    initialActiveToolNames: tools.map(tool => tool.name), allowedToolNames: tools.map(tool => tool.name),
  });
  agent.finishTurn = () => halted || failure || signal.aborted ? { action: 'end' } : undefined;
  agent.subscribe(event => {
    if (event.type === 'tool_execution_end' && !completed.has(event.toolCallId) && !halted && !failure && !signal.aborted) {
      fail(new AppError(tools.some(tool => tool.name === event.toolName) ? 'TOOL_ARGUMENTS' : 'TOOL_UNAVAILABLE'));
    }
  });
  const abort = () => agent.abort();
  signal.addEventListener('abort', abort, { once: true });
  try {
    requireValue(!signal.aborted, 'CANCELLED');
    const last = messages.findLast(m => m.role === 'assistant' && m.toolCalls?.length);
    // An assistant-ended checkpoint cannot enter continue(); replay only its outstanding calls through the SDK.
    for (const call of last?.toolCalls?.filter(c => !completed.has(c.callId)) ?? []) {
      const message = assistant(last!);
      const block = message.content.find(c => c.type === 'toolCall' && c.id === call.callId);
      requireValue(block?.type === 'toolCall', 'MODEL_INVALID_RESPONSE');
      const outcome = await runToolCall(block, {
        tools: agent.state.tools, assistantMessage: message, context: { messages: agent.state.messages }, signal,
      });
      if (failure || halted || signal.aborted) break;
      if (!completed.has(call.callId)) { fail(new AppError(tools.some(t => t.name === call.name) ? 'TOOL_ARGUMENTS' : 'TOOL_UNAVAILABLE')); break; }
      manager.appendMessage({ role: 'toolResult', toolCallId: call.callId, toolName: call.name,
        content: outcome.result.content, isError: outcome.isError, timestamp: Date.now() });
    }
    agent.state.messages = manager.buildSessionContext().messages;
    if (!halted && !failure && !signal.aborted && messages.at(-1)?.role !== 'assistant') await agent.continue();
    if (failure) throw failure;
    requireValue(!signal.aborted, 'CANCELLED');
    if (!halted) requireValue(!agent.state.errorMessage && messages.at(-1)?.role === 'assistant' && !messages.at(-1)?.toolCalls?.length, 'MODEL_FAILED');
  } finally { signal.removeEventListener('abort', abort); session.dispose(); }
}
