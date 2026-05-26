import React from 'react';
import { Box, Text } from 'ink';

const BACKEND_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Gemini',
};

export function Header() {
  const backend = process.env.FLIGHT_FINDER_BACKEND;
  const label = backend ? BACKEND_LABELS[backend] ?? backend : null;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan" bold>{'╔══════════════════════════════════════╗'}</Text>
      <Text color="cyan" bold>{'║'}<Text color="cyan" bold>  ✈  </Text><Text color="white" bold>F A I R T R A I L</Text>{label ? <Text color="yellow" bold>{'  '}{label}</Text> : ''}{'              '.slice(0, label ? 14 - label.length : 14)}{'║'}</Text>
      <Text color="cyan" bold>{'║'}<Text dimColor>  The price trail they don&apos;t show  </Text>{'║'}</Text>
      <Text color="cyan" bold>{'╚══════════════════════════════════════╝'}</Text>
    </Box>
  );
}
