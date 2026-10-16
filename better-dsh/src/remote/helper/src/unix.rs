// Unix platform implementation: setsid isolation, PDEATHSIG kernel anchoring (Linux),
// process-group supervision, starttime sidecar, zombie-aware drain detection.
// Semantics mirror the POSIX wrapper in better-dsh/src/remote/transports.ts; no upgrades:
//  - normal completion: group TERM against leftover descendants (fire-and-forget),
//    pidfile pair removed, child exit status passed through verbatim;
//  - TERM/HUP/INT (incl. PDEATHSIG on parent death): group TERM, bounded direct-child
//    reap (KILL escalate by pid only — group-wide KILL belongs to the killer session);
//  - killgroup runs OUTSIDE the target group: TERM → bounded live-drain → group KILL.
use std::fs;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::sleep;
use std::time::{Duration, Instant};

use crate::{pidfile_from, usage};

const PR_SET_PDEATHSIG: i32 = 1;
const SIGHUP: i32 = 1;
const SIGINT: i32 = 2;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;
const CANCEL_CHILD_SETTLE_MS: u64 = 2000;
const KILLGROUP_DRAIN_MS: u64 = 3000;
const KILLGROUP_KILL_SETTLE_MS: u64 = 500;

static TERMINATING: AtomicBool = AtomicBool::new(false);
static FINALIZING: AtomicBool = AtomicBool::new(false);

extern "C" {
    fn setsid() -> i32;
    fn getpgrp() -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
    fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
    #[cfg(target_os = "linux")]
    fn prctl(op: i32, arg2: usize, arg3: usize, arg4: usize, arg5: usize) -> i32;
}

extern "C" fn on_terminate(_sig: i32) {
    if !FINALIZING.load(Ordering::Relaxed) {
        TERMINATING.store(true, Ordering::Relaxed);
    }
}

fn install_handlers() {
    for sig in [SIGTERM, SIGHUP, SIGINT] {
        unsafe { signal(sig, on_terminate) };
    }
}

fn group_signal(pgid: i32, sig: i32) -> bool {
    unsafe { kill(-pgid, sig) == 0 }
}

fn group_alive(pgid: i32) -> bool {
    unsafe { kill(-pgid, 0) == 0 }
}

/// Live (non-zombie) members of the group. Zombies still answer kill(-pgid, 0): a helper
/// that exited after TERM stays a zombie until its own parent reaps it — typically the
/// very shell that is busy waiting on this killgroup. Counting zombies made drain
/// detection permanently false and caused pointless SIGKILL escalation (lane-matrix
/// alpine, 2026-10-14). On Linux we scan /proc; elsewhere we accept the kill-check.
fn group_has_live(pgid: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = match name.to_str() {
                    Some(n) => n,
                    None => continue,
                };
                let pid: i32 = match name.parse() {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
                let Some(tail) = stat.rsplit(')').next() else { continue };
                let mut fields = tail.split_whitespace();
                let state = fields.next().unwrap_or("");
                let _ppid = fields.next();
                let Some(pgrp) = fields.next() else { continue };
                if pgrp == pgid.to_string().as_str() && state != "Z" && state != "X" {
                    return true;
                }
            }
        }
        return false;
    }
    #[cfg(not(target_os = "linux"))]
    {
        group_alive(pgid)
    }
}

/// Only meaningful from OUTSIDE the group (killgroup session).
fn wait_group_drain(pgid: i32, budget_ms: u64) -> bool {
    let start = Instant::now();
    while group_has_live(pgid) {
        if start.elapsed() >= Duration::from_millis(budget_ms) {
            return false;
        }
        sleep(Duration::from_millis(20));
    }
    true
}

/// Kernel start time of a process (Linux /proc stat field 22). Identity of the supervised
/// group: a stale pidfile whose pgid was later reused by an unrelated process must never
/// make killgroup signal strangers — same failure class as the 2026-10-13 kill(-1)
/// incident, one level down. Sidecar is optional: shim-written pidfiles skip the check.
#[cfg(target_os = "linux")]
fn proc_starttime(pid: i32) -> Option<u64> {
    let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let tail = text.rsplit(')').next()?;
    tail.split_whitespace().nth(19).and_then(|f| f.parse().ok())
}

fn write_pidfile_sidecar(pidfile: &str, pgid: i32) {
    #[cfg(target_os = "linux")]
    if let Some(st) = proc_starttime(pgid) {
        let _ = fs::write(format!("{pidfile}.st"), format!("{st}"));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (pidfile, pgid);
}

fn remove_pidfile_pair(pidfile: &str) {
    let _ = fs::remove_file(pidfile);
    let _ = fs::remove_file(format!("{pidfile}.st"));
}

fn anchor_parent_death() {
    #[cfg(target_os = "linux")]
    unsafe {
        // The exec lane: sshd's session process is our parent and exits on disconnect —
        // exactly when orphans get reparented. The kernel then wakes us; sshd never signals.
        if prctl(PR_SET_PDEATHSIG, SIGTERM as usize, 0, 0, 0) != 0 {
            eprintln!("superd-run: pdeathsig unavailable (continuing unanchored)");
        }
    }
}

pub fn do_run(args: &[String]) -> ! {
    let pidfile = match pidfile_from(args) {
        Some(p) => p,
        None => usage(),
    };
    let argv: Vec<String> = match args.iter().position(|a| a == "--") {
        Some(idx) if idx + 1 < args.len() => args[idx + 1..].to_vec(),
        _ => usage(),
    };

    install_handlers();
    if unsafe { setsid() } != 0 {
        // Expected on lanes where the exec child is already a session/group leader
        // (ssh no-pty exec, some docker exec paths): group ops stay scoped to our own
        // pgrp either way. Debug-only — this fired on every ssh-lane call and polluted
        // stderr (2026-10-14 user acceptance round).
        if std::env::var_os("SUPERD_RUN_DEBUG").is_some() {
            eprintln!("superd-run: setsid fallback: continuing with existing pgrp scope");
        }
    }
    anchor_parent_death();
    let pgid = unsafe { getpgrp() };
    let _ = fs::write(&pidfile, format!("{pgid}"));
    write_pidfile_sidecar(&pidfile, pgid);

    let mut child = match Command::new(&argv[0]).args(&argv[1..]).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("superd-run: exec {}: {e}", argv[0]);
            remove_pidfile_pair(&pidfile);
            std::process::exit(127);
        }
    };

    let deadline_cancel = Instant::now() + Duration::from_millis(CANCEL_CHILD_SETTLE_MS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // Normal completion — wrapper parity: TERM the group's leftover descendants
                // (backgrounded children must not outlive the call), remove pidfile, exit verbatim.
                FINALIZING.store(true, Ordering::Relaxed);
                group_signal(pgid, SIGTERM);
                remove_pidfile_pair(&pidfile);
                std::process::exit(status.code().unwrap_or(128 + SIGTERM as i32));
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!("superd-run: wait: {e}");
                FINALIZING.store(true, Ordering::Relaxed);
                remove_pidfile_pair(&pidfile);
                std::process::exit(70);
            }
        }
        if TERMINATING.load(Ordering::Relaxed) {
            // Cancel / disconnect (PDEATHSIG). TERM the whole group, bounded-reap the direct
            // child (KILL by pid only); group-wide KILL stays with the killer backstop.
            FINALIZING.store(true, Ordering::Relaxed);
            group_signal(pgid, SIGTERM);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline_cancel => {
                        sleep(Duration::from_millis(20))
                    }
                    Ok(None) => {
                        unsafe { kill(child.id() as i32, SIGKILL) };
                        let _ = child.wait();
                        break;
                    }
                    Err(_) => break,
                }
            }
            remove_pidfile_pair(&pidfile);
            std::process::exit(143);
        }
        sleep(Duration::from_millis(20));
    }
}

pub fn do_killgroup(args: &[String]) -> ! {
    let mut pgid: Option<i32> = None;
    let mut pidfile = pidfile_from(args);
    let mut i = 0;
    while i < args.len() {
        if let Some(v) = crate::value_of(args, &mut i, "--pgid") {
            pgid = v.parse().ok();
            continue;
        }
        i += 1;
    }
    if pgid.is_none() {
        pgid = pidfile
            .as_ref()
            .and_then(|p| fs::read_to_string(p).ok())
            .and_then(|s| s.trim().parse().ok());
    }
    let pgid = match pgid {
        Some(g) if g > 1 => g,
        Some(_) => {
            // pgid 1 would make kill(-pgid, sig) = kill(-1, sig): a uid-wide sweep
            // over EVERY signalable process. 2026-10-13 incident: `killgroup --pgid 1`
            // TERMed the whole desktop session (gnome-shell, dsh, hermes, tgg, sidecar).
            eprintln!("superd-run killgroup: refusing invalid pgid (<=1)");
            std::process::exit(64);
        }
        None => {
            eprintln!("superd-run killgroup: no live pgid (already clean)");
            std::process::exit(0);
        }
    };
    if pgid == unsafe { getpgrp() } {
        eprintln!("superd-run killgroup: refusing to signal own group");
        std::process::exit(64);
    }

    let start = Instant::now();
    let mut escalated = 0;
    if group_has_live(pgid) {
        #[cfg(target_os = "linux")]
        if let Some(p) = pidfile.as_ref() {
            if let Ok(expect) = fs::read_to_string(format!("{p}.st")) {
                match proc_starttime(pgid) {
                    Some(cur) if cur.to_string() == expect.trim() => {}
                    _ => {
                        eprintln!("superd-run killgroup: refusing stale pidfile (pid reuse suspected)");
                        std::process::exit(64);
                    }
                }
            }
        }
        group_signal(pgid, SIGTERM);
        if !wait_group_drain(pgid, KILLGROUP_DRAIN_MS) {
            group_signal(pgid, SIGKILL);
            escalated = 1;
            wait_group_drain(pgid, KILLGROUP_KILL_SETTLE_MS);
        }
    }
    let remaining = if group_has_live(pgid) { "unknown" } else { "0" };
    if let Some(p) = pidfile.take() {
        remove_pidfile_pair(&p);
    }
    println!(
        "SUPERD-KILLGROUP pgid={pgid} settled_ms={} escalated={escalated} remaining={remaining}",
        start.elapsed().as_millis()
    );
    std::process::exit(if remaining == "0" { 0 } else { 1 });
}
