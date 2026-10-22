// Pure helpers for scripts/tunnel-url.ts: the public callback URL behind a
// cloudflared quick tunnel, and the .env rewrite that records it.

export function callbackUrlFromHostname(hostname: string): string {
  return new URL("/callback", `https://${hostname}`).toString();
}

export function setEnvValue(env: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(env)) return env.replace(line, () => `${key}=${value}`);
  const separator = env === "" || env.endsWith("\n") ? "" : "\n";
  return `${env}${separator}${key}=${value}\n`;
}
