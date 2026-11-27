import nodemailer from "nodemailer";
import { z } from "zod";

export type Mail = { to: string; subject: string; text: string };

const smtpSettings = z.object({
  SMTP_HOST: z.string().trim().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_TLS_MODE: z.enum(["implicit", "starttls"]).optional(),
  SMTP_USER: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  AUTH_EMAIL_FROM: z.email(),
});

export function loadEmailSender(env: NodeJS.ProcessEnv = process.env) {
  const hasSettings = Object.keys(smtpSettings.shape).some((key) => env[key]);
  if (!hasSettings) return undefined;

  const parsed = smtpSettings.safeParse(env);
  if (!parsed.success) throw new Error("Invalid TaskFlow SMTP configuration.");

  const { SMTP_HOST, SMTP_PORT, SMTP_TLS_MODE, SMTP_USER, SMTP_PASSWORD, AUTH_EMAIL_FROM } = parsed.data;
  const secure = SMTP_TLS_MODE === undefined ? SMTP_PORT === 465 : SMTP_TLS_MODE === "implicit";
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure,
    requireTLS: !secure,
    tls: { minVersion: "TLSv1.2" },
    auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
    connectionTimeout: 7_000,
    greetingTimeout: 7_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

  return async (mail: Mail) => {
    try {
      await transport.sendMail({ ...mail, from: { name: "TaskFlow", address: AUTH_EMAIL_FROM } });
    } catch {
      console.error("Authentication email delivery failed.");
      throw new Error("Authentication email delivery failed.");
    }
  };
}
