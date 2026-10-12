"""Better-owned integration around the unchanged OMP runner (see provenance.json)."""
import ast
import asyncio
import builtins
import contextvars
import json
import inspect
import os
import signal
import subprocess
import time
import sys
import threading
import urllib.request
import uuid

_RUN = contextvars.ContextVar('better_run', default=None)
_SPECS = contextvars.ContextVar('better_specs', default={})
_PENDING = {}
_LOCK = threading.Lock()
_WRITE_LOCK = threading.Lock()
_OWNED = {}
_INJECTED = {}
_STARTED = False
_WRITER = None


class HostRejected(Exception):
    pass


def _deliver(reply):
    with _LOCK:
        item = _PENDING.get(reply.get('id'))
    if item is None:
        return
    loop, future, run = item
    if reply.get('run') != run:
        return
    def settle():
        if not future.done():
            if reply.get('ok') is True:
                future.set_result(reply.get('result'))
            else:
                future.set_exception(HostRejected(reply.get('message') or 'host request failed'))
    loop.call_soon_threadsafe(settle)


def _read_replies():
    with os.fdopen(4, 'r', encoding='utf-8') as reader:
        for line in reader:
            try:
                _deliver(json.loads(line))
            except (ValueError, RuntimeError):
                continue


def unsupported_input(*args, **kwargs):
    raise RuntimeError('Interactive stdin is unsupported in Better Python REPL; pass input as a variable or tool argument')


def initialize(ns):
    global _STARTED, _WRITER
    __import__('better_snapshot')  # preload pinned dill before user imports
    if not _STARTED:
        _OWNED.update(ns)
        if not os.environ.get('BETTER_CALLBACK_URL'):
            _WRITER = os.fdopen(3, 'w', encoding='utf-8', buffering=1)
            threading.Thread(target=_read_replies, name='better-callback-replies', daemon=True).start()
        _STARTED = True
    # Do not mutate the runner's Python builtins or put internal imports in user globals.
    ns['__builtins__'] = dict(vars(builtins), input=unsupported_input)
    _OWNED['__builtins__'] = ns['__builtins__']
    ns['__omp_with_call_site__'] = with_call_site


async def with_call_site(site_id, action, args):
    """Required runner compiler seam; Better has no speculative read cache."""
    result = action(args)
    return await result if inspect.isawaitable(result) else result


def reset(ns, args):
    """Invoke the native magic, then immediately restore Better capabilities."""
    __import__('better_snapshot').clear()
    sys.modules['__main__'].__dict__['__omp_magic']('reset', args)
    initialize(ns)
    install_bindings(ns, _SPECS.get())


class ResetAdapter(ast.NodeTransformer):
    def visit_Call(self, node):
        node = self.generic_visit(node)
        if (isinstance(node.func, ast.Name) and node.func.id == '__omp_magic'
                and len(node.args) == 2 and isinstance(node.args[0], ast.Constant)
                and node.args[0].value == 'reset'):
            module = ast.Call(func=ast.Name(id='__import__', ctx=ast.Load()),
                args=[ast.Constant('better_support')], keywords=[])
            adapted = ast.Call(func=ast.Attribute(value=module, attr='reset', ctx=ast.Load()),
                args=[ast.Call(func=ast.Name(id='globals', ctx=ast.Load()), args=[], keywords=[]), node.args[1]], keywords=[])
            return ast.copy_location(adapted, node)
        return node


async def host_request(payload):
    run = _RUN.get()
    if run is None:
        raise HostRejected('host callbacks are only available during an active cell')
    request_id = uuid.uuid4().hex
    request = dict(payload, id=request_id, run=run)
    if os.environ.get('BETTER_CALLBACK_URL'):
        def http_call():
            req = urllib.request.Request(os.environ['BETTER_CALLBACK_URL'],
                data=json.dumps(request, allow_nan=False).encode('utf-8'),
                headers={'Authorization': 'Bearer ' + os.environ['BETTER_CALLBACK_TOKEN'], 'Content-Type': 'application/json'})
            # Explicitly bypass consumer proxy settings for the owned loopback endpoint.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=30) as response:
                return json.load(response)
        reply = await asyncio.to_thread(http_call)
        if reply.get('ok') is not True:
            raise HostRejected(reply.get('message') or 'host request failed')
        return reply.get('result')
    loop = asyncio.get_running_loop()
    future = loop.create_future()
    with _LOCK:
        _PENDING[request_id] = (loop, future, run)
    try:
        with _WRITE_LOCK:
            _WRITER.write(json.dumps(request, allow_nan=False) + '\n')
            _WRITER.flush()
        return await future
    finally:
        with _LOCK:
            _PENDING.pop(request_id, None)


def _error_class(name, member_property):
    def init(self, message, member=None):
        Exception.__init__(self, message)
        if member is not None:
            setattr(self, member_property, member)
    return type(name, (Exception,), {'__init__': init})


def _proxy(ns, global_name, function_name, error_class, flat=False):
    async def invoke(call_args):
        try:
            return await host_request({'type': 'binding.call', 'global': global_name, 'name': function_name, 'args': call_args})
        except HostRejected as rejected:
            cls = ns.get(error_class) if error_class else None
            if cls is None:
                raise
            raise cls(str(rejected), global_name if flat else function_name) from None
    if flat:
        async def callable_binding(args=None, /):
            return await invoke({'args': [] if args is None else [args], 'kwargs': {}})
        callable_binding.__name__ = global_name
        callable_binding.__qualname__ = global_name
        return callable_binding
    async def namespace_binding(*args, **kwargs):
        if kwargs:
            raise TypeError('Better binding calls do not accept keyword arguments')
        return await invoke(args[0] if len(args) == 1 else list(args) if args else None)
    return namespace_binding


def install_bindings(ns, spec):
    for name, value in list(_INJECTED.items()):
        if ns.get(name) is value:
            ns.pop(name, None)
    _INJECTED.clear()
    classes = {}
    for global_name, config in spec.items():
        error = config.get('errorClass')
        error_name = error['name'] if error else None
        if error and error_name not in classes:
            classes[error_name] = _error_class(error_name, error['memberNameProperty'])
        if config.get('callable'):
            value = _proxy(ns, global_name, next(iter(config['functions'])), error_name, flat=True)
        else:
            def holder(global_name=global_name, config=config, error_name=error_name):
                class BindingHolder:
                    def __dir__(self):
                        return sorted(config['functions'])
                    def __getattr__(self, name):
                        return _proxy(ns, global_name, name, error_name)
                return BindingHolder()
            value = holder()
        ns[global_name] = value
        _INJECTED[global_name] = value
    ns.update(classes)
    _INJECTED.update(classes)


def complete(value, sentinel, absent=False):
    envelope = {'ok': True}
    if not absent and value is not None:
        try:
            envelope['json'] = json.dumps(value, allow_nan=False)
        except (TypeError, ValueError, OverflowError):
            envelope['json'] = json.dumps(repr(value))
    print(sentinel + json.dumps(envelope))


def _process_tree():
    """Return descendants and birth identities; no subprocess monkeypatching."""
    if os.name != 'posix':
        return {}  # Windows limitation is explicit in the delivery report.
    root = os.getpid()
    if os.path.isdir('/proc/self/task'):
        tree = {}
        visited = {root}
        pending = [root]
        while pending:
            parent = pending.pop()
            try:
                tasks = os.listdir('/proc/%d/task' % parent)
            except FileNotFoundError:
                continue
            for task in tasks:
                try:
                    with open('/proc/%d/task/%s/children' % (parent, task)) as stream:
                        children = stream.read().split()
                except FileNotFoundError:
                    continue
                for child in children:
                    pid = int(child)
                    if pid in visited:
                        continue
                    visited.add(pid)
                    identity = _process_identity(pid)
                    if identity is not None:
                        tree[pid] = identity[0]
                        pending.append(pid)
        return tree
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,stat=,lstart='],
        capture_output=True, text=True, check=True, timeout=0.03)
    rows = {}
    for line in result.stdout.splitlines():
        parts = line.split(None, 3)
        if len(parts) == 4:
            rows[int(parts[0])] = (int(parts[1]), parts[3])
    if root not in rows:
        raise RuntimeError('cannot inspect Python process tree')
    found = {root}
    changed = True
    while changed:
        changed = False
        for pid, (parent, _) in rows.items():
            if parent in found and pid not in found:
                found.add(pid)
                changed = True
    return {pid: rows[pid][1] for pid in found if pid != root}


def _process_identity(pid):
    if os.path.isdir('/proc/self/task'):
        try:
            with open('/proc/%d/stat' % pid) as stream:
                text = stream.read()
            fields = text[text.rfind(')') + 2:].split()
            return fields[19], fields[0]
        except FileNotFoundError:
            return None
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat=,lstart='],
        capture_output=True, text=True, timeout=0.02)
    parts = result.stdout.strip().split(None, 1)
    return (parts[1], parts[0]) if len(parts) == 2 else None


def _cancel_new_children(baseline):
    if baseline is None:
        raise RuntimeError('process tree baseline unavailable')
    # Capture identities before parents exit/reparent; never signal a reused PID.
    current = _process_tree()
    owned = {pid: birth for pid, birth in current.items() if baseline.get(pid) != birth}
    deadline = time.monotonic() + 0.10
    term_until = time.monotonic() + 0.025
    killed = set()
    for pid in reversed(list(owned)):
        identity = _process_identity(pid)
        if identity and identity[0] == owned[pid] and identity[1] != 'Z':
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    while True:
        # Pick up children created by a terminating descendant while its
        # parent is still visible; retain identities after reparenting.
        for pid, birth in _process_tree().items():
            if baseline.get(pid) != birth and pid not in owned:
                owned[pid] = birth
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        # Reap only this cell's direct children; earlier persistent children
        # are left to their owners. Grandchild zombies are no longer executing.
        survivors = []
        for pid, birth in owned.items():
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
            identity = _process_identity(pid)
            if identity and identity[0] == birth and not identity[1].startswith('Z'):
                survivors.append(pid)
        if not survivors:
            return
        now = time.monotonic()
        if now >= deadline:
            raise RuntimeError('cancelled descendants did not terminate')
        if now >= term_until:
            for pid in survivors:
                if pid not in killed:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    killed.add(pid)
        time.sleep(min(0.003, deadline - now))


async def run(ns, source, spec_json, sentinel):
    """Retain OMP transforms/compiler/TLA execution; adapt only typed completion."""
    runner = sys.modules['__main__']
    initialize(ns)
    spec = json.loads(spec_json)
    install_bindings(ns, spec)
    spec_token = _SPECS.set(spec)
    token = _RUN.set(runner._CURRENT_RID.get())
    baseline = None
    interrupted = False
    previous_handler = signal.getsignal(signal.SIGINT)
    def on_interrupt(signum, frame):
        nonlocal interrupted
        interrupted = True
        if callable(previous_handler):
            return previous_handler(signum, frame)
        if previous_handler != signal.SIG_IGN:
            return signal.default_int_handler(signum, frame)
    signal.signal(signal.SIGINT, on_interrupt)
    try:
        try:
            baseline = _process_tree()
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        transformed = runner.transform_cell(source)
        tree = ResetAdapter().visit(ast.parse(transformed or 'pass', '<cell>', 'exec'))
        # OMP owns compilation and execution. Wrapping its final expression only
        # changes the display boundary to the existing lossless JSON contract.
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = tree.body[-1]
            call = ast.Call(func=ast.Attribute(value=ast.Call(func=ast.Name(id='__import__', ctx=ast.Load()),
                args=[ast.Constant('better_support')], keywords=[]), attr='complete', ctx=ast.Load()),
                args=[expression.value, ast.Constant(sentinel)], keywords=[])
            tree.body[-1] = ast.copy_location(ast.Expr(value=call), expression)
        else:
            tree.body.append(ast.Expr(value=ast.Call(func=ast.Attribute(value=ast.Call(func=ast.Name(id='__import__', ctx=ast.Load()),
                args=[ast.Constant('better_support')], keywords=[]), attr='complete', ctx=ast.Load()),
                args=[ast.Constant(None), ast.Constant(sentinel)], keywords=[ast.keyword(arg='absent', value=ast.Constant(True))])))
        ast.fix_missing_locations(tree)
        await runner._exec_source_async(ast.unparse(tree), ns)
    except KeyboardInterrupt:
        interrupted = True
        raise
    finally:
        if interrupted:
            # User code may catch KeyboardInterrupt itself. Receipt tracking
            # still makes cancellation clean current foreground descendants.
            # The host's confirm SIGINT cannot interrupt cleanup.
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            try:
                _cancel_new_children(baseline)
            except BaseException:
                # Host observes death and sweeps group before queue admission.
                os._exit(130)
        signal.signal(signal.SIGINT, previous_handler)
        _RUN.reset(token)
        _SPECS.reset(spec_token)
        # A detached Python task must not gain admission after its cell ended.
        with _LOCK:
            pending = [item for item in _PENDING.values() if item[2] == runner._CURRENT_RID.get()]
        for loop, future, _ in pending:
            if not future.done():
                future.cancel()


def user_namespace(ns):
    return {name: value for name, value in ns.items()
        if not name.startswith('__omp_') and name not in ('__name__', '__doc__', '__builtins__')
        and not (name in _OWNED and _OWNED[name] is value)
        and not (name in _INJECTED and _INJECTED[name] is value)}


def query(ns, name_json, sentinel):
    user = user_namespace(ns)
    name = json.loads(name_json)
    if name is None:
        reply = {'ok': True, 'kind': 'names', 'names': sorted(user)}
    elif name not in user:
        reply = {'ok': True, 'kind': 'missing'}
    else:
        try:
            reply = {'ok': True, 'kind': 'json', 'text': json.dumps(user[name], allow_nan=False)}
        except (TypeError, ValueError, OverflowError):
            reply = {'ok': True, 'kind': 'repr', 'text': repr(user[name])}
    print(sentinel + json.dumps(reply))


def set_var(ns, name, value_json, sentinel):
    ns[name] = json.loads(value_json)
    print(sentinel + json.dumps({'ok': True}))


def owned_objects():
    return list(_OWNED.values()) + list(_INJECTED.values())

def reserved_names():
    return set(_OWNED) | set(_INJECTED)


def injected_names():
    return set(_INJECTED)
