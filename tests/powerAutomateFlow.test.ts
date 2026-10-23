import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { categories } from "@/domain/classification";
import { priorities } from "@/domain/priority";
import { isDispatchable, routes, teams } from "@/domain/routing";

// The Power Automate flow is built in a tenant and exported with
// `pac solution unpack` (spec T15), so it cannot run here. These tests read
// the exported definition and hold it to the event the worker sends and the
// rules of ADR 0005, 0006 and 0011.

const solutionDir = join(import.meta.dirname, "..", "power-automate");
const workflowsDir = join(solutionDir, "Workflows");
const [flowFile, ...others] = readdirSync(workflowsDir).filter((f) =>
  f.endsWith(".json"),
);

type Action = {
  type: string;
  expression?: unknown;
  inputs?: Record<string, unknown> & {
    name?: string;
    value?: unknown;
    host?: { operationId?: string };
    parameters?: Record<string, unknown>;
  };
  runAfter?: Record<string, string[]>;
  actions?: Record<string, Action>;
  else?: { actions?: Record<string, Action> };
  cases?: Record<
    string,
    { case: string | number; actions: Record<string, Action> }
  >;
  default?: { actions?: Record<string, Action> };
};

const flow = JSON.parse(readFileSync(join(workflowsDir, flowFile!), "utf8"));
const definition = flow.properties.definition;
const trigger = Object.values(definition.triggers)[0] as {
  type: string;
  kind: string;
  operationOptions?: string;
  inputs: {
    triggerAuthenticationType?: string;
    schema: {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
  };
};

describe("the exported solution", () => {
  it("holds exactly one flow", () => {
    expect(flowFile).toBeDefined();
    expect(others).toEqual([]);
  });
});

describe("the HTTP trigger", () => {
  it("is called with the signed trigger URL alone, no Microsoft sign-in", () => {
    expect(trigger.type).toBe("Request");
    expect(trigger.kind).toBe("Http");
    expect(trigger.inputs.triggerAuthenticationType).toBe("All");
  });

  it("rejects an event that does not match its schema before any step runs", () => {
    expect(trigger.operationOptions).toBe("EnableSchemaValidation");
    expect(trigger.inputs.schema.required).toEqual(
      expect.arrayContaining([
        "dispatch_id",
        "ticket",
        "category",
        "priority",
        "team",
        "route",
        "callback_url",
      ]),
    );
  });

  it("accepts exactly the values the app dispatches", () => {
    const { properties } = trigger.inputs.schema;
    expect(properties.category!.enum).toEqual(
      categories.filter(isDispatchable),
    );
    expect(properties.priority!.enum).toEqual([...priorities]);
    expect(properties.team!.enum).toEqual([...teams]);
    expect(properties.route!.enum).toEqual([...routes]);
  });
});

// Every action in the flow, with the branches that lead to it.
type Located = { name: string; action: Action; path: string[] };
function walk(actions: Record<string, Action>, path: string[]): Located[] {
  return Object.entries(actions).flatMap(([name, action]) => {
    const branches: [string, Record<string, Action> | undefined][] = [
      [`${name}:yes`, action.type === "If" ? action.actions : undefined],
      [name, action.type === "Scope" ? action.actions : undefined],
      [`${name}:no`, action.else?.actions],
      [`${name}:default`, action.default?.actions],
      ...Object.values(action.cases ?? {}).map(
        (c): [string, Record<string, Action>] => [
          `${name}:${c.case}`,
          c.actions,
        ],
      ),
    ];
    return [
      { name, action, path },
      ...branches.flatMap(([branch, children]) =>
        children ? walk(children, [...path, branch]) : [],
      ),
    ];
  });
}
const actions = walk(definition.actions, []);

function httpCall(method: string, urlEnd: string) {
  const found = actions.filter(
    ({ action }) =>
      action.type === "Http" &&
      action.inputs!.method === method &&
      String(action.inputs!.uri).endsWith(urlEnd),
  );
  expect(found, `${method} ...${urlEnd}`).toHaveLength(1);
  return found[0]!;
}

const DISPATCH_ID = "@triggerBody()?['dispatch_id']";

// The If whose yes-branch is taken when the event's `field` is `value`.
function branchOn(field: string, value: string) {
  const found = actions.find(
    ({ action }) =>
      action.type === "If" &&
      JSON.stringify(action.expression) ===
        JSON.stringify({
          and: [{ equals: [`@triggerBody()?['${field}']`, value] }],
        }),
  );
  expect(found, `If ${field} == ${value}`).toBeDefined();
  return found!.name;
}

describe("an erp Dispatch", () => {
  it("creates one incident in the simulated ERP, keyed by the dispatch_id", () => {
    const erp = httpCall("POST", "/erp/incidents");
    expect(erp.path).toContain(`${branchOn("category", "erp")}:yes`);
    expect(erp.action.inputs!.uri).toBe(
      "@{outputs('Public_origin')}/erp/incidents",
    );
    expect(erp.action.inputs!.headers).toMatchObject({
      "Idempotency-Key": DISPATCH_ID,
    });
    expect(erp.action.inputs!.body).toEqual({
      ticket_number: "@triggerBody()?['ticket']?['number']",
      title: "@triggerBody()?['ticket']?['title']",
      summary: "@triggerBody()?['ticket']?['summary']",
      priority: "@triggerBody()?['priority']",
    });
    expect(erp.action.inputs!.retryPolicy).toEqual({ type: "none" });
  });
});

const byName = new Map(actions.map((a) => [a.name, a]));

// Whether `later` waits, directly or through its predecessors, for `earlier`.
function runsAfter(later: string, earlier: string): boolean {
  const after = Object.keys(byName.get(later)?.action.runAfter ?? {});
  return after.includes(earlier) || after.some((n) => runsAfter(n, earlier));
}

function connectorCalls(operationId: string) {
  return actions.filter(
    ({ action }) =>
      action.type === "OpenApiConnection" &&
      action.inputs!.host!.operationId === operationId,
  );
}

function switchOn(expression: string) {
  const found = actions.find(
    ({ action }) =>
      action.type === "Switch" && action.expression === expression,
  );
  expect(found, `Switch on ${expression}`).toBeDefined();
  return found!;
}

// A non-erp Dispatch: look up the delivery, post to Teams, record it.
function teamsDelivery() {
  const lookup = httpCall(
    "GET",
    "/notifier/deliveries/@{encodeUriComponent(triggerBody()?['dispatch_id'])}",
  );
  const lookupSwitch = switchOn(
    `@coalesce(outputs('${lookup.name}')?['statusCode'], 0)`,
  );
  return {
    lookup,
    lookupSwitch,
    nothingDelivered: `${lookupSwitch.name}:404`,
    teamSwitch: switchOn("@triggerBody()?['team']"),
    posts: connectorCalls("PostMessageToConversation"),
    record: httpCall("POST", "/notifier/deliveries"),
  };
}

describe("any other Dispatch", () => {
  it("first asks the notifier whether the dispatch_id was already delivered", () => {
    const { lookup, lookupSwitch } = teamsDelivery();
    expect(lookup.path).toContain(`${branchOn("category", "erp")}:no`);
    // A 404 is an answer, not a failure of the flow.
    expect(lookupSwitch.action.runAfter).toEqual({
      [lookup.name]: ["Succeeded", "Failed"],
    });
  });

  it("posts once to the Team's own channel only when nothing was delivered", () => {
    const { nothingDelivered, teamSwitch, posts } = teamsDelivery();
    expect(teamSwitch.path).toContain(nothingDelivered);
    expect(posts).toHaveLength(teams.length);
    for (const team of teams) {
      const inCase = posts.filter((p) =>
        p.path.includes(`${teamSwitch.name}:${team}`),
      );
      expect(inCase, team).toHaveLength(1);
    }
    const channels = posts.map(
      (p) => p.action.inputs!.parameters!["body/recipient/channelId"],
    );
    expect(new Set(channels).size).toBe(teams.length);
    for (const channel of channels) {
      expect(channel).toMatch(/^@parameters\('.+ \(fd_\w+\)'\)$/);
    }
  });

  it("records the delivery in the notifier after posting, keyed by the dispatch_id", () => {
    const { nothingDelivered, teamSwitch, record } = teamsDelivery();
    expect(record.path).toContain(nothingDelivered);
    expect(runsAfter(record.name, teamSwitch.name)).toBe(true);
    expect(record.action.inputs!.headers).toMatchObject({
      "Idempotency-Key": DISPATCH_ID,
    });
  });

  it("on the Urgent Route also emails the configured mailbox, Team in the subject", () => {
    const { nothingDelivered, teamSwitch, record } = teamsDelivery();
    const emails = connectorCalls("SendEmailV2");
    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email!.path).toContain(nothingDelivered);
    expect(email!.path).toContain(`${branchOn("route", "urgent")}:yes`);
    expect(email!.action.inputs!.parameters).toMatchObject({
      "emailMessage/To": "@parameters('Urgent mailbox (fd_UrgentMailbox)')",
      "emailMessage/Subject": expect.stringContaining(
        "@{triggerBody()?['team']}",
      ),
    });
    // Sent before the delivery is recorded, so a retry cannot skip it.
    const urgent = branchOn("route", "urgent");
    expect(runsAfter(urgent, teamSwitch.name)).toBe(true);
    expect(runsAfter(record.name, urgent)).toBe(true);
  });

  it("never retries a call itself", () => {
    const { lookup, posts, record } = teamsDelivery();
    for (const call of [
      lookup,
      record,
      ...posts,
      ...connectorCalls("SendEmailV2"),
    ]) {
      expect(call.action.inputs!.retryPolicy, call.name).toEqual({
        type: "none",
      });
    }
  });

  it("reports an unexpected notifier answer as a failure, without posting", () => {
    const { lookupSwitch } = teamsDelivery();
    const unexpected = actions.filter((a) =>
      a.path.includes(`${lookupSwitch.name}:default`),
    );
    expect(unexpected.map((a) => a.action)).toEqual([
      expect.objectContaining({
        type: "SetVariable",
        inputs: expect.objectContaining({ name: "error" }),
      }),
    ]);
  });
});

function setVariable(name: string) {
  return actions.filter(
    ({ action }) =>
      action.type === "SetVariable" && action.inputs!.name === name,
  );
}

describe("the callback", () => {
  const callback = () => httpCall("POST", "@triggerBody()?['callback_url']");

  it("is sent once, with the bearer secret and the run name as Execution Reference", () => {
    const { action, path } = callback();
    expect(path).toEqual([]);
    expect(action.inputs!.headers).toMatchObject({
      Authorization:
        "Bearer @{parameters('FlowDesk callback secret (fd_CallbackSecret)')}",
    });
    expect(action.inputs!.body).toMatchObject({
      dispatch_id: DISPATCH_ID,
      execution_reference: "@workflow()['run']['name']",
    });
  });

  it("reports failed with the error when a step fails, succeeded otherwise", () => {
    const { name, action } = callback();
    const [catcher] = Object.entries(action.runAfter!);
    expect(catcher![1]).toEqual(["Succeeded", "Skipped"]);
    expect(byName.get(catcher![0])!.action.runAfter).toEqual({
      Try: ["Failed", "TimedOut"],
    });
    expect(setVariable("error").some((s) => s.path.includes(catcher![0]))).toBe(
      true,
    );
    expect(runsAfter(name, "Try")).toBe(true);
    expect(action.inputs!.body).toMatchObject({
      outcome: "@if(empty(variables('error')), 'succeeded', 'failed')",
      error: "@if(empty(variables('error')), null, variables('error'))",
    });
  });

  it("carries the ERP incident's reference as the External Reference", () => {
    const erp = httpCall("POST", "/erp/incidents");
    const set = setVariable("externalReference");
    expect(set).toHaveLength(1);
    expect(set[0]!.action.inputs!.value).toBe(
      `@body('${erp.name}')?['reference']`,
    );
    expect(callback().action.inputs!.body).toMatchObject({
      external_reference: expect.stringContaining(
        "variables('externalReference')",
      ),
    });
  });

  it("never retries the callback either: Reconciliation is the app's job", () => {
    expect(callback().action.inputs!.retryPolicy).toEqual({ type: "none" });
  });
});

describe("the solution", () => {
  const read = (...path: string[]) =>
    readFileSync(join(solutionDir, ...path), "utf8");
  const parameters = definition.parameters as Record<
    string,
    { defaultValue: unknown; metadata?: { schemaName: string } }
  >;
  const environmentVariables = Object.entries(parameters).filter(
    ([, p]) => p.metadata?.schemaName,
  );

  it("declares every parameter the flow reads as an environment variable", () => {
    const used = new Set(
      [
        ...JSON.stringify(definition).matchAll(
          /@\{?parameters\('([^$'][^']*)'\)/g,
        ),
      ].map((m) => m[1]),
    );
    expect([...used].sort()).toEqual(
      environmentVariables.map(([name]) => name).sort(),
    );
    const solution = read("Other", "Solution.xml");
    for (const [name, { metadata }] of environmentVariables) {
      const schemaName = metadata!.schemaName;
      expect(name).toMatch(` (${schemaName})`);
      expect(
        read(
          "environmentvariabledefinitions",
          schemaName,
          "environmentvariabledefinition.xml",
        ),
      ).toContain(`schemaname="${schemaName}"`);
      expect(solution).toContain(`schemaName="${schemaName}"`);
    }
  });

  it("commits no value for them: the secret and the tenant's ids are set on import", () => {
    for (const [name, p] of environmentVariables) {
      expect(p.defaultValue, name).toBe("");
      expect(
        read(
          "environmentvariabledefinitions",
          p.metadata!.schemaName,
          "environmentvariabledefinition.xml",
        ),
      ).not.toMatch(/<(default)?value>/);
    }
  });

  it("ships the flow and its Teams and Outlook connection references", () => {
    // pac names the file in upper case and writes the id in lower case.
    const workflowId = flowFile!
      .match(/-([0-9A-F-]{36})\.json$/)![1]!
      .toLowerCase();
    expect(read("Other", "Solution.xml")).toContain(`id="{${workflowId}}"`);
    expect(read("Workflows", `${flowFile}.data.xml`)).toContain(
      `WorkflowId="{${workflowId}}"`,
    );
    const customizations = read("Other", "Customizations.xml");
    for (const reference of Object.values(
      flow.properties.connectionReferences,
    ) as {
      connection: { connectionReferenceLogicalName: string };
      api: { name: string };
    }[]) {
      expect(customizations).toContain(
        `connectionreferencelogicalname="${reference.connection.connectionReferenceLogicalName}"`,
      );
      expect(customizations).toContain(
        `/providers/Microsoft.PowerApps/apis/${reference.api.name}`,
      );
    }
  });
});
