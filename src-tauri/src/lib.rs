use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

struct Backend(Mutex<Option<Child>>);

#[cfg(unix)]
fn stop_backend(child: &mut Child) {
    // Child::kill() sends SIGKILL on Unix, which would bypass the Node
    // shutdown hook and leave worktree runtimes listening on their ports.
    let pid = child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", pid.as_str()]).status();
    for _ in 0..150 {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn stop_backend(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let server = if cfg!(debug_assertions) {
                std::env::current_dir()?.join("dist/server/server/index.js")
            } else {
                resource_dir.join("dist/server/server/index.js")
            };
            let child = Command::new("node")
                .arg(server)
                .current_dir(&resource_dir)
                .spawn()
                .map_err(|error| format!("无法启动内置服务: {error}"))?;
            app.manage(Backend(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Backend>() {
                    if let Ok(mut backend) = state.0.lock() {
                        if let Some(mut child) = backend.take() {
                            stop_backend(&mut child);
                        }
                    }
                }
            }
        });
}
