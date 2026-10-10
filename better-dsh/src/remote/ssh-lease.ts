import { shQuote } from './transports.ts'

/** Portable, transient recovery gate. The flock is inherited by the supervised cohort,
 * so a wrapper exit alone cannot certify descendant release. No persistent tombstone. */
export const SSH_RECOVERY_HELPER = String.raw`import fcntl, json, os, signal, stat, subprocess, sys, tempfile, time
role=sys.argv[1];args=json.loads(sys.argv[2])
if sys.version_info<(3,7) or (sys.platform=='darwin' and sys.version_info<(3,10)):
    raise RuntimeError('SSH recovery requires Python3.7+ (macOS3.10+) shared cross-process monotonic clock and Unix fcntl.flock')
info=time.get_clock_info('monotonic')
if not info.monotonic or info.adjustable or not hasattr(fcntl,'flock'):
    raise RuntimeError('SSH recovery requires shared non-adjustable monotonic clock and Unix fcntl.flock')
def now():return time.monotonic_ns()//1000000
if role=='recovery-clock':
    print(json.dumps({'tick':now(),'base':tempfile.gettempdir()}),flush=True);sys.exit(0)
root=args['root'];cutoff=args['cutoff'];since=args['since'];token=args['token']
if type(cutoff) is not int or type(since) is not int or cutoff!=since+8000 or now()<since:
    raise RuntimeError('invalid recovery clock epoch/entry fence')
stopped=False
def stop(sig,frame):
    global stopped
    stopped=True
for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT):signal.signal(sig,stop)
def gate():
    try:os.mkdir(root,0o700)
    except FileExistsError:pass
    directory=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    st=os.fstat(directory)
    if st.st_uid!=os.getuid() or stat.S_IMODE(st.st_mode)!=0o700:
        os.close(directory);raise RuntimeError('unsafe rsync recovery owner directory')
    fd=os.open('lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=directory)
    st=os.fstat(fd)
    if st.st_uid!=os.getuid() or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode)!=0o600:
        os.close(fd);os.close(directory);raise RuntimeError('unsafe rsync recovery lock')
    return directory,fd
def current(directory,fd):
    try:
        a=os.stat(root,follow_symlinks=False);b=os.fstat(directory)
        c=os.stat('lock',dir_fd=directory,follow_symlinks=False);d=os.fstat(fd)
        return (a.st_dev,a.st_ino)==(b.st_dev,b.st_ino) and (c.st_dev,c.st_ino)==(d.st_dev,d.st_ino)
    except FileNotFoundError:return False
def remove(directory,fd):
    if not current(directory,fd):return
    for name in ('cancel','lock'):
        try:os.unlink(name,dir_fd=directory)
        except FileNotFoundError:pass
    os.rmdir(root)
def cancelled(directory):
    try:os.stat('cancel',dir_fd=directory,follow_symlinks=False);return True
    except FileNotFoundError:return False
if role=='recovery-run':
    while not stopped and now()<cutoff:
        directory=fd=None;child=None
        try:
            directory,fd=gate()
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:sys.stderr.write('recovery-run: gate entry fenced, token already owned\n');sys.exit(125) # observer/owner already fenced this unique token
            if not current(directory,fd):continue
            if stopped or now()>=cutoff or cancelled(directory):
                sys.stderr.write('recovery-run: gate entry fenced stopped=%s cutoff-reached=%s cancelled=%s\n'%(stopped,now()>=cutoff,cancelled(directory)));sys.exit(125)
            command=args['command'];command=command if command.startswith('exec ') else 'exec '+command
            # The dead original SSH channel must never block cancellation/cleanup.
            # Preserve binary output normally, bounded to 512KiB/channel; once
            # cancelled, drain/discard it so even terminal cleanup writes finish.
            for output in (1,2):os.set_blocking(output,False)
            child=subprocess.Popen(['bash','-c',command],pass_fds=(fd,),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            streams={1:child.stdout,2:child.stderr};pending={1:bytearray(),2:bytearray()};sent=False
            phase=None;deadline=None;incoming=bytearray();forward=bytearray();tail=bytearray()
            prepared=('__SUPERD_RSYNC_'+token+'_PREPARED__\n').encode()
            cleaned=('__SUPERD_RSYNC_'+token+'_CLEANED__\n').encode()
            os.set_blocking(0,False);os.set_blocking(child.stdin.fileno(),False)
            for stream in streams.values():os.set_blocking(stream.fileno(),False)
            while True:
                # This gate is itself an owner, including after the inner child
                # exits. Anchor BEFORE forwarding PREPARED; KEEP adds only the
                # same fixed step already counted before origin dispatch.
                if deadline is not None and now()>=deadline:stopped=True
                if not stopped:
                    try:control=os.read(0,4096)
                    except BlockingIOError:control=None
                    if control==b'':stopped=True
                    elif control:
                        incoming.extend(control)
                        if len(incoming)+len(forward)>65536:stopped=True
                        while not stopped and b'\n' in incoming:
                            line,rest=incoming.split(b'\n',1);incoming=bytearray(rest);tick=now()
                            if deadline is None or tick>=deadline:stopped=True
                            elif line==b'START' and phase=='prepared':phase='active'
                            elif line==b'KEEP' and phase=='active':deadline=min(deadline+2000,tick+8000)
                            else:stopped=True
                            if not stopped:forward.extend(line+b'\n')
                    if forward and not child.stdin.closed:
                        try:count=os.write(child.stdin.fileno(),forward);del forward[:count]
                        except BlockingIOError:pass
                        except BrokenPipeError:child.stdin.close();forward.clear()
                    if child.stdin.closed:forward.clear()
                discard=stopped or cancelled(directory)
                if discard:
                    stopped=True;tail.clear();forward.clear();incoming.clear()
                    for data in pending.values():data.clear()
                    if not sent and child.poll() is None:
                        try:child.terminate()
                        except ProcessLookupError:pass
                        sent=True
                progress=False
                for output,stream in list(streams.items()):
                    for _ in range(8):
                        room=65536 if discard else min(65536,524288-len(pending[output])-(len(tail) if output==2 else 0))
                        if not room:break
                        try:data=os.read(stream.fileno(),room)
                        except BlockingIOError:break
                        if not data:
                            stream.close();del streams[output]
                            if output==2 and not discard:pending[2].extend(tail);tail.clear()
                            break
                        progress=True
                        if discard:continue
                        if output==1:pending[1].extend(data);continue
                        # Streaming marker recognition retains only a possible
                        # marker prefix. The inner CLEANED is not gate cleanup.
                        tail.extend(data)
                        while tail:
                            hits=[(tail.find(mark),mark) for mark in (prepared,cleaned) if tail.find(mark)>=0]
                            if hits:
                                index,mark=min(hits,key=lambda item:item[0]);pending[2].extend(tail[:index]);del tail[:index+len(mark)]
                                if mark==prepared:
                                    if phase is None:phase='prepared';deadline=now()+8000
                                    pending[2].extend(mark)
                            else:
                                keep=max([n for mark in (prepared,cleaned) for n in range(1,min(len(tail),len(mark)-1)+1) if tail[-n:]==mark[:n]] or [0])
                                count=len(tail)-keep;pending[2].extend(tail[:count]);del tail[:count];break
                if not discard:
                    for output,data in pending.items():
                        if not data:continue
                        try:
                            count=os.write(output,data);del data[:count];progress=True
                        except BlockingIOError:pass
                        except OSError:stopped=True;break
                if child.poll() is not None and not streams and not any(pending.values()):break
                if not progress:time.sleep(.01)
            status=child.wait();child.stdin.close()
            remove(directory,fd);os.close(fd);os.close(directory);fd=directory=None
            # Only the post-cohort, post-pipe, post-lock release is an ACK.
            # A lost/full old channel may lose this receipt, never hold cleanup.
            try:os.write(2,cleaned)
            except OSError:pass
            sys.exit(125 if stopped else status if status>=0 else 128-status)
        finally:
            # Never remove ownership while a child remains. Its inherited lock also
            # survives abrupt wrapper death, until the existing supervisor reaps it.
            if child is None and directory is not None and fd is not None and current(directory,fd):
                # A different owner may hold this file: only a held exclusive lock permits removal.
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);remove(directory,fd)
                except BlockingIOError:pass
            if fd is not None:os.close(fd)
            if directory is not None:os.close(directory)
    if not stopped:sys.stderr.write('recovery-run: session ended before cutoff without a signal\n')
    sys.exit(125)
elif role=='recovery-lock':
    directory=fd=None
    try:
        while not stopped and now()<cutoff:
            directory,fd=gate()
            try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError('rsync recovery entry already owned or cancelled')
            if current(directory,fd) and now()<cutoff and not cancelled(directory):break
            remove(directory,fd);os.close(fd);os.close(directory);directory=fd=None
        if directory is None:raise RuntimeError('rsync recovery entry closed; no controller admitted')
    except BaseException:
        if fd is not None:os.close(fd)
        if directory is not None:os.close(directory)
        raise
elif role=='recovery-observe':
    while True:
        directory=fd=None
        try:
            directory,fd=gate()
            cancel=os.open('cancel',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=directory);os.close(cancel)
            while True:
                try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);break
                except BlockingIOError:time.sleep(.05)
            if not current(directory,fd):continue
            # No active cohort holds the lock. Preserve cancellation against an
            # original exec request that has not entered its gate yet.
            while now()<cutoff:time.sleep(.05)
            remove(directory,fd)
            break
        except FileNotFoundError:continue
        finally:
            if fd is not None:os.close(fd)
            if directory is not None:os.close(directory)
    print('__SUPERD_RSYNC_'+token+'_CLEANED__',flush=True)
else:raise RuntimeError('unknown rsync recovery role')
`
export const recoveryHelperCommand = (role: string, args: Record<string, unknown> = {}) =>
  'exec python3 -u -c ' + shQuote(SSH_RECOVERY_HELPER) + ' ' + shQuote(role) + ' ' + shQuote(JSON.stringify(args))

/** One receiving helper: portable monotonic clock; Linux only for owned -R transport. */
export const SSH_LEASE_HELPER = String.raw`import json, os, selectors, signal, subprocess, sys, time
role=sys.argv[1]
args=json.loads(sys.argv[2]) if len(sys.argv)>2 else {}
if sys.version_info<(3,7):raise RuntimeError('SSH ownership requires Python3.7+ monotonic_ns')
info=time.get_clock_info('monotonic')
if not info.monotonic or info.adjustable:
    raise RuntimeError('SSH ownership requires a non-adjustable monotonic Python clock')
last=0
def now():
    global last
    value=time.monotonic_ns()//1000000
    if not isinstance(value,int) or value<last or value<0:
        raise RuntimeError('invalid monotonic SSH clock; admission closed')
    last=value
    return value

def clock_pipe(leased):
    selector=selectors.DefaultSelector()
    for fd in ([0,3] if leased else [0]):
        os.set_blocking(fd,False);selector.register(fd,selectors.EVENT_READ)
    buffers={0:b'',3:b''};phase='prepared';deadline=now()+8000;count=0
    while True:
        if leased and now()>=deadline:phase='closed'
        for key,events in selector.select(.05):
            fd=key.fd;data=os.read(fd,4096)
            if not data:
                if fd==0:return
                phase='closed';selector.unregister(fd);continue
            buffers[fd]+=data
            if len(buffers[fd])>65536:raise RuntimeError('rsync lease input too large')
            while b'\n' in buffers[fd]:
                line,buffers[fd]=buffers[fd].split(b'\n',1);tick=now()
                if fd==0:
                    if line!=b'QUERY':raise RuntimeError('invalid clock query')
                    if leased:
                        if tick>=deadline:phase='closed'
                        print(tick,deadline,count,phase,flush=True)
                    else:print(tick,flush=True)
                elif tick>=deadline:phase='closed'
                elif line==b'START' and phase=='prepared':phase='active'
                elif line==b'KEEP' and phase=='active':deadline=min(deadline+2000,tick+8000);count+=1
                else:phase='closed'

def native_command():
    # fd0 is exclusively the user's literal stdin. Control lives in the separate owner SSH.
    owner=args['directory'];active=owner+'/active';record=owner+'/server.'+str(os.getpid())
    child=None;stopped=False;status=125
    subreaper=args.get('subreaper',False)
    if subreaper:
        # Containers can have a non-reaping PID1: own adopted descendants ourselves.
        import ctypes
        if sys.platform!='linux':raise RuntimeError('container command ownership requires Linux PR_SET_CHILD_SUBREAPER')
        libc=ctypes.CDLL(None,use_errno=True)
        if libc.prctl(36,1,0,0,0)!=0:raise OSError(ctypes.get_errno(),'container PR_SET_CHILD_SUBREAPER denied before work admission')
    def reap():
        if not subreaper:return
        # Popen retains its direct-child status; waitpid only after it is collected.
        child.poll()
        if child.returncode is None:return
        while True:
            try:
                pid,status=os.waitpid(-1,os.WNOHANG)
                if pid==0:return
            except ChildProcessError:return
    def stop(signum,frame):
        nonlocal stopped
        stopped=True
    for sig in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT):signal.signal(sig,stop)
    def registered(group):
        with open(record,'w') as f:f.write('%s %s 0\n'%(os.getpid(),group))
    def lease():
        with open(owner+'/lease') as f:values=f.read(128).split()
        if len(values)!=2:raise RuntimeError('invalid SSH command lease')
        remaining,count=map(int,values)
        if remaining<=0 or remaining>8000 or count<0:raise RuntimeError('invalid SSH command lease')
        return remaining,count
    def group_live():
        reap()
        try:os.killpg(child.pid,0);return True
        except ProcessLookupError:return False
    try:
        # No child/clock/IPC is created before the sideband admission fences.
        if stopped or not os.path.isfile(active):
            sys.stderr.write('native-command admission closed before spawn: signal=%s owner=%s owner-dir=%s owner-active=%s\n'%(stopped,owner,os.path.isdir(owner),os.path.isfile(active)));return 125
        registered(0)
        if stopped or not os.path.isfile(active):
            sys.stderr.write('native-command admission closed after registration: signal=%s owner-active=%s\n'%(stopped,os.path.isfile(active)));return 125
        remaining,seen=lease();deadline=now()+remaining
        if stopped or not os.path.isfile(active) or now()>=deadline:
            sys.stderr.write('native-command admission closed before child: signal=%s owner-active=%s lease-expired=%s\n'%(stopped,os.path.isfile(active),now()>=deadline));return 125
        child=subprocess.Popen(args['argv'],stdin=0,stdout=1,stderr=2,start_new_session=True)
        registered(child.pid)
        while True:
            status=child.poll()
            if status is not None:break
            if stopped or not os.path.isfile(active) or now()>=deadline:
                status=125
                if not stopped:sys.stderr.write('native-command admission closed while running without signal: owner-active=%s lease-expired=%s child=%s\n'%(os.path.isfile(active),now()>=deadline,child.pid))
                break
            remaining,count=lease()
            if count<seen:raise RuntimeError('SSH command lease count regressed')
            deadline=min(deadline+(count-seen)*2000,now()+8000);seen=count
            time.sleep(.02)
        return status if status>=0 else 128-status
    finally:
        if child is not None:
            try:os.killpg(child.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            end=now()+200
            while now()<end:
                child.poll()
                if not group_live():break
                time.sleep(.01)
            try:os.killpg(child.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            child.wait()
            while group_live():time.sleep(.01)

if role=='clock':clock_pipe(False)
elif role=='lease-clock':clock_pipe(True)
elif role=='native-command':sys.exit(native_command())
elif role=='preflight':now()
else:raise RuntimeError('unknown rsync ownership helper role')
`

export const leaseHelperCommand = (role: string, args: Record<string, unknown> = {}) =>
  'exec python3 -u -c ' + shQuote(SSH_LEASE_HELPER) + ' ' + shQuote(role) + ' ' + shQuote(JSON.stringify(args))

