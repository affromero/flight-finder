import * as generatedModule from '../../apps/web/src/generated/prisma/client.ts';

// tsx loads the generated web client as CommonJS. Normalize its runtime exports
// here so shared web modules can retain their regular named imports.
const generated = generatedModule.default ?? generatedModule;
export const PrismaClient = generated.PrismaClient;
export const Prisma = generated.Prisma;
