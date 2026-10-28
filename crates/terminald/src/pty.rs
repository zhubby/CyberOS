use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::libc;
use nix::pty::{Winsize, openpty};
use nix::sys::signal::{Signal, kill};
use nix::unistd::{Pid, read, write};
use tokio::io::unix::AsyncFd;
use tokio::process::{Child, Command};
use tokio::time::timeout;

use crate::error::TerminalError;

const PROCESS_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

pub struct PtyProcess {
    pub master: Arc<AsyncFd<OwnedFd>>,
    pub child: Child,
}

pub fn spawn(mut command: Command, cols: u16, rows: u16) -> Result<PtyProcess, TerminalError> {
    let window = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pair = openpty(&window, None)?;
    let flags = OFlag::from_bits_truncate(fcntl(&pair.master, FcntlArg::F_GETFL)?);
    fcntl(&pair.master, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK))?;

    let slave = File::from(pair.slave);
    command
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    unsafe {
        command.pre_exec(|| {
            for signal in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            let mut empty_set = std::mem::zeroed();
            libc::sigemptyset(&mut empty_set);
            libc::sigprocmask(libc::SIG_SETMASK, &empty_set, std::ptr::null_mut());
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command.spawn()?;
    // SAFETY: OwnedFd keeps the valid PTY descriptor open and stable for the
    // entire lifetime of AsyncFd.
    let master = Arc::new(unsafe { AsyncFd::register(pair.master) }.map_err(io::Error::from)?);
    Ok(PtyProcess { master, child })
}

pub async fn read_chunk(master: &AsyncFd<OwnedFd>, buffer: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut guard = master.readable().await?;
        match guard.try_io(|inner| read(inner.get_ref(), buffer).map_err(io::Error::from)) {
            Ok(result) => return result,
            Err(_) => continue,
        }
    }
}

pub async fn write_all(master: &AsyncFd<OwnedFd>, mut data: &[u8]) -> io::Result<()> {
    while !data.is_empty() {
        let mut guard = master.writable().await?;
        match guard.try_io(|inner| write(inner.get_ref(), data).map_err(io::Error::from)) {
            Ok(Ok(0)) => return Err(io::Error::from(io::ErrorKind::WriteZero)),
            Ok(Ok(written)) => data = &data[written..],
            Ok(Err(error)) => return Err(error),
            Err(_) => continue,
        }
    }
    Ok(())
}

pub fn resize(master: &AsyncFd<OwnedFd>, cols: u16, rows: u16) -> io::Result<()> {
    let window = Winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let result =
        unsafe { libc::ioctl(master.get_ref().as_raw_fd(), libc::TIOCSWINSZ as _, &window) };
    if result == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub async fn terminate(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
    }
    if timeout(PROCESS_EXIT_TIMEOUT, child.wait()).await.is_err() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn runs_a_command_through_a_resizable_pty() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf terminal-ready"]);
        let mut process = spawn(command, 80, 24).unwrap();
        resize(&process.master, 100, 40).unwrap();
        let mut buffer = [0_u8; 128];
        let count = timeout(
            Duration::from_secs(2),
            read_chunk(&process.master, &mut buffer),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(String::from_utf8_lossy(&buffer[..count]).contains("terminal-ready"));
        assert!(process.child.wait().await.unwrap().success());
    }
}
