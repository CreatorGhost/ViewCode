//! ViewCode's agent-desktop computer-use driver. The server spawns it, sends
//! one JSON request per line on stdin and reads one reply per line on stdout.
//! See `apps/server/src/computerUse/AgentDesktopComputerDriver.ts`.

use std::io::{BufRead, Write};

mod driver;
mod observe;
mod platform;

const NONCE_ENV: &str = "VIEWCODE_COMPUTER_DRIVER_NONCE";
const EPOCH_ENV: &str = "VIEWCODE_COMPUTER_DRIVER_EPOCH";

fn main() {
    // The nonce only stops casual direct use of this helper; the server is
    // the computer-use gate.
    let (Ok(nonce), Ok(epoch)) = (std::env::var(NONCE_ENV), std::env::var(EPOCH_ENV)) else {
        eprintln!("viewcode-computer-driver is started by the ViewCode server.");
        std::process::exit(2);
    };
    if nonce.is_empty() || epoch.is_empty() {
        std::process::exit(2);
    }
    let mut driver = driver::Driver::new(platform::NativeDesktop::new(), nonce, epoch);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        match driver.handle_line(&line) {
            Some(driver::Incoming::Reply(reply)) => {
                if writeln!(stdout, "{reply}")
                    .and_then(|()| stdout.flush())
                    .is_err()
                {
                    break;
                }
            }
            Some(driver::Incoming::Reject) => std::process::exit(2),
            None => {}
        }
    }
}
