#!/usr/bin/env python3
"""superd hermes WS-attach bridge: stdio JSON-RPC (adapter contract) <-> the profile's gateway WS.

The standalone `tui_gateway.entry` stdio server can no longer co-own a Hermes home: a running
gateway holds `gateway.lock` and refuses a second owner ("attach to it instead"). The sanctioned
attach is the canonical WebSocket (`ui-tui` attaches over it; `hermes_cli.gateway_client` is the
product client module). This bridge keeps the adapter's stdio ndjson JSON-RPC contract byte-stable
while the frames ride that WebSocket:

  stdin  line -> `GatewayClient.rpc` (ids mapped 1:1; the gateway reader drops bare replies whose
                 ids it does not own, so requests MUST ride the product client), reply -> stdout
  ws event    -> stdout line (`{"method":"event","params":{...}}` wire events via the event queue)
  on connect  -> one synthesized `gateway.ready` event (the stdio contract; the canonical gateway
                 has no ready frame - readiness is the discovery grant + open socket)

The adapter was built against the STANDALONE serve; the ws authority path re-shapes exactly five
verbs (contract files: `tui_gateway/contracts/canonical*.py`, `gateway/session_controls.py`,
`gateway/session_busy_controls.py`; every params model is `extra="forbid"`). The bridge reconciles:

  session.create    drop `cols` (standalone-only field; CanonicalCreateParams forbids it)
  prompt.submit     inject `submission_id` (authority refuses without a client request id; the
                    adapter never sends one) and translate the AdmissionStatus receipt into the
                    standalone `{"status":"streaming"}` ack the adapter's busy path requires;
                    `{voice_stopped:true}` becomes a JSON-RPC error (a DSH turn is never voice)
  session.steer     inject `execution_generation` (CanonicalCorrectionParams requires it)
  session.interrupt inject `execution_generation` (CanonicalControlParams requires it)
  approval.respond  translate `{request_id, choice}` into the authority's EXACT
                    `{prompt_id, execution_generation, choice}` set, with the generation tracked
                    from the `approval.request` event payload

The generation tracker seeds from the session.create/session.resume snapshot and refreshes from
every live event frame (`execution_generation` rides the frame top level, the CanonicalReplayEvent
shape), every `prompt.submit` receipt, `approval.request` payload and control ack that carries one.
Unknown-on-authority methods (`session.usage` / `session.status` / `session.compress` /
`session.close`) answer the gateway's own -32601 verbatim; the adapter treats close as
fire-and-forget and the other two degrade to tool errors without touching the turn log.

Events: frames for foreign sessions are dropped once a session is bound (the adapter demuxes on
the live id anyway; filtering here keeps foreign approval requests away from the bridge layer).
`connect_gateway()` attaches to the home's running owner, or starts one (idle-exit) when none
runs, so the same bridge serves both machines with a persistent gateway and machines where the
adapter previously owned the home. Failure to obtain a gateway exits 2 with the
`[bridge-attach-unavailable]` stderr marker (maps onto the adapter's existing spawn-failure UX).

Env: PYTHONPATH / HERMES_PYTHON_SRC_ROOT (set by the adapter) put `hermes_cli` on the path.
HERMES_HOME stays unset (default profile home), matching the stdio spawn's strip list.
"""
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path


def _bootstrap_deps() -> None:
    """Boot the committed dependency generation, exactly like gateway_bootstrap.py does for the TUI."""
    root = os.environ.get("HERMES_PYTHON_SRC_ROOT", "")
    if root:
        sys.path.insert(0, root)
    try:
        from pm.environments import NoCommittedEnvironment, activate_dependencies  # type: ignore

        try:
            activate_dependencies(Path(root))
        except NoCommittedEnvironment:
            pass
    except ImportError:
        pass  # a venv python already carries the deps


class BridgeAttachUnavailable(Exception):
    """No owner to attach and none startable (or the client module is unusable)."""


class BridgeState:
    """One adapter connection's session-bound translation state."""

    def __init__(self) -> None:
        self.session_id = None
        self.generation = 0
        self.prompt_generations = {}

    # -- request side ---------------------------------------------------------
    def translate_request(self, method, params):
        """Return (method, params) as the authority contract requires them."""
        if method == "session.create":
            # Standalone-only field; CanonicalCreateParams is extra="forbid".
            params = {k: v for k, v in params.items() if k != "cols"}
        elif method == "prompt.submit":
            # Authority refusal without a client-chosen request id (replay guard).
            if not params.get("submission_id") and not params.get("input_id"):
                params = {**params, "submission_id": f"superd-{uuid.uuid4().hex}"}
        elif method in ("session.steer", "session.interrupt"):
            if "execution_generation" not in params:
                params = {**params, "execution_generation": self.generation}
            print(f"[bridge-ctl] {method} injected_gen={params.get('execution_generation')} tracked={self.generation}", file=sys.stderr)
        elif method == "approval.respond":
            params = self._translate_approval(params)
        return method, params

    def _translate_approval(self, params):
        if "prompt_id" in params and "request_id" not in params:
            return params  # already canonical
        request_id = params.get("request_id")
        generation = self.prompt_generations.get(request_id, self.generation)
        return {"session_id": params.get("session_id"), "prompt_id": request_id,
                "execution_generation": generation, "choice": params.get("choice")}

    # -- reply side -----------------------------------------------------------
    def translate_result(self, method, params, result):
        """Return the reply the standalone-shaped adapter expects, or an error dict."""
        if method in ("session.create", "session.resume") and isinstance(result, dict):
            sid = result.get("session_id") or result.get("stored_session_id")
            if isinstance(sid, str) and sid:
                self.session_id = sid
            gen = result.get("execution_generation")
            if isinstance(gen, int):
                self.generation = gen
            return result
        if method == "prompt.submit":
            if not isinstance(result, dict):
                return result
            if result.get("voice_stopped") is True:
                return {"__error__": {"code": -32001, "message": "voice stopped: nothing was admitted"}}
            gen = result.get("execution_generation")
            if isinstance(gen, int):
                self.generation = gen
            # Standalone ack contract: status "streaming" (the adapter rejects anything else);
            # the canonical AdmissionStatus rides along for tracing.
            return {"status": "streaming", "receipt": result}
        if isinstance(result, dict) and method in ("session.steer", "session.interrupt"):
            gen = result.get("execution_generation")
            if isinstance(gen, int):
                self.generation = gen
            return result
        return result

    # -- event side -----------------------------------------------------------
    def observe_event(self, params):
        """Track generations/pending prompts; return False when the frame must not reach stdout."""
        if not isinstance(params, dict):
            return True
        sid = params.get("session_id")
        if self.session_id is not None and isinstance(sid, str) and sid and sid != self.session_id:
            return False  # foreign session: never forward (adapter demux would drop it anyway)
        gen = params.get("execution_generation")  # live frames carry it top-level (CanonicalReplayEvent shape)
        if isinstance(gen, int):
            self.generation = gen
        payload = params.get("payload")
        if not isinstance(payload, dict):
            return True
        gen = payload.get("execution_generation")
        if isinstance(gen, int):
            self.generation = gen
        if params.get("type") == "approval.request" and isinstance(payload.get("prompt_id"), str):
            self.prompt_generations[payload["prompt_id"]] = gen if isinstance(gen, int) else self.generation
            if len(self.prompt_generations) > 64:  # settled prompts are answered once; bound the map
                self.prompt_generations.pop(next(iter(self.prompt_generations)))
        return True


async def _answer(client, state, rid, method, params) -> None:
    """One adapter request through the product client (the gateway reader drops
    bare replies whose ids it does not own, so raw forwarding cannot work)."""
    from hermes_cli.gateway_client import GatewayRPCError  # type: ignore
    try:
        method, params = state.translate_request(method, params)
        result = await client.rpc(method, _timeout=float("inf"), **params)
        translated = state.translate_result(method, params, result)
        if isinstance(translated, dict) and "__error__" in translated:
            frame = {"jsonrpc": "2.0", "id": rid, "error": translated["__error__"]}
        else:
            frame = {"jsonrpc": "2.0", "id": rid, "result": translated}
    except GatewayRPCError as exc:
        code = exc.code if isinstance(exc.code, int) else -32000
        frame = {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": str(exc)}}
    except Exception as exc:  # transport died mid-call: surface as the turn error
        frame = {"jsonrpc": "2.0", "id": rid, "error": {"code": -32603, "message": f"{type(exc).__name__}: {exc}"}}
    sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
    sys.stdout.flush()


async def _stdin_pump(client, state) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)
    inflight = set()
    while True:
        line = await reader.readline()
        if not line:
            return  # adapter closed its side: the ws close ends the process
        text = line.decode("utf-8", "replace").strip()
        if not text:
            continue
        req = None
        try:
            req = json.loads(text)
            rid = req.get("id")
            method = req.get("method")
            params = req.get("params")
            if not isinstance(method, str) or (params is not None and not isinstance(params, dict)):
                raise ValueError("request needs a string method and object params")
            task = asyncio.create_task(_answer(client, state, rid, method, params or {}))
            inflight.add(task)
            task.add_done_callback(inflight.discard)
        except Exception as exc:
            broken_id = req.get("id") if isinstance(req, dict) else None
            sys.stdout.write(json.dumps(
                {"jsonrpc": "2.0", "id": broken_id, "error": {"code": -32700, "message": str(exc)}}) + "\n")
            sys.stdout.flush()


async def _event_pump(client, state) -> None:
    while True:
        frame = await client.events.get()
        params = frame.get("params") if isinstance(frame, dict) else None
        if not state.observe_event(params if isinstance(params, dict) else {}):
            continue
        sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
        sys.stdout.flush()


async def _run() -> int:
    try:
        from hermes_cli.gateway_client import connect_gateway  # type: ignore
    except Exception as exc:  # ImportError and activation failures alike
        raise BridgeAttachUnavailable(f"gateway client module unavailable: {exc}") from exc

    try:
        async with connect_gateway() as client:
            state = BridgeState()
            pump_events = asyncio.create_task(_event_pump(client, state))
            # Readiness contract first: the adapter queues every RPC behind gateway.ready.
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0", "method": "event",
                "params": {"type": "gateway.ready", "payload": {"transport": "ws-attach"}},
            }) + "\n")
            sys.stdout.flush()
            pump_stdin = asyncio.create_task(_stdin_pump(client, state))
            done, pending = await asyncio.wait({pump_events, pump_stdin}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc is not None:
                    raise exc
    except BridgeAttachUnavailable:
        raise
    except Exception as exc:  # GatewayUnavailableError / GatewayClientError / transport failures
        raise BridgeAttachUnavailable(f"{type(exc).__name__}: {exc}") from exc
    return 0


def main() -> int:
    _bootstrap_deps()
    try:
        return asyncio.run(_run())
    except BridgeAttachUnavailable as exc:
        # No owner and none startable: the marker lets the adapter map this onto
        # the ordinary spawn-failure surface (message lands in the turn error).
        print(f"[bridge-attach-unavailable] {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 0
    except Exception as exc:  # transport/protocol failures: ordinary child failure
        print(f"[bridge-exit] {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
