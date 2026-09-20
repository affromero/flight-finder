import type { Command } from "commander";
import {
  executeAccessCommand,
  parseAccessCommand,
} from "thesidedoor-core/access";

export function registerAccessCommands(program: Command): void {
  program
    .command("access <operation> [principalId] [deviceName]")
    .description(
      "Local access administration: initialize, list, claim, recover, device",
    )
    .action(
      async (
        operation: string,
        principalId: string | undefined,
        deviceName: string | undefined,
      ) => {
        const args = [operation, principalId, deviceName].filter(
          (value): value is string => value !== undefined,
        );
        let database: { $disconnect(): Promise<void> } | undefined;
        try {
          if (operation === "prepare" || operation === "finalize") {
            if (args.length !== 1)
              throw new Error(`Use access ${operation}.`);
            const { prisma } = await import("@/lib/prisma");
            database = prisma;
            const cutover = await import(
              "../../../../apps/web/src/lib/sidedoor/migration/platform-cutover"
            );
            console.log(
              JSON.stringify(
                operation === "prepare"
                  ? await cutover.preparePlatformCutover()
                  : await cutover.finalizePlatformCutover(),
              ),
            );
            return;
          }
          parseAccessCommand(args);
          const { prisma } = await import("@/lib/prisma");
          database = prisma;
          const { AccessService, DeviceService } =
            await import("thesidedoor-core/access");
          const { FlightFinderAccessStore } =
            await import("../../../../apps/web/src/lib/sidedoor/access/access-store");
          const store = new FlightFinderAccessStore();
          const access = new AccessService({ store });
          console.log(
            await executeAccessCommand(access, args, {
              initialize: async () => {
                await store.initialize();
                return { warnings: [] };
              },
              devices: {
                service: new DeviceService({
                  access,
                  scopesFor: () => ["api"],
                  tokenPrefix: "ff_",
                }),
                scopes: ["api"],
              },
            }),
          );
        } catch (error) {
          console.error(
            `Error: ${error instanceof Error ? error.message : String(error)}`,
          );
          process.exitCode = 1;
        } finally {
          await database?.$disconnect();
        }
      },
    );
}
