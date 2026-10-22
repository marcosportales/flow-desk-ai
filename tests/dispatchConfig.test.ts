import { describe, expect, it } from "vitest";
import { dispatchConfigFromEnv } from "@/infra/workflowEngine/config";

const N8N_ENV = {
  N8N_WEBHOOK_URL: "http://n8n:5678/webhook/flowdesk-dispatch",
  FLOWDESK_TO_N8N_SECRET: "to-n8n",
};
const POWER_AUTOMATE_ENV = {
  WORKFLOW_ENGINE: "power_automate",
  POWER_AUTOMATE_TRIGGER_URL:
    "https://prod.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=s3cret",
  POWER_AUTOMATE_TO_FLOWDESK_SECRET: "from-pa",
};

describe("dispatchConfigFromEnv", () => {
  it("defaults to n8n, calling back on the n8n route", () => {
    expect(dispatchConfigFromEnv(N8N_ENV)).toEqual({
      engine: {
        kind: "n8n",
        webhookUrl: N8N_ENV.N8N_WEBHOOK_URL,
        secret: "to-n8n",
      },
      callbackUrl: "http://app:3000/api/webhooks/n8n",
      callbackTimeoutSeconds: 60,
    });
  });

  it("selects Power Automate, calling back on its own route", () => {
    expect(dispatchConfigFromEnv(POWER_AUTOMATE_ENV)).toEqual({
      engine: {
        kind: "power_automate",
        triggerUrl: POWER_AUTOMATE_ENV.POWER_AUTOMATE_TRIGGER_URL,
      },
      callbackUrl: "http://app:3000/api/webhooks/power-automate",
      callbackTimeoutSeconds: 60,
    });
  });

  it("does not need the n8n settings when Power Automate is selected", () => {
    expect(() =>
      dispatchConfigFromEnv({ ...POWER_AUTOMATE_ENV, N8N_WEBHOOK_URL: "" }),
    ).not.toThrow();
  });

  it("keeps an explicit FLOWDESK_CALLBACK_URL, such as the tunnel's", () => {
    const config = dispatchConfigFromEnv({
      ...POWER_AUTOMATE_ENV,
      FLOWDESK_CALLBACK_URL: "https://quick-tunnel.trycloudflare.com/callback",
    });
    expect(config.callbackUrl).toBe(
      "https://quick-tunnel.trycloudflare.com/callback",
    );
  });

  it.each([
    ["an unknown engine", { ...N8N_ENV, WORKFLOW_ENGINE: "zapier" }],
    [
      "Power Automate without its trigger URL",
      { ...POWER_AUTOMATE_ENV, POWER_AUTOMATE_TRIGGER_URL: "" },
    ],
    [
      "Power Automate without its callback secret",
      { ...POWER_AUTOMATE_ENV, POWER_AUTOMATE_TO_FLOWDESK_SECRET: "" },
    ],
    [
      "Power Automate calling back on the n8n route",
      {
        ...POWER_AUTOMATE_ENV,
        FLOWDESK_CALLBACK_URL: "http://app:3000/api/webhooks/n8n",
      },
    ],
    ["n8n without its webhook URL", { FLOWDESK_TO_N8N_SECRET: "to-n8n" }],
  ])("fails fast on %s", (_, env) => {
    expect(() => dispatchConfigFromEnv(env)).toThrow(
      /Invalid dispatch configuration/,
    );
  });
});
