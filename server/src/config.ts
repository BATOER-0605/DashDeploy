import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const boolish = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  GITHUB_PAT: z.string().min(1, "GITHUB_PAT is required"),
  PVE_HOST: z.string().min(1, "PVE_HOST is required"),
  PVE_PORT: z.coerce.number().int().positive().default(8006),
  PVE_TOKEN_ID: z.string().min(1, "PVE_TOKEN_ID is required"),
  PVE_TOKEN_SECRET: z.string().min(1, "PVE_TOKEN_SECRET is required"),
  PVE_TLS_REJECT_UNAUTHORIZED: boolish,
  BIND_HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  TAILSCALE_API_KEY: z.string().optional(),
  TAILSCALE_TAILNET: z.string().optional(),
  SERVERS_FILE: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Re-read the .env file (overriding existing env vars) and reset the cache. */
export function reloadConfig(): AppConfig {
  loadDotenv({ override: true });
  cached = null;
  return getConfig();
}
