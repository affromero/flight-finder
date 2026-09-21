import { PROVIDER_METADATA, CLI_PROVIDERS } from './provider-metadata';
import { discoverCliModels } from './cli-models';
import { isReasoningEffort, validModelId, type ReasoningSelection } from './cli-model-types';

export interface InferenceSelection { provider: string; model: string; reasoningEffort: ReasoningSelection }
export class InferenceSelectionError extends Error {}
export async function validateInferenceSelection(provider: unknown, model: unknown, reasoning: unknown): Promise<InferenceSelection> {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_METADATA, provider)) throw new InferenceSelectionError('Choose a supported provider');
  if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\r\n\0]/.test(model)
    || (CLI_PROVIDERS[provider] && !validModelId(model))) throw new InferenceSelectionError('Enter a valid model ID');
  if (reasoning != null && reasoning !== 'default' && !isReasoningEffort(reasoning)) throw new InferenceSelectionError('Choose a supported reasoning effort');
  const reasoningEffort = reasoning as ReasoningSelection | undefined ?? null;
  const metadata = PROVIDER_METADATA[provider]!;
  if (provider !== 'codex' && reasoningEffort !== null) throw new InferenceSelectionError('Reasoning selection is not supported by this provider');
  if (provider === 'codex') {
    const catalog = await discoverCliModels(provider);
    const selected = catalog.models.find(entry => entry.id === model);
    if (!selected) throw new InferenceSelectionError('Selected model is not available from this CLI; recheck its version and model catalog');
    if (reasoningEffort !== null && reasoningEffort !== 'default' && !selected.reasoningEfforts.includes(reasoningEffort)) throw new InferenceSelectionError('Selected reasoning effort is not supported by this model');
  } else if (!metadata.allowCustomModel && !metadata.models.some(entry => entry.id === model)) {
    throw new InferenceSelectionError('Selected model does not belong to this provider');
  }
  if (CLI_PROVIDERS[provider] && model.length > 128) throw new InferenceSelectionError('CLI model ID is too long');
  return { provider, model, reasoningEffort };
}
