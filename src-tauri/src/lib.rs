use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::Manager;

struct Backend(Mutex<Option<Child>>);

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
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
