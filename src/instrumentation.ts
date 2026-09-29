/**
 * Runs once when the server starts:
 *  - installs the WebSocket gateway used for low-latency screen/input streaming
 *  - warms up the remote Chromium engine so the first visitor doesn't wait
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [{ installWsGateway }, { ensureEngine }] = await Promise.all([import("./lib/ws-gateway"), import("./lib/remote-browser")]);
  installWsGateway();
  ensureEngine().catch(() => {});
}
