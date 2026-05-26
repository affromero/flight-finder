import React from 'react';
import { Box, Text } from 'ink';

interface StatusBarProps {
  hint?: string;
}

export function StatusBar({ hint }: StatusBarProps) {
  return (
    <Box marginTop={1} flexDirection="row" justifyContent="space-between">
      <Text dimColor>{hint ?? 'ctrl+c: quit  tab: navigate  enter: confirm'}</Text>
      <Text dimColor>flight-finder.org</Text>
    </Box>
  );
}
