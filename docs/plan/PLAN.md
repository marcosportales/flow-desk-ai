# Project Brief — FlowDesk AI

**Project type:** Full Stack + AI + Workflow Automation Demonstration  
**Purpose:** Technical demonstration for a job application.  
**Available development time:** 3–5 days.  
**Current status:** Awaiting technical planning and implementation design.

## 1. Context and Purpose

FlowDesk AI is a demonstration application that automates the handling of internal business requests by combining a web application, artificial intelligence, and integrations with external tools.

The project is intended as a technical demonstration for a position combining Full Stack development, AI, and business process automation.

During the job interview, potential projects involving SAP/ERP, data migration to a Data Warehouse, and a ticketing system were mentioned. FlowDesk AI uses a ticketing system as its primary use case because it provides a manageable way to demonstrate system integration, workflow automation, and practical AI capabilities.

The goal is not to reproduce an entire enterprise system or integrate with a company's private infrastructure. It must be a functional, technically sound demonstration that is easy to run and sufficiently well documented for a technical interviewer to evaluate.

## 2. Problem Statement

In a traditional request management process, someone must manually read each request, identify the issue, determine its priority, assign it to the appropriate team, create a record, and notify the relevant people.

Much of this work can be partially automated using workflows and language models.

FlowDesk AI must demonstrate how to transform an incoming request into a structured, traceable process, reducing manual work without delegating critical decisions indiscriminately to AI.

## 3. Primary Objective

Build a functional web application that can:

1. Receive requests through a web form and an API.
2. Use a language model to classify requests and extract structured information.
3. Validate AI outputs through schemas and business rules.
4. Persist tickets in PostgreSQL.
5. Trigger n8n workflows to execute the appropriate actions.
6. Record automation results and potential failures.
7. Allow users to view and manage tickets through a dashboard.
8. Handle integration failures and support controlled retries without creating duplicate tickets.

The result must demonstrate a complete end-to-end workflow rather than a collection of disconnected features.

## 4. Users and Use Cases

The primary user is an employee or support agent who needs to submit and review internal requests.

Example requests:

- "I haven't been able to access SAP since this morning, and I need to process some invoices."
- "I need access to a tool for a new employee."
- "The sales report has been showing incorrect data since yesterday."
- "I need an update on the status of a previous request."

All requests must use fictional demonstration data. No personal data or confidential information from the company involved in the job application should be used.

## 5. Preferred Technology Stack

The initial preferred architecture is:

- **Web application:** Next.js and TypeScript.
- **API:** Next.js Route Handlers, unless the technical analysis justifies another approach.
- **Database:** PostgreSQL.
- **Data access:** Select one suitable solution, considering Drizzle ORM.
- **Validation:** Typed schemas, such as Zod.
- **Workflow automation engine:** n8n.
- **AI:** An LLM provider supporting structured output.
- **System communication:** HTTP, REST APIs, and webhooks.
- **Version control:** Git.

These technologies are initial preferences, not immutable requirements. Before selecting dependencies, the implementation plan should consider development experience, ease of local execution, cost, and the available time.

Do not introduce additional technologies without a concrete justification.

## 6. Conceptual Architecture

The system must separate the responsibilities of the application, AI processing, persistence, and workflow orchestration.

### 6.1. Web Application

Responsibilities:

- Display the request submission form.
- Retrieve and filter tickets.
- Display ticket details.
- Show AI-generated classifications.
- Display automation status and execution history.
- Allow the manual actions included in the project scope.

### 6.2. API and Business Logic

Responsibilities:

- Validate incoming requests.
- Manage ticket creation and retrieval.
- Invoke AI-based classification.
- Validate AI responses.
- Apply deterministic business rules.
- Coordinate ticket persistence and workflow triggering.
- Prevent duplicate operations when a request is retried.

AI must suggest classifications, not freely control the execution of actions. Routing decisions must be restricted to predefined categories and permitted actions.

### 6.3. PostgreSQL

The database must store, at a minimum:

- Tickets.
- AI classifications and validation results.
- Ticket processing status.
- Automation events or execution attempts.
- Errors and retry results.

The implementation plan must propose a concrete data model, define relationships, and identify the constraints needed to maintain consistency.

### 6.4. n8n

n8n must orchestrate the actions that follow ticket creation.

Conceptual workflow:

1. Receive an authenticated event from the application.
2. Validate the incoming payload.
3. Select the appropriate branch based on the validated category and priority.
4. Execute an action, such as a test notification or an HTTP request to a simulated service.
5. Record the outcome.
6. Handle failures and allow controlled retries when appropriate.

The application and n8n must have clearly defined responsibilities. Avoid duplicating the entire business logic in both systems.

## 7. MVP Features

### F1. Ticket Creation

Users must be able to submit a request with a title and description.

The system must validate the input, generate a unique identifier, and preserve the ticket even if a subsequent notification action fails.

### F2. AI-Powered Classification

The model must produce a structured response containing fields such as:

- `category`: an allowed category, for example `erp`, `access`, `data`, or `other`.
- `suggested_priority`: the suggested priority.
- `summary`: a brief summary.
- `suggested_team`: the suggested responsible team.
- `reason`: a short explanation of the classification.

The implementation plan must define the final schema, allowed values, and strategy for handling invalid, incomplete, or ambiguous responses.

Final priority must be subject to deterministic business rules. Urgent tickets must be escalated according to explicit criteria rather than relying exclusively on the model's interpretation.

If the AI provider is unavailable or returns an invalid response, the system must preserve the original request and assign it a recoverable status or flag it for manual review.

### F3. Workflow Automation

After a ticket has been stored and validated, the system must trigger the appropriate workflow.

Examples:

- ERP incident → notify the IT systems team.
- Access issue → route to the access request workflow.
- Data issue → notify the data team.
- Ambiguous request → flag for manual review.

For the demonstration, actions may use a test notification channel or a simulated service. Integration with real enterprise systems is outside the initial scope.

### F4. Dashboard

The dashboard must include:

- Ticket overview.
- A table or list with basic search and filters.
- Ticket statuses.
- Categories and priorities.
- Ticket details.
- Automation history.
- Execution results and errors.
- An action to retry a failed operation when it is safe to do so.

The interface should be clear, professional, and consistent. Usability and readability take priority over complex animations or decorative features.

### F5. Reliability and Traceability

The solution must address:

- Input and output validation.
- Webhook authentication.
- Secure secret management through environment variables.
- Event identifiers and idempotency.
- Execution attempt and outcome tracking.
- Recoverable errors.
- Controlled retries.
- Prevention of duplicate tickets.
- Separation of ticket status from notification status.

The system must not assume that an operation failed completely just because an HTTP response was lost. The implementation plan should consider how to verify the status of an operation before repeating actions with potential side effects.

## 8. Acceptance Scenarios

The implementation is considered demonstrable when the following scenarios can be executed.

### Scenario A: Successful Workflow

1. A request concerning an SAP issue is submitted.
2. The system creates and persists the ticket.
3. The AI produces a valid classification.
4. Business rules are applied.
5. n8n executes the appropriate workflow.
6. The notification action completes successfully.
7. The dashboard displays the ticket and its execution history.

### Scenario B: Urgent Request

1. A request meeting the documented urgency criteria is submitted.
2. The appropriate priority rule is applied.
3. The workflow follows the urgent route.
4. The history makes it possible to verify why the decision was made.

### Scenario C: Integration Failure

1. A valid ticket is created.
2. The notification action fails in a controlled manner.
3. The ticket remains stored.
4. The failure is recorded.
5. The action is retried.
6. The system does not create a duplicate ticket or lose the previous execution history.

### Scenario D: Invalid AI Output or AI Unavailability

1. Classification fails or returns invalid data.
2. The original request is preserved.
3. No actions based on an invalid classification are executed.
4. The ticket remains in a state that supports manual review or recovery.

## 9. Scope Constraints

Available development time: 3–5 days.

Priorities, in order:

1. A functional end-to-end workflow.
2. Real integration between the application and n8n.
3. Consistent persistence and validation.
4. Error handling and traceability.
5. A professional dashboard.
6. Documentation and demonstration.

The following are explicitly outside the MVP:

- Real SAP integration.
- Integration with private corporate systems.
- Actual Data Warehouse synchronization.
- A complete help desk platform.
- A complex roles and permissions system.
- A microservices architecture.
- Autonomous agents with unrestricted tool access.
- RAG, multiple agents, or advanced AI infrastructure.
- Paid integrations that are not necessary to demonstrate the workflow.

Potential future improvements may be proposed but must remain separate from the required scope.

## 10. Quality Requirements

The project must:

- Be reproducible through clear instructions.
- Include documented local setup.
- Use typed and modular code.
- Handle errors explicitly.
- Keep secrets out of the repository.
- Include fictional demonstration data.
- Provide a straightforward way to verify the end-to-end workflow.
- Include tests for critical behavior.
- Provide a README suitable for developers and technical evaluators.

The demonstration should be explainable in approximately 3–5 minutes.

## 11. Final Deliverables

1. Functional web application.
2. Documented API.
3. Database schema and migrations.
4. Exportable n8n workflow.
5. Working integration with an AI provider.
6. Ticket and execution records.
7. Tests covering the main acceptance scenarios.
8. Example environment configuration without secrets.
9. README covering setup, architecture, design decisions, and limitations.
10. Short demonstration script.
11. Optional: a 2–3-minute video or a securely deployed public demo.

## 12. Success Criteria

The project is successful if someone unfamiliar with the code can execute or observe a test request, see how the AI interprets it, observe n8n executing the workflow, and verify what happens when an integration fails.

It must demonstrate sound engineering judgment: separation of responsibilities, validation, data integrity, traceability, basic security, and failure recovery.

The objective is not to build a complete enterprise solution. It is to deliver a small, coherent implementation that can be confidently explained and defended in a technical interview.
