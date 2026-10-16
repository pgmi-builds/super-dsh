// superd-run — thin per-invocation remote supervision helper.
// Spec: docs/specs/remote-rescope/spec.md §5.5/§5.6. Verbs: banner | run | killgroup.
// Platform split: unix.rs (setsid / PDEATHSIG / process groups), windows.rs (Job Objects).
// Semantics mirror the POSIX wrapper in transports.ts; no upgrades.
use std::env;


#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix::{do_killgroup, do_run};
#[cfg(windows)]
use windows::{do_killgroup, do_run};

fn banner() -> ! {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    let pds = if cfg!(target_os = "linux") { 1 } else { 0 };
    let anchor = if cfg!(target_os = "windows") { " anchor=job-koc" } else { "" };
    println!(
        "SUPERD-RUN proto=1 name=superd-run ver={} target={} os={os} pdeathsig={pds}{anchor} pid={}",
        env!("SUPERD_RUN_VER"),
        env!("SUPERD_RUN_TARGET"),
        std::process::id()
    );
    std::process::exit(0);
}

pub(crate) fn usage() -> ! {
    eprintln!(
        "usage: superd-run banner\n       superd-run run [--pidfile P | --tag T] -- <argv…>\n       superd-run killgroup (--pgid N | --pidfile P | --tag T)"
    );
    std::process::exit(64);
}

pub(crate) fn tmp_path(tag: &str) -> String {
    let dir = env::var("TMPDIR")
        .or_else(|_| env::var("TEMP"))
        .or_else(|_| env::var("TMP"))
        .unwrap_or_else(|_| "/tmp".into());
    format!("{}/superd-oneshot-{}.pgid", dir.trim_end_matches(['/', '\\']), tag)
}

pub(crate) fn value_of(args: &[String], i: &mut usize, flag: &str) -> Option<String> {
    if args[*i] == flag && *i + 1 < args.len() {
        let v = args[*i + 1].clone();
        *i += 2;
        Some(v)
    } else {
        None
    }
}

pub(crate) fn pidfile_from(args: &[String]) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if let Some(v) = value_of(args, &mut i, "--pidfile") {
            return Some(v);
        }
        if let Some(v) = value_of(args, &mut i, "--tag") {
            return Some(tmp_path(&v));
        }
        i += 1;
    }
    None
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("banner") => banner(),
        Some("run") => do_run(&args[1..]),
        Some("killgroup") => do_killgroup(&args[1..]),
        _ => usage(),
    }
}

