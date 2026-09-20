import {
  AccessService,
  transitionAccessMode,
  accessStateSchema,
  initialAccessState,
  initializeAccess,
  type AccessState,
} from "thesidedoor-core/access";
import type { StateStore } from "thesidedoor-core/storage";
import type { PreparedPrincipalMutation } from "thesidedoor-core/access";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { sharedStateStore } from "./store";
import { serializable } from "./transaction";

const INITIALIZATION = "flight-finder-platform-v1";
export class AccountNotFoundError extends Error {}
const storeFor = (database: Prisma.TransactionClient) =>
  sharedStateStore(
    "access",
    (value) => accessStateSchema.parse(value),
    initialAccessState,
    database,
  );
const accountSelection = {
  id: true,
  username: true,
  isAdmin: true,
  createdAt: true,
} as const;
async function performInitialization(): Promise<void> {
  const existing = await prisma.sidedoorState.findUnique({
    where: { id: "access" },
    select: { state: true },
  });
  if (
    existing &&
    accessStateSchema
      .parse(existing.state)
      .initializations.includes(INITIALIZATION)
  )
    return;
  await serializable(async (database) => {
    const store = storeFor(database);
    if ((await store.read()).initializations.includes(INITIALIZATION)) return;
    await initializeAccess(store, INITIALIZATION, {
      mode: "household",
      householdPasswordHash: null,
      principals: [],
    });
  });
}

export async function assertAccessInitialized(): Promise<void> {
  const existing = await prisma.sidedoorState.findUnique({
    where: { id: "access" },
    select: { state: true },
  });
  if (
    !existing ||
    !accessStateSchema
      .parse(existing.state)
      .initializations.includes(INITIALIZATION)
  )
    throw new Error(
      "Sidedoor initialization is required. Run access initialize.",
    );
}

/** Shared credentials and Flight Finder profile fields commit in the same database transaction. */
export class FlightFinderAccessStore implements StateStore<AccessState> {
  /** Explicit local operator setup. */
  async initialize(): Promise<void> {
    await performInitialization();
  }
  /** Keep owner authorization and configuration writes in one database transaction. */
  async ownerTransaction<Result>(
    ownerToken: string,
    operation: (database: Prisma.TransactionClient) => Promise<Result>,
    recent = true,
  ): Promise<Result> {
    await assertAccessInitialized();
    return serializable(async (database) => {
      const store = storeFor(database);
      const state = await store.read();
      new AccessService({ store: this }).sessionFromState(
        state,
        ownerToken,
        true,
        recent,
      );
      await store.transact((current) => {
        Object.assign(current, state);
      });
      return operation(database);
    });
  }

  /** Account authorization, credentials, profile metadata and deletion share one commit. */
  async managePrincipal(
    ownerToken: string,
    prepared: PreparedPrincipalMutation,
    profile: { displayName?: string | null; avatar?: string | null } = {},
  ) {
    await assertAccessInitialized();
    return serializable(async (database) => {
      const store = storeFor(database);
      const state = await store.read();
      const users = await database.user.findMany({ select: accountSelection });
      new AccessService({ store: this }).sessionFromState(
        state,
        ownerToken,
        true,
        true,
      );
      if (
        prepared.kind !== "create" &&
        !state.principals.some((principal) => principal.id === prepared.id)
      )
        throw new AccountNotFoundError();
      const id = prepared.apply(state, ownerToken);
      const validated = accessStateSchema.parse(state);
      const principal = validated.principals.find((item) => item.id === id);
      if (!principal) {
        // Preserve tracker history as promised by the account deletion screen.
        await database.hotelTracker.updateMany({
          where: { userId: id },
          data: { userId: null },
        });
        await database.hotelSearchRun.updateMany({
          where: { userId: id },
          data: { userId: null },
        });
        await database.carTracker.updateMany({
          where: { userId: id },
          data: { userId: null },
        });
        await database.carSearchRun.updateMany({
          where: { userId: id },
          data: { userId: null },
        });
        await database.user.delete({ where: { id } });
        await store.transact((current) => {
          Object.assign(current, validated);
        });
        return null;
      }
      const existing = users.find((user) => user.id === id);
      const account = {
        username: principal.name,
        isAdmin:
          principal.role === "owner" || principal.pendingRole === "owner",
      };
      const select = {
        id: true,
        username: true,
        displayName: true,
        avatar: true,
        isAdmin: true,
        createdAt: true,
      } as const;
      let user;
      if (existing) {
        user = await database.user.update({
          where: { id },
          data: { ...account, ...profile },
          select,
        });
      } else {
        user = await database.user.create({
          data: {
            id,
            ...account,
            ...profile,
            createdAt: new Date(principal.createdAt),
          },
          select,
        });
      }
      delete principal.sourceVersion;
      await store.transact((current) => {
        Object.assign(current, validated);
      });
      return user;
    });
  }

  /** Local operator recovery may omit the token; HTTP callers must pass their owner session. */
  async disableProfiles(ownerToken?: string): Promise<void> {
    await assertAccessInitialized();
    await serializable(async (database) => {
      const store = storeFor(database);
      const state = await store.read();
      if (ownerToken !== undefined)
        new AccessService({ store: this }).sessionFromState(
          state,
          ownerToken,
          true,
          true,
        );
      transitionAccessMode(state, "household");
      await store.transact((current) => {
        Object.assign(current, state);
      });
      await database.extractionConfig.upsert({
        where: { id: "singleton" },
        create: { id: "singleton", multiUserMode: false },
        update: { multiUserMode: false },
      });
    });
  }

  /** Public admission needs policy, not a transaction reconciling every account. */
  async admissionPolicy(): Promise<
    Pick<AccessState, "mode"> & { hasOwner: boolean; passwordRequired: boolean }
  > {
    await assertAccessInitialized();
    const stored = await prisma.sidedoorState.findUnique({
      where: { id: "access" },
      select: { state: true },
    });
    const state = stored
      ? accessStateSchema.parse(stored.state)
      : await this.read();
    const ownerIds = state.principals
      .filter((principal) => principal.role === "owner")
      .map((principal) => principal.id);
    const owner = ownerIds.length
      ? await prisma.user.findFirst({
          where: { id: { in: ownerIds }, isAdmin: true },
          select: { id: true },
        })
      : null;
    return {
      mode: state.mode,
      hasOwner: owner !== null,
      passwordRequired: state.householdPasswordHash !== null,
    };
  }

  async read(): Promise<AccessState> {
    await assertAccessInitialized();
    return serializable(async (database) => storeFor(database).read());
  }

  async transact<Result>(
    operation: (state: AccessState) => Result,
  ): Promise<Result> {
    await assertAccessInitialized();
    return serializable(async (database) => {
      const store = storeFor(database);
      const state = await store.read();
      const users = await database.user.findMany({ select: accountSelection });
      const result = operation(state);
      if (result instanceof Promise)
        throw new Error("Access transactions must be synchronous");
      const detached = structuredClone(result);
      const validated = accessStateSchema.parse(state);
      if (validated.mode === "individual")
        await database.extractionConfig.upsert({
          where: { id: "singleton" },
          create: { id: "singleton", multiUserMode: true },
          update: { multiUserMode: true },
        });
      if (
        users.some(
          (user) =>
            !validated.principals.some((principal) => principal.id === user.id),
        )
      )
        throw new Error(
          "Delete the application profile to remove its shared principal",
        );
      for (const principal of validated.principals) {
        const user = users.find((item) => item.id === principal.id);
        const data = {
          username: principal.name,
          isAdmin:
            principal.role === "owner" || principal.pendingRole === "owner",
        };
        if (!user) {
          await database.user.create({
            data: {
              id: principal.id,
              ...data,
              createdAt: new Date(principal.createdAt),
            },
          });
        } else if (
          user.username !== data.username ||
          user.isAdmin !== data.isAdmin
        ) {
          await database.user.update({ where: { id: user.id }, data });
        }
        delete principal.sourceVersion;
      }
      await store.transact((current) => {
        Object.assign(current, validated);
      });
      return detached;
    });
  }
}
