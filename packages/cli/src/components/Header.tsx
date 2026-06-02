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

  // ink draws and sizes the border, so it stays aligned regardless of the
  // brand, the optional backend label, or the ✈ glyph width. alignSelf keeps
  // the box hugging its content instead of stretching the full terminal width.
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={1}
      marginBottom={1}
      alignSelf="flex-start"
    >
      <Box>
        <Text color="cyan" bold>{'✈  '}</Text>
        <Text color="white" bold>FLIGHT FINDER</Text>
        {label ? <Text color="yellow" bold>{'  '}{label}</Text> : null}
      </Box>
      <Text dimColor>The price trail they don&apos;t show</Text>
    </Box>
  );
}
