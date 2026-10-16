// Windows platform implementation: one named Job Object per `run` invocation with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the kernel anchor (spec §5.6): if this helper
// dies for ANY reason — including sshd terminating the exec on disconnect — the OS
// closes our job handle and the whole child tree goes down. There are no POSIX signals,
// no setsid, and no pidfile PID-reuse races: the pidfile carries the job NAME; the
// killer session opens it by name from the Global\ namespace and terminates the job.
// NOTE: build-validated only (mingw cross); the fleet has no Windows endpoint yet —
// runtime acceptance is pending a real target (spec D5, honest ledger).
use std::fs;
use std::os::windows::io::AsRawHandle;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

use crate::{pidfile_from, usage};

type Handle = *mut core::ffi::c_void;

const JOB_OBJECT_TERMINATE: u32 = 0x0001;
const JOB_OBJECT_QUERY: u32 = 0x0004;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: i32 = 9;
const INFINITE: u32 = 0xFFFF_FFFF;
const WAIT_OBJECT_0: u32 = 0x0;

#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
}

#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic: BasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
extern "C" {
    fn CreateJobObjectW(attributes: *mut core::ffi::c_void, name: *const u16) -> Handle;
    fn OpenJobObjectW(desired_access: u32, inherit_handle: i32, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        information_class: i32,
        information: *const core::ffi::c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Global\ namespace: the killer session arrives as a different logon session over sshd,
/// and Local\ named objects would not be visible to it.
fn job_name_for(pidfile: &str) -> String {
    let stem = Path::new(pidfile)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "superd-oneshot".into());
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '.' { c } else { '-' })
        .collect();
    format!("Global\\{cleaned}.job")
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
    let name = job_name_for(&pidfile);
    let name_wide = wide(&name);

    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), name_wide.as_ptr()) };
    if job.is_null() {
        eprintln!("superd-run: CreateJobObject failed");
        std::process::exit(65);
    }
    let mut info = ExtendedLimitInformation::default();
    info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<ExtendedLimitInformation>() as u32,
        )
    };
    if configured == 0 {
        eprintln!("superd-run: SetInformationJobObject failed");
        unsafe { CloseHandle(job) };
        std::process::exit(65);
    }
    let _ = fs::write(&pidfile, &name);

    let mut child = match Command::new(&argv[0]).args(&argv[1..]).spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("superd-run: exec {}: {e}", argv[0]);
            let _ = fs::remove_file(&pidfile);
            unsafe { CloseHandle(job) };
            std::process::exit(127);
        }
    };
    if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
        eprintln!("superd-run: AssignProcessToJobObject failed");
        let _ = child.kill();
        let _ = fs::remove_file(&pidfile);
        unsafe { CloseHandle(job) };
        std::process::exit(65);
    }

    let wait = unsafe { WaitForSingleObject(child.as_raw_handle(), INFINITE) };
    let mut code: u32 = 0;
    unsafe { GetExitCodeProcess(child.as_raw_handle(), &mut code) };
    // Wrapper parity: terminate leftover descendants explicitly, then the handle close
    // (KILL_ON_JOB_CLOSE) finishes anything that somehow remains.
    unsafe { TerminateJobObject(job, 143) };
    unsafe { CloseHandle(job) };
    let _ = fs::remove_file(&pidfile);
    if wait != WAIT_OBJECT_0 {
        eprintln!("superd-run: wait anomaly ({wait})");
        std::process::exit(70);
    }
    std::process::exit(code as i32)
}

pub fn do_killgroup(args: &[String]) -> ! {
    // Windows has no pgid semantics; --pgid is unix-only. Refuse rather than guess.
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--pgid" {
            eprintln!("superd-run killgroup: --pgid is unix-only; use --tag/--pidfile (named job)");
            std::process::exit(64);
        }
        i += 1;
    }
    let pidfile = match pidfile_from(args) {
        Some(p) => p,
        None => usage(),
    };
    let name = match fs::read_to_string(&pidfile) {
        Ok(n) if !n.trim().is_empty() => n.trim().to_string(),
        _ => {
            eprintln!("superd-run killgroup: no live job (already clean)");
            std::process::exit(0);
        }
    };
    let name_wide = wide(&name);
    let start = Instant::now();
    let job = unsafe { OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY, 0, name_wide.as_ptr()) };
    if job.is_null() {
        // Named object gone: nothing left to signal.
        let _ = fs::remove_file(&pidfile);
        println!(
            "SUPERD-KILLGROUP job={name} settled_ms={} escalated=0 remaining=0",
            start.elapsed().as_millis()
        );
        std::process::exit(0);
    }
    let terminated = unsafe { TerminateJobObject(job, 143) };
    unsafe { CloseHandle(job) };
    let _ = fs::remove_file(&pidfile);
    if terminated == 0 {
        println!(
            "SUPERD-KILLGROUP job={name} settled_ms={} escalated=0 remaining=unknown",
            start.elapsed().as_millis()
        );
        std::process::exit(1);
    }
    println!(
        "SUPERD-KILLGROUP job={name} settled_ms={} escalated=0 remaining=0",
        start.elapsed().as_millis()
    );
    std::process::exit(0)
}
