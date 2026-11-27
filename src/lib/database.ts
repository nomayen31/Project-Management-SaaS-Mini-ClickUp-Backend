import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

let client: PrismaClient | undefined;

export function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return undefined;

  client ??= new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      enableChannelBinding: true,
      connectionTimeoutMillis: 4_000,
      query_timeout: 5_000,
    }),
  });
  return client;
}

export async function disconnectDatabase() {
  await client?.$disconnect();
}
