//! The request loop's state: handles, the wire shapes and the answers. The wire
//! protocol is the one `apps/server/src/computerUse/Xa11yComputerDriver.ts`
//! already speaks to its Node worker, carried as JSON lines over stdio, so the
//! server's queueing, timeouts, restarts and reply decoding stay unchanged.
//!
//! This first version only observes. Every input op answers `unavailable`
//! without touching the desktop, so the server's dispatch check is never asked.

use std::collections::HashMap;

use agent_desktop_core::{AccessibilityNode, WindowInfo};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::observe;

/// The native side, so the loop can be tested without a desktop.
pub trait Desktop {
    fn status(&self) -> Status;
    fn list_windows(&self) -> Result<Vec<ListedWindow>, Failure>;
    fn tree(&self, window: &WindowInfo) -> Result<AccessibilityNode, Failure>;
}

pub struct Status {
    pub available: bool,
    /// "granted", "denied" or "unknown".
    pub accessibility: &'static str,
    pub reason: Option<String>,
}

pub struct ListedWindow {
    pub info: WindowInfo,
    /// The executable path; the server's denylist matches `.app` bundles on it.
    pub app_identifier: Option<String>,
}

#[derive(Debug)]
pub struct Failure {
    /// One of the server's `DriverErrorKind`s.
    pub kind: &'static str,
    /// Safe to show: never window contents.
    pub message: String,
    pub restarted: bool,
}

impl Failure {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            restarted: false,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "op")]
enum Request {
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "listWindows")]
    ListWindows,
    #[serde(rename = "releaseMouse")]
    ReleaseMouse,
    #[serde(rename = "observe")]
    Observe {
        window: String,
        #[serde(rename = "maxElements")]
        max_elements: usize,
        query: Option<String>,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Deserialize)]
struct Envelope {
    id: u64,
    nonce: String,
    request: Option<Value>,
}

pub enum Incoming {
    Reply(String),
    /// The nonce did not match: the caller is not the server that spawned us.
    Reject,
}

const WINDOW_RESTARTED: &str = "The computer-use driver restarted; list windows again.";
const INPUT_UNAVAILABLE: &str = "This computer-use driver can only observe so far; switch back to the default driver for input.";

pub struct Driver<D> {
    desktop: D,
    nonce: String,
    epoch: String,
    next_handle: u64,
    windows: HashMap<String, WindowInfo>,
}

impl<D: Desktop> Driver<D> {
    pub fn new(desktop: D, nonce: String, epoch: String) -> Self {
        Self {
            desktop,
            nonce,
            epoch,
            next_handle: 1,
            windows: HashMap::new(),
        }
    }

    fn mint(&mut self, prefix: char) -> String {
        let handle = format!("{prefix}{}.{}", self.epoch, self.next_handle);
        self.next_handle += 1;
        handle
    }

    /// Answers one line from the server. A line that is not a request for this
    /// worker gets no reply: the server times out and starts a fresh worker.
    pub fn handle_line(&mut self, line: &str) -> Option<Incoming> {
        let envelope: Envelope = serde_json::from_str(line).ok()?;
        if envelope.nonce != self.nonce {
            return Some(Incoming::Reject);
        }
        let request = envelope.request?;
        let reply = match serde_json::from_value::<Request>(request) {
            Ok(request) => self.answer(request),
            Err(_) => Err(Failure::new("malformed", "The request was not understood.")),
        };
        let message = match reply {
            Ok(result) => json!({ "id": envelope.id, "ok": true, "result": result }),
            Err(failure) => {
                let mut error = json!({
                    "kind": failure.kind,
                    "message": failure.message,
                    "dispatched": "no",
                });
                if failure.restarted {
                    error["reason"] = json!("restarted");
                }
                json!({ "id": envelope.id, "ok": false, "error": error })
            }
        };
        Some(Incoming::Reply(message.to_string()))
    }

    fn answer(&mut self, request: Request) -> Result<Value, Failure> {
        match request {
            Request::Status => {
                let status = self.desktop.status();
                let mut result = json!({
                    "available": status.available,
                    "accessibility": status.accessibility,
                });
                if let Some(reason) = status.reason {
                    result["reason"] = json!(reason);
                }
                Ok(result)
            }
            Request::ListWindows => self.list_windows(),
            // Nothing here ever presses a mouse button.
            Request::ReleaseMouse => Ok(Value::Null),
            Request::Observe {
                window,
                max_elements,
                query,
            } => self.observe(&window, max_elements, query.as_deref()),
            Request::Unsupported => Err(Failure::new("unavailable", INPUT_UNAVAILABLE)),
        }
    }

    fn list_windows(&mut self) -> Result<Value, Failure> {
        let listed = self.desktop.list_windows()?;
        // A new listing replaces the previous handles.
        self.windows.clear();
        let mut windows = Vec::with_capacity(listed.len());
        for window in listed {
            let handle = self.mint('w');
            let mut entry = json!({
                "handle": handle,
                "app": window.info.app,
                "pid": window.info.pid.get(),
                "title": window.info.title,
                "focused": window.info.state.is_focused,
            });
            if let Some(bounds) = &window.info.bounds {
                entry["bounds"] = json!({
                    "x": bounds.x.round(),
                    "y": bounds.y.round(),
                    "width": bounds.width.round(),
                    "height": bounds.height.round(),
                });
            }
            if let Some(identifier) = window.app_identifier {
                entry["appIdentifier"] = json!(identifier);
            }
            self.windows.insert(handle, window.info);
            windows.push(entry);
        }
        Ok(Value::Array(windows))
    }

    fn require_window(&self, handle: &str) -> Result<&WindowInfo, Failure> {
        let owner = handle
            .rfind('.')
            .filter(|dot| *dot > 1)
            .map(|dot| &handle[1..dot]);
        if owner.is_some_and(|owner| owner != self.epoch) {
            return Err(Failure {
                kind: "stale",
                message: WINDOW_RESTARTED.into(),
                restarted: true,
            });
        }
        self.windows
            .get(handle)
            .ok_or_else(|| Failure::new("stale", "Unknown window; list windows again."))
    }

    fn observe(
        &mut self,
        handle: &str,
        max_elements: usize,
        query: Option<&str>,
    ) -> Result<Value, Failure> {
        let window = self.require_window(handle)?.clone();
        let tree = self.desktop.tree(&window)?;
        let observation = observe::flatten(&tree, max_elements, query);
        let mut elements = Vec::with_capacity(observation.elements.len());
        for element in observation.elements {
            // Nothing resolves element handles until input arrives; they are
            // minted so the service can tell observations apart.
            let mut entry = json!({
                "handle": self.mint('e'),
                "role": element.role,
                "label": element.label,
                "enabled": element.enabled,
                "focused": element.focused,
            });
            if let Some(value) = element.value {
                entry["value"] = json!(value);
            }
            if let Some(section) = element.section {
                entry["section"] = json!(section);
            }
            if let Some(instance) = element.instance {
                entry["instance"] = json!(instance);
            }
            elements.push(entry);
        }
        Ok(json!({ "elements": elements, "truncated": observation.truncated }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_desktop_core::{ProcessId, Rect, WindowState};

    struct FakeDesktop;

    fn info(title: &str) -> WindowInfo {
        WindowInfo {
            id: "w1".into(),
            title: title.into(),
            app: "Notes".into(),
            pid: ProcessId::from(42),
            process_instance: None,
            bounds: Some(Rect {
                x: 10.4,
                y: 20.0,
                width: 300.0,
                height: 200.0,
            }),
            state: WindowState {
                is_focused: true,
                ..WindowState::default()
            },
        }
    }

    impl Desktop for FakeDesktop {
        fn status(&self) -> Status {
            Status {
                available: true,
                accessibility: "granted",
                reason: None,
            }
        }
        fn list_windows(&self) -> Result<Vec<ListedWindow>, Failure> {
            Ok(vec![ListedWindow {
                info: info("Shopping list"),
                app_identifier: Some("/System/Applications/Notes.app/Contents/MacOS/Notes".into()),
            }])
        }
        fn tree(&self, _window: &WindowInfo) -> Result<AccessibilityNode, Failure> {
            let mut button = AccessibilityNode {
                ref_id: None,
                role: "button".into(),
                identity: Default::default(),
                presentation: Default::default(),
                children_count: None,
                subtree_truncated: false,
                children: vec![],
            };
            button.identity.name = Some("Done".into());
            let mut root = button.clone();
            root.role = "window".into();
            root.children = vec![button];
            Ok(root)
        }
    }

    fn driver() -> Driver<FakeDesktop> {
        Driver::new(FakeDesktop, "n0nce".into(), "ab12".into())
    }

    fn send(driver: &mut Driver<FakeDesktop>, id: u64, request: Value) -> Value {
        let line = json!({ "id": id, "nonce": "n0nce", "request": request }).to_string();
        match driver.handle_line(&line) {
            Some(Incoming::Reply(reply)) => serde_json::from_str(&reply).unwrap(),
            _ => panic!("expected a reply"),
        }
    }

    #[test]
    fn lists_then_observes_a_window() {
        let mut driver = driver();
        let windows = send(&mut driver, 1, json!({ "op": "listWindows" }));
        assert_eq!(windows["ok"], true);
        let window = &windows["result"][0];
        assert_eq!(window["handle"], "wab12.1");
        assert_eq!(window["pid"], 42);
        assert_eq!(window["bounds"]["x"], 10.0);
        assert_eq!(
            window["appIdentifier"],
            "/System/Applications/Notes.app/Contents/MacOS/Notes"
        );
        let observed = send(
            &mut driver,
            2,
            json!({ "op": "observe", "window": "wab12.1", "maxElements": 10 }),
        );
        assert_eq!(observed["id"], 2);
        assert_eq!(observed["result"]["elements"][0]["label"], "Done");
        assert_eq!(observed["result"]["truncated"], false);
    }

    #[test]
    fn refuses_unknown_and_restarted_handles() {
        let mut driver = driver();
        let unknown = send(
            &mut driver,
            1,
            json!({ "op": "observe", "window": "wab12.9", "maxElements": 10 }),
        );
        assert_eq!(unknown["error"]["kind"], "stale");
        assert!(unknown["error"].get("reason").is_none());
        let restarted = send(
            &mut driver,
            2,
            json!({ "op": "observe", "window": "wffff.1", "maxElements": 10 }),
        );
        assert_eq!(restarted["error"]["reason"], "restarted");
    }

    #[test]
    fn input_is_unavailable_and_never_dispatched() {
        let mut driver = driver();
        let reply = send(
            &mut driver,
            1,
            json!({ "op": "press", "element": "eab12.1", "expect": { "role": "button", "label": "Done" } }),
        );
        assert_eq!(reply["error"]["kind"], "unavailable");
        assert_eq!(reply["error"]["dispatched"], "no");
    }

    #[test]
    fn rejects_a_wrong_nonce_and_ignores_garbage() {
        let mut driver = driver();
        let line = json!({ "id": 1, "nonce": "other", "request": { "op": "status" } }).to_string();
        assert!(matches!(driver.handle_line(&line), Some(Incoming::Reject)));
        assert!(driver.handle_line("not json").is_none());
    }
}
