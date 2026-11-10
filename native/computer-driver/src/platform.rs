//! The native desktop behind the driver: agent-desktop's macOS adapter, or an
//! answer that this platform is not supported yet.

#[cfg(target_os = "macos")]
pub use mac::NativeDesktop;
#[cfg(not(target_os = "macos"))]
pub use unsupported::NativeDesktop;

#[cfg(target_os = "macos")]
mod mac {
    use agent_desktop_core::{
        AccessibilityNode, AdapterError, Deadline, ErrorCode, ObservationOps, PermissionState,
        SystemOps, WindowFilter, WindowInfo, tree::tree_options::TreeOptions,
    };
    use agent_desktop_macos::MacOSAdapter;

    use crate::driver::{Desktop, Failure, ListedWindow, Status};

    /// Leaves room under the server's 10 s list and 15 s observe timeouts.
    const LIST_TIMEOUT_MS: u64 = 8_000;
    const OBSERVE_TIMEOUT_MS: u64 = 12_000;
    /// agent-desktop skips anonymous web wrappers, so this is logical depth.
    const OBSERVE_MAX_DEPTH: u8 = 40;

    pub struct NativeDesktop {
        adapter: MacOSAdapter,
    }

    impl NativeDesktop {
        pub fn new() -> Self {
            Self {
                adapter: MacOSAdapter::new(),
            }
        }
    }

    fn deadline(timeout_ms: u64) -> Result<Deadline, Failure> {
        Deadline::after(timeout_ms).map_err(failure)
    }

    /// Adapter messages can name apps but never window contents; still, keep
    /// ours generic and log nothing from theirs.
    fn failure(error: AdapterError) -> Failure {
        match error.code {
            ErrorCode::PermDenied => Failure::new(
                "permission-accessibility",
                "Accessibility is not granted to ViewCode.",
            ),
            ErrorCode::WindowNotFound
            | ErrorCode::AppNotFound
            | ErrorCode::StaleRef
            | ErrorCode::AmbiguousTarget
            | ErrorCode::ElementNotFound => Failure::new(
                "stale",
                "The window is gone or changed; list windows again.",
            ),
            ErrorCode::Timeout | ErrorCode::AppUnresponsive => {
                Failure::new("timeout", "The app did not answer in time.")
            }
            ErrorCode::PlatformNotSupported | ErrorCode::ActionNotSupported => {
                Failure::new("unavailable", "The accessibility service is not available.")
            }
            _ => Failure::new("failed", "The accessibility service refused the request."),
        }
    }

    /// The executable path, which the server's denylist reads `.app` bundles from.
    fn executable_path(pid: u32) -> Option<String> {
        let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        let pid = i32::try_from(pid).ok()?;
        // SAFETY: the buffer is writable for the length passed.
        let length =
            unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
        if length <= 0 {
            return None;
        }
        buffer.truncate(length as usize);
        String::from_utf8(buffer).ok()
    }

    impl Desktop for NativeDesktop {
        fn status(&self) -> Status {
            let report = deadline(LIST_TIMEOUT_MS)
                .and_then(|deadline| self.adapter.permission_report(deadline).map_err(failure));
            match report {
                Ok(report) => match report.accessibility {
                    PermissionState::Granted => Status {
                        available: true,
                        accessibility: "granted",
                        reason: None,
                    },
                    PermissionState::Denied { .. } => Status {
                        available: true,
                        accessibility: "denied",
                        reason: Some("Accessibility is not granted to ViewCode.".into()),
                    },
                    PermissionState::NotRequired | PermissionState::Unknown => Status {
                        available: true,
                        accessibility: "unknown",
                        reason: None,
                    },
                },
                Err(error) => Status {
                    available: false,
                    accessibility: "unknown",
                    reason: Some(error.message),
                },
            }
        }

        fn list_windows(&self) -> Result<Vec<ListedWindow>, Failure> {
            let filter = WindowFilter {
                focused_only: false,
                app: None,
            };
            let windows = self
                .adapter
                .list_windows(&filter, deadline(LIST_TIMEOUT_MS)?)
                .map_err(failure)?;
            Ok(windows
                .into_iter()
                .filter(|window| !window.is_process_owner())
                .map(|info| ListedWindow {
                    app_identifier: executable_path(info.pid.get()),
                    info,
                })
                .collect())
        }

        fn tree(&self, window: &WindowInfo) -> Result<AccessibilityNode, Failure> {
            let options = TreeOptions {
                max_depth: OBSERVE_MAX_DEPTH,
                ..TreeOptions::default()
            };
            self.adapter
                .get_tree(window, &options, deadline(OBSERVE_TIMEOUT_MS)?)
                .map_err(failure)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod unsupported {
    use agent_desktop_core::{AccessibilityNode, WindowInfo};

    use crate::driver::{Desktop, Failure, ListedWindow, Status};

    const REASON: &str = "The agent-desktop driver supports macOS only so far.";

    pub struct NativeDesktop;

    impl NativeDesktop {
        pub fn new() -> Self {
            Self
        }
    }

    impl Desktop for NativeDesktop {
        fn status(&self) -> Status {
            Status {
                available: false,
                accessibility: "unknown",
                reason: Some(REASON.into()),
            }
        }

        fn list_windows(&self) -> Result<Vec<ListedWindow>, Failure> {
            Err(Failure::new("unavailable", REASON))
        }

        fn tree(&self, _window: &WindowInfo) -> Result<AccessibilityNode, Failure> {
            Err(Failure::new("unavailable", REASON))
        }
    }
}
