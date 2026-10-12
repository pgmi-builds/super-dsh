"""Best-effort checkpoints for the owned OMP namespace; dill 0.4.1 adapter.

No cell history is stored/replayed. Pickling user objects is not a sandbox:
reducers may execute arbitrary code. Host deadlines bound helper execution.
"""
import _thread
import asyncio
import dis
import functools
import hashlib
import io
import json
import os
import platform
import re
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import types
import uuid

# Select the unchanged packaged implementation before ANY user cell can import dill.
_VENDOR = os.path.join(os.path.dirname(__file__), 'vendor')
sys.path.insert(0, _VENDOR)
import dill
if dill.__version__ != '0.4.1' or os.path.realpath(dill.__file__) != os.path.realpath(os.path.join(_VENDOR, 'dill', '__init__.py')):
    raise RuntimeError('Better requires its packaged dill 0.4.1')

_DIRECTORY = None
_CAP = None
_TIMEOUT = 30.0
_FORMAT = 2
_RESOURCES = (io.IOBase, _thread.LockType, type(threading.RLock()), socket.socket,
    subprocess.Popen, threading.Thread, sqlite3.Connection, sqlite3.Cursor,
    asyncio.Future, asyncio.AbstractEventLoop, types.GeneratorType,
    types.CoroutineType, types.AsyncGeneratorType)
_PRIMITIVES = (str, bytes, int, float, bool, type(None))


class UnsupportedResource(Exception):
    pass


class SizeCap(Exception):
    pass


class NamespaceProxy:
    pass


def _proxy(ns):
    proxy = NamespaceProxy()
    proxy.__dict__ = ns
    return proxy


def configure(directory, cap, timeout_ms):
    global _DIRECTORY, _CAP, _TIMEOUT
    _DIRECTORY = os.path.abspath(directory) if directory else None
    _CAP = cap
    _TIMEOUT = timeout_ms / 1000.0 * 0.9


def clear():
    """Delete only our fixed manifest and generation files, including orphans."""
    if _DIRECTORY and os.path.islink(_DIRECTORY):
        raise ValueError('checkpoint directory cannot be a symlink')
    if not _DIRECTORY or not os.path.isdir(_DIRECTORY):
        return
    for name in os.listdir(_DIRECTORY):
        if name == 'manifest.json' or re.fullmatch(r'(state-[0-9a-f]{32}\.dill|\.checkpoint-[0-9a-f]{32}\.tmp)', name):
            os.unlink(os.path.join(_DIRECTORY, name))


def _paths(payload_path, manifest_path):
    if not _DIRECTORY or os.path.abspath(manifest_path) != os.path.join(_DIRECTORY, 'manifest.json') or os.path.abspath(payload_path) != os.path.join(_DIRECTORY, 'state.dill'):
        raise ValueError('checkpoint paths are not the configured session directory')
    os.makedirs(_DIRECTORY, mode=0o700, exist_ok=True)
    if os.path.islink(_DIRECTORY):
        raise ValueError('checkpoint directory cannot be a symlink')
    if os.path.islink(manifest_path):
        raise ValueError('checkpoint manifest cannot be a symlink')
    os.chmod(_DIRECTORY, 0o700)


def _environment():
    return dict(pythonVersion=platform.python_version(), implementation=platform.python_implementation(),
        interpreter=os.path.realpath(sys.executable), venvPath=sys.prefix,
        environmentHash=hashlib.sha256(json.dumps([sys.prefix, sys.base_prefix, sys.path], sort_keys=True).encode()).hexdigest(),
        dillVersion=dill.__version__, protocol=4, skills=[])


def _guard(ns):
    import better_support
    owned = [sys.modules['__main__'], sys.modules['better_support'], sys.modules[__name__]]
    owned.extend(better_support.owned_objects())
    denied = {id(value) for value in owned if not isinstance(value, _PRIMITIVES)}
    def guard(value):
        if id(value) in denied or (isinstance(value, (types.FunctionType, type)) and getattr(value, '__module__', None) in ('better_support', 'better_snapshot')) or type(value).__module__ == 'better_support':
            raise UnsupportedResource('captured Better/runner binding')
        if isinstance(value, _RESOURCES):
            raise UnsupportedResource('unsupported live resource ' + type(value).__name__)
        return None
    return guard


class CappedBuffer(io.BytesIO):
    def __init__(self, cap):
        super().__init__()
        self.cap = cap
    def write(self, value):
        if self.tell() + len(value) > self.cap:
            raise SizeCap('serialized graph exceeds snapshotSizeCapBytes')
        return super().write(value)


def _encode(ns, values, cap, guard):
    output = CappedBuffer(cap)
    # Exact Pickler: subclassing disables pinned dill's main-module logic.
    pickler = dill.Pickler(output, protocol=4, recurse=False, byref=False)
    pickler._main = _proxy(ns)
    pickler._original_main = pickler._main
    pickler._main_modified = True
    pickler.persistent_id = guard
    pickler.dump(values)
    return output.getvalue()


def _decode(ns, payload):
    unpickler = dill.Unpickler(io.BytesIO(payload))
    unpickler._main = _proxy(ns)
    unpickler._ignore = True
    return unpickler.load()


def _dependencies(root, ns):
    """Bounded static global scan; dynamic eval/globals lookups remain best effort."""
    found, seen = set(), set()
    def walk(value):
        if id(value) in seen or isinstance(value, _PRIMITIVES):
            return
        seen.add(id(value))
        if len(seen) > 10000:
            raise UnsupportedResource('dependency graph exceeds inspection budget')
        if isinstance(value, types.FunctionType):
            if value.__globals__ is ns:
                def code_names(code):
                    for op in dis.get_instructions(code):
                        if op.opname in ('LOAD_GLOBAL', 'LOAD_NAME'):
                            found.add(op.argval)
                    for item in code.co_consts:
                        if isinstance(item, types.CodeType): code_names(item)
                code_names(value.__code__)
            walk(value.__defaults__)
            walk(value.__kwdefaults__)
            for cell in value.__closure__ or ():
                try: walk(cell.cell_contents)
                except ValueError: pass
        elif isinstance(value, functools.partial):
            walk(value.func); walk(value.args); walk(value.keywords); walk(vars(value))
        elif isinstance(value, (staticmethod, classmethod)):
            walk(value.__func__)
        elif isinstance(value, property):
            walk(value.fget); walk(value.fset); walk(value.fdel)
        elif isinstance(value, types.MethodType):
            walk(value.__func__); walk(value.__self__)
        elif isinstance(value, dict):
            for key, item in value.items(): walk(key); walk(item)
        elif isinstance(value, (tuple, list, set, frozenset)):
            for item in value: walk(item)
        elif isinstance(value, type):
            if value.__module__ == ns.get('__name__'):
                for item in vars(value).values(): walk(item)
                for base in value.__bases__: walk(base)
        elif not isinstance(value, types.ModuleType) and type(value).__module__ == ns.get('__name__'):
            walk(type(value))
            if hasattr(value, '__dict__'): walk(vars(value))
            # Scan descriptors across the MRO, including inherited/mangled slots.
            for owner in type(value).__mro__:
                for descriptor in vars(owner).values():
                    if isinstance(descriptor, types.MemberDescriptorType):
                        try: walk(descriptor.__get__(value, type(value)))
                        except AttributeError: pass  # uninitialized slot
    walk(root)
    return found


def _write_new(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())


def _emit(sentinel, result):
    print(sentinel + json.dumps(result, ensure_ascii=True))


def _retained_payloads(manifest_path):
    try:
        with open(manifest_path, encoding='utf-8') as source:
            manifest = json.load(source)
    except (FileNotFoundError, ValueError):
        return set(), None
    if not isinstance(manifest, dict):
        return set(), None
    current = manifest.get('payload')
    names = (current, manifest.get('previousPayload'))
    retained = {name for name in names if isinstance(name, str) and re.fullmatch(r'state-[0-9a-f]{32}\.dill', name)}
    return retained, current if isinstance(current, str) and current in retained else None


def _scavenge(retained):
    for name in os.listdir(_DIRECTORY):
        if name not in retained and re.fullmatch(r'(state-[0-9a-f]{32}\.dill|\.checkpoint-[0-9a-f]{32}\.tmp)', name):
            os.unlink(os.path.join(_DIRECTORY, name))


def save(ns, payload_path, manifest_path, spec_json, sentinel):
    attempt_paths, committed, result = [], False, None
    payload_name, manifest, retained = None, None, set()
    try:
        _paths(payload_path, manifest_path)
        retained, previous = _retained_payloads(manifest_path)
        _scavenge(retained)  # collect killed-writer artifacts even if this attempt fails
        deadline = time.monotonic() + _TIMEOUT
        def check_deadline():
            if time.monotonic() >= deadline:
                raise TimeoutError('checkpoint deadline exceeded; previous generation retained')
        spec = json.loads(spec_json)
        cap = min(spec['sizeCapBytes'], _CAP)
        import better_support
        candidates = better_support.user_namespace(ns)
        guard = _guard(ns)
        kept, omitted, dependencies = {}, {}, {}
        for name, value in candidates.items():
            check_deadline()
            try:
                _encode(ns, {name: value}, cap, guard)
                dependencies[name] = _dependencies(value, ns)
                kept[name] = value
            except SizeCap:
                raise
            except Exception as error:
                omitted[name] = type(error).__name__ + ': ' + str(error)
        changed = True
        while changed:
            changed = False
            for name in list(kept):
                missing = dependencies[name].intersection(omitted)
                if missing:
                    omitted[name] = 'depends on omitted globals: ' + ', '.join(sorted(missing))
                    del kept[name]
                    changed = True
        check_deadline()
        payload = _encode(ns, kept, cap, guard)
        # Verify the FINAL shared graph, never independently reconstruct values.
        trial_ns = dict(ns)
        trial = _decode(trial_ns, payload)
        if not isinstance(trial, dict) or set(trial) != set(kept):
            raise ValueError('final graph round-trip changed admitted names')
        trial_ns.update(trial)
        groups = {}
        for name, value in kept.items():
            if id(value) in groups and trial[name] is not trial[groups[id(value)]]:
                raise ValueError('final graph round-trip lost shared root identity')
            groups[id(value)] = name
        token = uuid.uuid4().hex
        payload_name = 'state-' + token + '.dill'
        manifest = dict(_environment(), snapshotFormat=_FORMAT, turn=spec['turn'],
            payload=payload_name, previousPayload=previous, sizeBytes=len(payload), sha256=hashlib.sha256(payload).hexdigest(),
            names=sorted(kept), dependencies={name: sorted(dependencies[name]) for name in kept},
            bindingNames=sorted(better_support.injected_names()), omitted=omitted, coverage='partial' if omitted else 'best-effort',
            skipped=False, limitations=['Dynamic globals/eval and arbitrary extension resources cannot be exhaustively inspected.'])
        payload_file = os.path.join(_DIRECTORY, payload_name)
        attempt_paths.append(payload_file)
        _write_new(payload_file, payload)
        temp = os.path.join(_DIRECTORY, '.checkpoint-' + token + '.tmp')
        attempt_paths.append(temp)
        _write_new(temp, json.dumps(manifest, sort_keys=True).encode())
        # Sole commit point. Cleanup must never remove this payload afterwards.
        check_deadline()
        os.replace(temp, manifest_path)
        committed = True
        result = dict(kind='ok', sizeBytes=len(payload), names=manifest['names'], omitted=omitted, turn=spec['turn'])
        warnings = []
        if os.name == 'posix':
            try:
                fd = os.open(_DIRECTORY, os.O_RDONLY)
                try: os.fsync(fd)
                finally: os.close(fd)
            except OSError as error:
                warnings.append('directory fsync failed: ' + str(error))
        try:
            _scavenge({payload_name, previous})
        except OSError as error:
            warnings.append('stale artifact cleanup failed: ' + str(error))
        if warnings:
            result['warning'] = 'checkpoint committed; ' + '; '.join(warnings)
    except SizeCap as error:
        result = dict(kind='skipped', reason=str(error), capBytes=_CAP)
    except Exception as error:
        reason = type(error).__name__ + ': ' + str(error)
        if payload_name is not None and not committed:
            try:
                _, pointed = _retained_payloads(manifest_path)
                committed = pointed == payload_name
            except OSError:
                pass
        if committed:
            result = dict(kind='ok', sizeBytes=len(payload), names=manifest['names'], omitted=omitted, turn=spec['turn'])
            result['warning'] = 'checkpoint committed; postcommit finalization failed: ' + reason
        else:
            result = dict(kind='failed', reason=reason)
    finally:
        if not committed and attempt_paths:
            # A signal/error can arrive immediately after replace, before the
            # local flag changes. The pointer is authoritative for deletion.
            try:
                latest, _ = _retained_payloads(manifest_path)
                retained.update(latest)
            except OSError:
                # Cannot prove non-commit: leave recognized artifacts for the
                # next save's pre-write scavenger rather than risk data loss.
                retained.update(os.path.basename(path) for path in attempt_paths)
            for path in attempt_paths:
                if os.path.basename(path) in retained:
                    continue
                try: os.unlink(path)
                except FileNotFoundError: pass
                except OSError as error:
                    if result is not None:
                        result['reason'] += '; uncommitted artifact cleanup failed: ' + str(error)
    if result is not None:
        _emit(sentinel, result)


def restore(ns, payload_path, manifest_path, sentinel, bindings_json):
    try:
        _paths(payload_path, manifest_path)
        if os.path.getsize(manifest_path) > 1048576:
            raise ValueError('manifest exceeds metadata cap')
        with open(manifest_path, encoding='utf-8') as source:
            manifest = json.load(source)
        if not isinstance(manifest, dict) or manifest.get('snapshotFormat') != _FORMAT:
            raise ValueError('unsupported snapshot format')
        for key, value in _environment().items():
            if manifest.get(key) != value: raise ValueError('checkpoint environment mismatch: ' + key)
        name = manifest.get('payload', '')
        if not isinstance(name, str) or not re.fullmatch(r'state-[0-9a-f]{32}\.dill', name):
            raise ValueError('invalid owned payload name')
        names = manifest.get('names')
        import better_support
        if not isinstance(names, list) or any(not isinstance(n, str) or n.startswith('__omp_') or n in ('__name__', '__builtins__', '__doc__') for n in names):
            raise ValueError('invalid checkpoint namespace names')
        turn = manifest.get('turn')
        if not isinstance(turn, int) or isinstance(turn, bool) or turn < 0:
            raise ValueError('invalid checkpoint turn')
        path = os.path.join(_DIRECTORY, name)
        size = os.path.getsize(path)
        if os.path.islink(path) or size != manifest.get('sizeBytes') or size > _CAP:
            raise ValueError('payload size/cap/path validation failed')
        with open(path, 'rb') as source: payload = source.read(_CAP + 1)
        if hashlib.sha256(payload).hexdigest() != manifest.get('sha256'):
            raise ValueError('payload integrity hash mismatch')
        values = _decode(ns, payload)
        if not isinstance(values, dict) or sorted(values) != sorted(names):
            raise ValueError('payload namespace differs from manifest')
        omitted = dict(manifest.get('omitted', {}))
        unavailable = set(manifest.get('bindingNames', [])) - set(json.loads(bindings_json))
        dependencies = manifest.get('dependencies', {})
        changed = True
        while changed:
            changed = False
            for root in list(values):
                missing_bindings = set(dependencies.get(root, [])).intersection(unavailable)
                missing_state = set(dependencies.get(root, [])).intersection(omitted)
                if missing_bindings or missing_state:
                    omitted[root] = ('missing current host binding: ' + ', '.join(sorted(missing_bindings))) if missing_bindings else ('depends on omitted globals: ' + ', '.join(sorted(missing_state)))
                    del values[root]
                    changed = True
        ns.update(values)
        _emit(sentinel, dict(kind='restored', count=len(values), turn=turn, names=names,
            omitted=omitted))
    except Exception as error:
        _emit(sentinel, dict(kind='degraded', reason=type(error).__name__ + ': ' + str(error)))
