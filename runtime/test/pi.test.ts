import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runWithPi } from '../src/pi.ts';
import { toolDefinitions } from '../src/execution.ts';
import { AppError } from '../src/errors.ts';
import type { ChatMessage, ModelResult, ToolCall } from '../src/model.ts';

const model = { id: 'pi-test', protocol: 'openai' as const, apiType: 'chat_completions' as const,
  url: 'https://example.invalid/custom/v1', modelName: 'not-in-any-catalog' };
const call = (callId: string, name: string, args: unknown): ToolCall => ({ callId, name, arguments: JSON.stringify(args) });
const request = (messages: ChatMessage[], result: ModelResult) => {
  messages.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
  return result;
};

test('pi executes a serial batch only after the model checkpoint, then requests the next response', async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'work' }];
  const order: string[] = [];
  let calls = 0;
  await runWithPi({ model, messages, tools: toolDefinitions, signal: new AbortController().signal,
    request: async onText => {
      order.push('model'); onText('stream');
      return request(messages, ++calls === 1 ? { text: '', toolCalls: [call('a', 'list_directory', { grantId: 'g', path: '' }), call('b', 'list_directory', { grantId: 'g', path: 'sub' })] }
        : { text: 'done', toolCalls: [] });
    },
    execute: async tool => {
      assert.ok(messages.some(m => m.toolCalls?.some(c => c.callId === tool.callId)));
      if (tool.callId === 'b') assert.ok(messages.some(m => m.callId === 'a'));
      order.push(tool.callId);
      messages.push({ role: 'tool', callId: tool.callId, content: '{}' });
      return {};
    },
  });
  assert.deepEqual(order, ['model', 'a', 'b', 'model']);
});

test('pi preserves original tool arguments even when its validator coerces them', async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'read' }];
  let requests = 0;
  const original = { grantId: 'g', path: 'a', startLine: '1', endLine: 2 };
  await runWithPi({ model, messages, tools: toolDefinitions, signal: new AbortController().signal,
    request: async () => request(messages, ++requests === 1
      ? { text: '', toolCalls: [call('raw', 'read_file', original)] } : { text: 'done', toolCalls: [] }),
    execute: async tool => {
      assert.deepEqual(JSON.parse(tool.arguments), original);
      messages.push({ role: 'tool', callId: tool.callId, content: '{"error":"TOOL_ARGUMENTS"}' });
      return { error: 'TOOL_ARGUMENTS' };
    },
  });
  assert.equal(requests, 2);
});

for (const stop of ['approval', 'budget', 'cancel', 'complete'] as const) test(`pi stops a tool batch and model requests on ${stop}`, async () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'work' }];
  const controller = new AbortController();
  const budgetError = new AppError('BUDGET_EXHAUSTED');
  let requests = 0, executions = 0;
  const run = runWithPi({ model, messages, tools: toolDefinitions, signal: controller.signal,
    request: async () => {
      assert.equal(++requests, 1);
      return request(messages, { text: '', toolCalls: stop === 'complete'
        ? [call('finish', 'complete_task', { markdown: 'done', evidence: ['verified'] })]
        : [call('first', 'request_directory', { reason: 'read' }), call('later', 'list_directory', { grantId: 'g', path: '' })] });
    },
    execute: async tool => {
      assert.equal(++executions, 1);
      if (stop === 'budget') throw budgetError;
      if (stop === 'cancel') { controller.abort(); throw new AppError('CANCELLED'); }
      if (stop === 'approval') return null;
      messages.push({ role: 'tool', callId: tool.callId, content: '{"completed":true}' });
      return { completed: true };
    },
  });
  if (stop === 'budget') await assert.rejects(run, error => error === budgetError);
  else if (stop === 'cancel') await assert.rejects(run, { code: 'CANCELLED' });
  else await run;
  assert.equal(requests, 1); assert.equal(executions, 1);
  if (stop === 'approval') assert.equal(messages.filter(m => m.role === 'tool').length, 0);
});

test('pi resumes only unfinished calls without adding user input or replaying completed tools', async () => {
  const messages: ChatMessage[] = [ { role: 'user', content: 'work' },
    { role: 'assistant', content: '', toolCalls: [call('done', 'list_directory', { grantId: 'g', path: '' }), call('pending', 'list_directory', { grantId: 'g', path: 'sub' })] },
    { role: 'tool', callId: 'done', content: '{}' } ];
  const executed: string[] = [];
  await runWithPi({ model, messages, tools: toolDefinitions, signal: new AbortController().signal,
    request: async () => {
      assert.deepEqual(executed, ['pending']);
      assert.equal(messages.filter(m => m.role === 'user').length, 1);
      return request(messages, { text: 'done', toolCalls: [] });
    },
    execute: async tool => {
      executed.push(tool.callId); messages.push({ role: 'tool', callId: tool.callId, content: '{}' }); return {};
    },
  });
  assert.deepEqual(executed, ['pending']);
});

for (const invalid of [call('unknown', 'bash', { command: 'echo forbidden' }), call('invalid', 'read_file', { grantId: 'g', path: 'a' })]) {
  test(`pi reports ${invalid.name} validation failure without model recovery or tool execution`, async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'work' }];
    let requests = 0;
    await assert.rejects(runWithPi({ model, messages, tools: toolDefinitions, signal: new AbortController().signal,
      request: async () => { assert.equal(++requests, 1); return request(messages, { text: '', toolCalls: [invalid] }); },
      execute: async () => { assert.fail('invalid tool must not execute'); },
    }), { code: invalid.name === 'bash' ? 'TOOL_UNAVAILABLE' : 'TOOL_ARGUMENTS' });
    assert.equal(requests, 1);
  });
}

test('pi preserves request errors and never retries them', async () => {
  const error = new AppError('MODEL_AUTH');
  let requests = 0;
  await assert.rejects(runWithPi({ model, messages: [{ role: 'user', content: 'work' }], tools: toolDefinitions,
    signal: new AbortController().signal,
    request: async () => { requests++; throw error; }, execute: async () => { assert.fail(); },
  }), e => e === error);
  assert.equal(requests, 1);
});

test('pi does not discover project/global config, skills, extensions, or make background requests', () => {
  const directory = mkdtempSync('/tmp/tandem-pi-discovery-');
  try {
    for (const root of [`${directory}/.pi`, `${directory}/global`]) {
      mkdirSync(`${root}/extensions`, { recursive: true });
      writeFileSync(`${root}/extensions/trap.ts`, 'throw new Error("UNAUTHORIZED_EXTENSION");');
      writeFileSync(`${root}/settings.json`, '{"packages":["npm:must-not-install"],"cacheWarming":"idle"}');
      writeFileSync(`${root}/models.json`, 'invalid JSON');
      writeFileSync(`${root}/AGENTS.md`, 'UNAUTHORIZED_CONTEXT');
    }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw new Error('UNAUTHORIZED_NETWORK'); };
      const { runWithPi } = await import(${JSON.stringify(new URL('../src/pi.ts', import.meta.url).href)});
      let count = 0;
      const messages = [{ role: 'user', content: 'work' }];
      await runWithPi({ model: ${JSON.stringify(model)}, messages, tools: [], signal: new AbortController().signal,
        request: async () => { count++; messages.push({role:'assistant',content:'done'}); return {text:'done',toolCalls:[]}; },
        execute: async () => { assert.fail(); } });
      assert.equal(count, 1); assert.equal(messages.length, 2);
    `], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: `${directory}/global` }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
