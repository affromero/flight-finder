import React, { useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import TextInput from 'ink-text-input';
import { carTerminalText, type CarBrowserConfirmation } from '../lib/car-browser.js';
import { carDocumentLines } from '../lib/car-document.js';

export function CarConfirmation({ confirmation, rows, onConfirm }: { confirmation: CarBrowserConfirmation; rows: number; onConfirm: () => void }) {
  const { columns } = useWindowSize();
  const [answer, setAnswer] = useState(''), [offset, setOffset] = useState(0);
  const operation = confirmation.operation;
  const action = operation.kind === 'edit' && typeof operation.body?.active === 'boolean'
    ? operation.body.active ? 'Resume tracking' : 'Pause tracking' : operation.kind === 'refresh' ? 'Check prices' : operation.kind === 'delete' ? 'Delete tracker' : operation.kind === 'protect' ? 'Recheck rental with protection' : operation.kind;
  const width = Math.max(10, columns - 2), count = Math.max(1, rows - 4);
  const document = [action, carTerminalText(confirmation.label), `Server: ${carTerminalText(confirmation.origin)}`,
    `Account: ${carTerminalText(confirmation.scope)}`, `Target: ${operation.id ?? 'New resource'}`, `Revision: ${operation.revision ?? 'Not applicable'}`,
    ...(confirmation.locations ?? []).map(carTerminalText),
    ...(confirmation.receiptPath ? [`Receipt: ${carTerminalText(confirmation.receiptPath)}`] : []),
    ...(confirmation.conflict ? ['The earlier outcome is unproven. This applies a new change to the displayed revision.'] : []),
    ...(operation.kind === 'delete' ? ['Deletes the tracker and its price history. This cannot be undone.'] : []),
    ...(operation.kind === 'protect' ? ['Rechecks the same base rental with the saved protection choice and a fresh total. Does not book a car or buy coverage.'] : []),
    'Saved payload:', JSON.stringify(operation.body, null, 2),
  ];
  const lines = carDocumentLines(document.flatMap(line => line.split('\n')), width);
  const start = Math.min(offset, Math.max(0, lines.length - count));
  useInput((input, key) => {
    if (key.upArrow) setOffset(Math.max(0, start - 1));
    if (key.downArrow) setOffset(Math.min(start + 1, Math.max(0, lines.length - count)));
  });
  return <Box flexDirection="column">
    <Text bold wrap="truncate-end" color={operation.kind === 'delete' ? '#c1272d' : '#80a8a5'}>{confirmation.receiptPath ? 'RETRY SAVED REQUEST' : 'CONFIRM CHANGE'} / {action}</Text>
    <Text dimColor wrap="truncate-end">Lines {start + 1}-{Math.min(start + count, lines.length)}/{lines.length} · ↑↓ scroll</Text>
    {lines.slice(start, start + count).map((line, index) => <Text key={start + index}>{line}</Text>)}
    <Box><Text>Type yes, then Enter: </Text><TextInput value={answer} onChange={value => setAnswer(value.slice(0, 10))} onSubmit={value => { if (value === 'yes') onConfirm(); }} /></Box>
    <Text dimColor wrap="truncate-end">Esc cancels · Ctrl-C exits</Text>
  </Box>;
}
