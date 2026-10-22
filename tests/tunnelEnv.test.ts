import { describe, expect, it } from "vitest";
import { callbackUrlFromHostname, setEnvValue } from "../scripts/tunnelEnv";

describe("callbackUrlFromHostname", () => {
  it("points at the public /callback route over https", () => {
    expect(callbackUrlFromHostname("brave-otter-1234.trycloudflare.com")).toBe(
      "https://brave-otter-1234.trycloudflare.com/callback",
    );
  });
});

describe("setEnvValue", () => {
  it("replaces the key's line and leaves every other line alone", () => {
    const env = [
      "# Dispatch",
      "N8N_WEBHOOK_URL=http://n8n:5678/webhook/flowdesk-dispatch",
      "FLOWDESK_CALLBACK_URL=http://app:3000/api/webhooks/n8n",
      "NOTIFIER_URL=http://notifier:4000",
      "",
    ].join("\n");

    expect(
      setEnvValue(
        env,
        "FLOWDESK_CALLBACK_URL",
        "https://a.trycloudflare.com/callback",
      ),
    ).toBe(
      [
        "# Dispatch",
        "N8N_WEBHOOK_URL=http://n8n:5678/webhook/flowdesk-dispatch",
        "FLOWDESK_CALLBACK_URL=https://a.trycloudflare.com/callback",
        "NOTIFIER_URL=http://notifier:4000",
        "",
      ].join("\n"),
    );
  });

  it("appends the key when the file does not set it yet", () => {
    expect(setEnvValue("NOTIFIER_URL=http://notifier:4000", "KEY", "v")).toBe(
      "NOTIFIER_URL=http://notifier:4000\nKEY=v\n",
    );
    expect(setEnvValue("", "KEY", "v")).toBe("KEY=v\n");
  });

  it("writes the value literally, even with $ patterns in it", () => {
    expect(setEnvValue("KEY=old\n", "KEY", "a$&b")).toBe("KEY=a$&b\n");
  });
});
