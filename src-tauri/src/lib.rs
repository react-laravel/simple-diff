mod sftp_atomic;
mod ssh_host_key;
mod atomic_file;
mod commands;
mod compare;
mod files;
mod history;
mod log_bridge;
mod open_paths;
mod path_guards;
mod path_utils;
mod secret_crypto;
#[cfg(target_os = "windows")]
mod private_permissions_windows;
mod source_ops;
mod ssh;
mod ssh_pool;
mod ssh_store;
mod state;
mod sync;
mod sync_plan;
mod types;
mod watch;

use open_paths::OpenPathQueue;
use state::AppState;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let initial_open_paths = open_paths::collect_open_path_args(std::env::args());

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .manage(AppState::new())
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      crate::sync::sync_manager().hydrate_from_disk(app.handle());
      let _ = crate::secret_crypto::app_data_dir(app.handle());
      app.manage(OpenPathQueue::new(initial_open_paths));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::list_files,
      commands::read_text_file,
      commands::write_text_file,
      commands::run_compare,
      commands::run_partial_compare,
      commands::cancel_compare,
      commands::start_local_compare_watch,
      commands::stop_local_compare_watch,
      commands::select_folder,
      commands::select_file,
      commands::take_open_paths,
      commands::show_in_folder,
      commands::rename_path,
      commands::delete_path,
      commands::write_log,
      commands::history_list,
      commands::history_clear,
      commands::history_delete,
      commands::sync_start,
      commands::sync_prepare,
      commands::sync_prepare_resume,
      commands::sync_pause,
      commands::sync_resume,
      commands::sync_get_status,
      commands::sync_clear,
      commands::ssh_list_configs,
      commands::ssh_save_config,
      commands::ssh_delete_config,
      commands::ssh_test,
      commands::ssh_browse,
    ])
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| match event {
      #[cfg(any(target_os = "macos", target_os = "ios"))]
      RunEvent::Opened { urls } => {
        let Some(queue) = app_handle.try_state::<OpenPathQueue>() else {
          return;
        };
        let paths: Vec<String> = urls
          .iter()
          .filter_map(|url| url.to_file_path().ok())
          .map(open_paths::normalize_dropped_path)
          .filter(|path| !path.is_empty())
          .collect();
        queue.enqueue(app_handle, paths);
      }
      _ => {}
    });
}
