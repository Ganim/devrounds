// A stand-in for a headless agent runtime in tests: takes the claude-code provider's flags and prints stream-json as
// that runtime does, so no test spends a paid run. The prompt picks the session's shape:
// - `silent`: prints nothing and exits 0 (no events, no result).
// - `no-result`: messages and usage, then exits without a result line (usage only from the transcript).
// - `limit`: ends with the runtime's max-budget error.
// - anything else: one tool call, two messages and a success result whose text is the prompt.
// The tool's input and output carry SECRET-INPUT and SECRET-OUTPUT, which must never reach agent_events.
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    p: { type: 'string' },
    'output-format': { type: 'string' },
    verbose: { type: 'boolean' },
    'session-id': { type: 'string' },
    resume: { type: 'string' },
    model: { type: 'string' },
    'permission-mode': { type: 'string' },
    'max-budget-usd': { type: 'string' },
    'append-system-prompt': { type: 'string' },
    'json-schema': { type: 'string' },
  },
  strict: true,
})

const prompt = values.p ?? ''
const session = values.resume ?? values['session-id'] ?? 'no-session'
const usage = (input: number, output: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 10,
})
const print = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`)

if (prompt !== 'silent') {
  print({ type: 'system', subtype: 'init', session_id: session, resumed: values.resume !== undefined })
  const call = { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo SECRET-INPUT' } }
  const first = { id: 'msg_1', role: 'assistant', usage: usage(20, 5) }
  // A message spread over two lines repeats its usage on each.
  print({
    type: 'assistant',
    session_id: session,
    message: { ...first, content: [{ type: 'text', text: 'Checking.' }] },
  })
  print({ type: 'assistant', session_id: session, message: { ...first, content: [call] } })
  print({
    type: 'user',
    session_id: session,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'SECRET-OUTPUT' }] },
  })
  print({
    type: 'assistant',
    session_id: session,
    message: { id: 'msg_2', role: 'assistant', usage: usage(30, 7), content: [{ type: 'text', text: 'Done.' }] },
  })
  if (prompt !== 'no-result') {
    const limit = prompt === 'limit'
    print({
      type: 'result',
      subtype: limit ? 'error_max_budget_usd' : 'success',
      is_error: limit,
      session_id: session,
      total_cost_usd: 0.0123,
      usage: usage(50, 12),
      result: limit ? undefined : prompt,
      permission_denials: [{ tool_name: 'WebFetch', tool_use_id: 'toolu_2', tool_input: { url: 'SECRET-INPUT' } }],
    })
  }
}
