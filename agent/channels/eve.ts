import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, vercelOidc, type AuthFn } from "eve/channels/auth";

// The GitHub Action authenticates with HTTP Basic. The entry is only added
// when the shared secret is configured, so an unset var can never match.
const basicPassword = process.env.PUSHCHECK_BASIC_PASSWORD;

const auth: AuthFn<Request>[] = [
  ...(basicPassword
    ? [httpBasic({ username: "pushcheck", password: basicPassword })]
    : []),
  // Lets the eve TUI and your Vercel deployments reach the deployed agent.
  vercelOidc(),
  // Open on localhost for `eve dev` and the REPL; ignored in production.
  localDev(),
];

export default eveChannel({ auth });
