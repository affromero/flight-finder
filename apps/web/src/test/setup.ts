// Env stubs — tests never hit real services
process.env.ADMIN_SESSION_SECRET = 'test-secret-at-least-32-chars-long!!';
process.env.CRON_SECRET = 'test-cron-secret';
// NODE_ENV is read-only in @types/node, but we need it for test setup
(process.env as Record<string, string>).NODE_ENV = 'test';

// LLMock server runs on this port (started in llmock-setup.ts globalSetup).
// Point all SDK clients at it so leaked requests don't hit real APIs.
const LLMOCK_URL = 'http://127.0.0.1:19876';
process.env.ANTHROPIC_BASE_URL = `${LLMOCK_URL}/v1`;
process.env.OPENAI_BASE_URL = `${LLMOCK_URL}/v1`;

// Dummy API keys — SDK constructors need these to not throw.
