#!/usr/bin/env node
// Mock `omp --mode rpc` for transport tests. Speaks protocol v1 only.
//
// `ready` carries extra unknown keys (`futureField`, `futureUint8`): the spec
// mandates the handshake be *recorded, not validated*, so a client that
// whitelists the documented keys must still complete the handshake.
//
// The unsolicited frame set (a known frame carrying extra fields, an unknown
// frame type, and title frames with a real and an empty title) is emitted in
// response to the first `get_state`, NOT in the spawn burst: `OmpRpcClient.spawn()`
// resolves on `ready`, so frames written into the same stdout chunk can be
// dispatched before a test has registered a listener. Emitting them on a
// command makes the observation deterministic without weakening assertions.
process.stdout.write(JSON.stringify({
  type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864,
  futureField: "ignored", futureUint8: [1, 2, 3],
}) + "\n");

let unsolicitedSent = false;

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const cmd = JSON.parse(line);
    // Echo the *received* command so tests can pin the exact wire field names
    // the client must use (a renamed field would show up as `undefined` here).
    const ok = (data) => process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true, data, received: cmd }) + "\n");
    const bad = (error) => process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: false, error }) + "\n");
    switch (cmd.type) {
      case "negotiate_protocol":
        if (cmd.protocolVersion !== 2) bad(`Unsupported RPC protocol version: ${cmd.protocolVersion}`);
        else ok({ protocolVersion: 2 });
        break;
      case "get_state":
        // One-time unsolicited frame set, written before the response so that
        // `await client.getState()` guarantees the frames were already dispatched.
        if (!unsolicitedSent) {
          unsolicitedSent = true;
          process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "u1", method: "notify", message: "hi" }) + "\n");
          process.stdout.write(JSON.stringify({ type: "future_event", note: "unknown frame type" }) + "\n");
          process.stdout.write(JSON.stringify({ type: "setTitle", title: "mock set title" }) + "\n");
          // An empty title must be ignored by the client (guard: record.title !== "").
          process.stdout.write(JSON.stringify({ type: "setTitle", title: "" }) + "\n");
        }
        ok({ isStreaming: false, sessionId: "s1", systemPrompt: "SP", contextUsage: { tokens: 7, percent: 1 } });
        break;
      case "get_messages": ok({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }); break;
      case "get_session_stats": ok({ tokens: 7 }); break;
      case "get_subagents": ok({ subagents: [] }); break;
      case "prompt":
        ok();
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
        process.stdout.write(JSON.stringify({ type: "session_info_update", title: "mock title", sessionId: "s1" }) + "\n");
        process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\n");
        break;
      case "follow_up":
      case "steer":
        ok();
        break;
      case "compact": ok(); break;
      case "set_model":
        ok({ provider: cmd.provider, id: cmd.modelId });
        process.stdout.write(JSON.stringify({ type: "config_update", model: `${cmd.provider}/${cmd.modelId}` }) + "\n");
        break;
      case "abort": ok(); break;
      case "new_session": ok({ cancelled: false }); break;
      default: bad(`Unknown command: ${cmd.type}`);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
