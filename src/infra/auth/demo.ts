// Demo sign-in shortcuts: "Sign in as <name>" for the seeded Users, all of
// whom share one fixed password. Turned off with DEMO_SIGN_IN=off.
export const demoPassword = "flowdesk-demo";
export const demoEmailDomain = "@flowdesk.example";

export function demoSignInEnabled(): boolean {
  return process.env.DEMO_SIGN_IN !== "off";
}
