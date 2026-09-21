import { prisma } from '@/lib/prisma';
import type { Prisma } from '@/generated/prisma/client';
import { usageFromGenerationError } from 'thesidedoor-core/ai/usage';
import { estimateModelCost, getModelCosts, type ExtractionResult, type ExtractionUsage } from './ai-registry';

/** Persist one generation attempt, including failures, using its captured provider selection. */
export async function recordExtraction(
  operation: string,
  provider: string,
  model: string,
  execute: () => Promise<ExtractionResult>,
  persist: (data: Prisma.ApiUsageLogCreateInput) => Promise<unknown> = data => prisma.apiUsageLog.create({ data }),
): Promise<ExtractionResult> {
  const started = Date.now();
  const costs = getModelCosts(provider, model);
  const record = (usage: ExtractionUsage, error?: string) => persist({
    provider, model, ...usage, operation, durationMs: Date.now() - started,
    costUsd: estimateModelCost(usage, costs), ...(error ? { error } : {}),
  });
  let result: ExtractionResult;
  try {
    result = await execute();
  } catch (error) {
    try {
      await record(usageFromGenerationError(error), error instanceof Error ? error.name : 'GenerationError');
    } catch (loggingError) {
      console.error('[AI usage] Failed to record a failed generation', loggingError);
    }
    throw error;
  }
  await record(result.usage);
  return result;
}
