import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { dash, sentinel } from "@better-auth/infra";
import { Resend } from "resend";
import { z } from "zod";
import { getDatabase } from "./lib/database.js";

const settings = z.object({
  BETTER_AUTH_SECRET: z.string().min(32),
  APP_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return url.origin === value && (url.protocol === "https:" ||
      (process.env.NODE_ENV !== "production" && url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)));
  }),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  AUTH_EMAIL_FROM: z.string().min(1).optional(),
  BETTER_AUTH_API_KEY: z.string().min(1).optional(),
  AUTH_SENTINEL: z.enum(["true", "false"]).default("false"),
}).refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET))
  .refine((env) => Boolean(env.RESEND_API_KEY) === Boolean(env.AUTH_EMAIL_FROM))
  .refine((env) => env.AUTH_SENTINEL === "false" || Boolean(env.BETTER_AUTH_API_KEY))
  .refine((env) => process.env.NODE_ENV !== "production" || Boolean(env.RESEND_API_KEY));

type AuthSettings = z.output<typeof settings>;
type Mail = { to: string; subject: string; text: string };

export function createAuth(config: AuthSettings, database: NonNullable<ReturnType<typeof getDatabase>>, sendMail?: (mail: Mail) => Promise<void>) {
  const resend = config.RESEND_API_KEY ? new Resend(config.RESEND_API_KEY) : undefined;
  const deliver = sendMail ?? (resend && config.AUTH_EMAIL_FROM
    ? async (mail: Mail) => {
        const { error } = await resend.emails.send({ ...mail, from: config.AUTH_EMAIL_FROM! });
        if (error) {
          console.error("Authentication email delivery failed.");
          throw new Error("Authentication email delivery failed.");
        }
      }
    : undefined);

  return betterAuth({
    baseURL: config.APP_ORIGIN,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [config.APP_ORIGIN],
    database: prismaAdapter(database, { provider: "postgresql" }),
    account: { accountLinking: { enabled: false }, encryptOAuthTokens: true },
    advanced: { ipAddress: { ipAddressHeaders: ["x-taskflow-client-ip"] } },
    emailAndPassword: {
      enabled: Boolean(deliver),
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: deliver && (async ({ user, url }) => {
        await deliver({to: user.email, subject: "Reset your TaskFlow password", text: `Reset your TaskFlow password: ${url}`});
      }),
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: deliver && (async ({ user, url }) => {
        await deliver({to: user.email, subject: "Verify your TaskFlow email", text: `Verify your TaskFlow email: ${url}`});
      }),
    },
    socialProviders: config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET ? {
      google: { clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET },
    } : {},
    rateLimit: { enabled: true, storage: "database", window: 60, max: 60 },
    plugins: [
      ...(config.BETTER_AUTH_API_KEY ? [dash({ apiKey: config.BETTER_AUTH_API_KEY })] : []),
      ...(config.AUTH_SENTINEL === "true" ? [sentinel({ apiKey: config.BETTER_AUTH_API_KEY })] : []),
    ],
  });
}

export function loadAuth() {
  if (!process.env.BETTER_AUTH_SECRET && process.env.NODE_ENV !== "production") return undefined;
  const parsed = settings.safeParse(process.env);
  const database = getDatabase();
  if (!parsed.success || !database) throw new Error("Invalid TaskFlow authentication configuration.");
  return {
    instance: createAuth(parsed.data, database),
    workspace: { database, origin: parsed.data.APP_ORIGIN },
    providers: {
      email: Boolean(parsed.data.RESEND_API_KEY),
      google: Boolean(parsed.data.GOOGLE_CLIENT_ID),
      dash: Boolean(parsed.data.BETTER_AUTH_API_KEY),
      sentinel: parsed.data.AUTH_SENTINEL === "true",
    },
  };
}
