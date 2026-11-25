import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  NODE_ENV: z.string().default("production"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_URL: z.string().url().default("http://localhost:8080"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Claude → MCP. Claude can draft and send approved drafts, never approve.
  MCP_BEARER_TOKEN: z.string().min(24),
  // Owner → dashboard API (e.g. the HQ app, server-side). The only credential that can approve.
  DASHBOARD_TOKEN: z.string().min(24),
  // Basic-auth password for the built-in /dashboard pages (defence in depth behind Cloudflare Access).
  DASHBOARD_PASSWORD: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TOKEN_ENC_KEY: z.string().optional(), // 32 bytes, base64 or hex
  JOB_TRACKER_SHEET_ID: z.string().optional(), // optional: otherwise a tracker sheet is created in the primary account
  PRIMARY_ACCOUNT_EMAIL: z.string().optional(), // account that owns the sheet + calendar

  GITHUB_TOKEN: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("anthropic/claude-haiku-5.5"),

  SENDING_ENABLED: bool,
  MAX_SENDS_PER_ACCOUNT_PER_DAY: z.coerce.number().default(15),
  PROFILE_PATH: z.string().default("profile.yaml"),
  TZ_HOME: z.string().optional(), // defaults to profile.yaml home.timezone
  ALLOWED_RETURN_HOSTS: z.string().optional(), // hosts OAuth may redirect back to, comma-separated
  GITHUB_USERNAME: z.string().optional(), // overrides profile.yaml candidate.github
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;
export function config(): Config {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`Invalid environment:\n${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export const googleConfigured = () => {
  const c = config();
  return Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET && c.TOKEN_ENC_KEY);
};
