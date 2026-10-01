use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::open_paths::OpenPathQueue;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::compare::{compare_directories, CompareCallbacks};
use crate::files::resolve_local_abs;
use crate::history;
use crate::log_bridge;
use crate::source_ops::{
  delete_source, list_entries, read_text_source, rename_source, write_text_source,
};
use crate::ssh::{self, connect_session};
use crate::ssh_store;
use crate::state::AppState;
use crate::sync::sync_manager;
use crate::types::{
  CompareHistoryEntry, CompareLocalWatchRequest, ComparePartialRequest, CompareRequest,
  CompareResult, FileEntry, IpcResult, LogEntry, SourceConfig, SshConfig, SshConfigInput,
  StartSyncRequest, SyncPlanPreview, SyncTaskSnapshot,
};

#[tauri::command]
pub async fn list_files(
  app: AppHandle,
  source: SourceConfig,
  dir_path: String,
) -> Result<IpcResult<Vec<FileEntry>>, String> {
  tauri::async_runtime::spawn_blocking(move || match list_entries(&app, &source, &dir_path) {
    Ok(entries) => IpcResult::ok(entries),
    Err(err) => IpcResult::err(err),
  })
  .await
  .map_err(|err| format!("读取目录任务失败: {err}"))
}

#[tauri::command]
pub async fn read_text_file(
  app: AppHandle,
  source: SourceConfig,
  file_path: String,
) -> Result<IpcResult<String>, String> {
  tauri::async_runtime::spawn_blocking(move || match read_text_source(&app, &source, &file_path) {
    Ok(content) => IpcResult::ok(content),
    Err(err) => IpcResult::err(err),
  })
  .await
  .map_err(|err| format!("读取文件任务失败: {err}"))
}

#[tauri::command]
pub async fn write_text_file(
  app: AppHandle,
  source: SourceConfig,
  file_path: String,
  content: String,
  expected_content: Option<String>,
  expected_exists: Option<bool>,
) -> Result<IpcResult<()>, String> {
  tauri::async_runtime::spawn_blocking(
    move || match write_text_source(&app, &source, &file_path, &content, expected_content.as_deref(), expected_exists) {
      Ok(()) => IpcResult::ok_empty(),
      Err(err) => IpcResult::err(err),
    },
  )
  .await
  .map_err(|err| format!("写入文件任务失败: {err}"))
}

#[tauri::command]
pub async fn run_compare(
  app: AppHandle,
  state: State<'_, AppState>,
  request: CompareRequest,
) -> Result<IpcResult<CompareResult>, String> {
  state.cancel_compare(Some(&request.compare_id));

  let cancelled = Arc::new(AtomicBool::new(false));
  let session = state.begin_compare(
    request.compare_id.clone(),
    request.left.clone(),
    request.right.clone(),
    cancelled.clone(),
  );

  let compare_id = request.compare_id.clone();
  let app_for_history = app.clone();
  let left = request.left.clone();
  let right = request.right.clone();

  let result = tauri::async_runtime::spawn_blocking(move || {
    let callbacks = CompareCallbacks {
      app: &app,
      compare_id: &request.compare_id,
      cancelled: cancelled.clone(),
      session: Some(session),
    };

    compare_directories(
      &app,
      &request.left,
      &request.right,
      &[],
      &request.strategies,
      request.extension_filter.as_deref(),
      request.previous_entries.as_deref(),
      false,
      Some(&callbacks),
    )
  })
  .await
  .map_err(|err| format!("对比任务失败: {err}"))?;

  state.finish_compare(&compare_id);

  Ok(match result {
    Ok(mut value) => {
      value.left_source = Some(left.clone());
      value.right_source = Some(right.clone());
      let _ = history::add_history(&app_for_history, &value, &left, &right);
      log_bridge::emit_log(
        &app_for_history,
        crate::types::LogScope::Compare,
        crate::types::LogLevel::Info,
        format!(
          "对比完成: 共 {} 项（相同 {} / 不同 {}）",
          value.stats.total, value.stats.equal, value.stats.different
        ),
      );
      IpcResult::ok(value)
    }
    Err(err) => {
      log_bridge::emit_log(
        &app_for_history,
        crate::types::LogScope::Compare,
        crate::types::LogLevel::Error,
        format!("对比失败: {err}"),
      );
      IpcResult::err(err)
    }
  })
}

#[tauri::command]
pub async fn run_partial_compare(
  app: AppHandle,
  state: State<'_, AppState>,
  request: ComparePartialRequest,
) -> Result<IpcResult<CompareResult>, String> {
  // 仅当来源与原会话一致时才回写受信任映射，避免污染同步信任范围
  let session = request
    .compare_id
    .as_deref()
    .and_then(|compare_id| state.get_compare(compare_id))
    .filter(|session| session.matches_sources(&request.left, &request.right));

  let result = tauri::async_runtime::spawn_blocking(move || {
    compare_directories(
      &app,
      &request.left,
      &request.right,
      &request.relative_roots,
      &request.strategies,
      request.extension_filter.as_deref(),
      request.previous_entries.as_deref(),
      true,
      None,
    )
  })
  .await
  .map_err(|err| format!("局部对比失败: {err}"))?;

  Ok(match result {
    Ok(value) => {
      // 将局部结果并入原对比会话的受信任映射，保证 watch 触发的重比对后仍可同步
      if let Some(session) = session {
        session.register_entries(&value.entries);
      }
      IpcResult::ok(value)
    }
    Err(err) => IpcResult::err(err),
  })
}

#[tauri::command]
pub fn cancel_compare(state: State<'_, AppState>, compare_id: Option<String>) -> IpcResult<()> {
  state.cancel_compare(compare_id.as_deref());
  IpcResult::ok_empty()
}

#[tauri::command]
pub fn start_local_compare_watch(
  app: AppHandle,
  state: State<'_, AppState>,
  request: CompareLocalWatchRequest,
) -> IpcResult<()> {
  match state
    .watch_manager
    .start(app, request.session_id, request.left, request.right)
  {
    Ok(()) => IpcResult::ok_empty(),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn stop_local_compare_watch(
  state: State<'_, AppState>,
  session_id: Option<String>,
) -> IpcResult<()> {
  state.watch_manager.stop(session_id.as_deref());
  IpcResult::ok_empty()
}

#[tauri::command]
pub async fn select_folder(app: AppHandle) -> Result<IpcResult<Option<String>>, String> {
  let path = tauri::async_runtime::spawn_blocking(move || {
    app.dialog()
      .file()
      .blocking_pick_folder()
      .map(|path| path.to_string())
  })
  .await
  .map_err(|err| format!("选择目录失败: {err}"))?;

  Ok(IpcResult::ok(path))
}

#[tauri::command]
pub async fn select_file(app: AppHandle) -> Result<IpcResult<Option<String>>, String> {
  let path = tauri::async_runtime::spawn_blocking(move || {
    app.dialog()
      .file()
      .blocking_pick_file()
      .map(|path| path.to_string())
  })
  .await
  .map_err(|err| format!("选择文件失败: {err}"))?;

  Ok(IpcResult::ok(path))
}

#[tauri::command]
pub fn take_open_paths(queue: State<'_, OpenPathQueue>) -> IpcResult<Vec<String>> {
  IpcResult::ok(queue.take_and_mark_ready())
}

#[tauri::command]
pub fn show_in_folder(app: AppHandle, source: SourceConfig, relative_path: String) -> IpcResult<()> {
  match source {
    SourceConfig::Local { .. } => match resolve_local_abs(&source, &relative_path) {
      Ok(path) => match app.opener().reveal_item_in_dir(path) {
        Ok(()) => IpcResult::ok_empty(),
        Err(err) => IpcResult::err(format!("打开失败: {err}")),
      },
      Err(err) => IpcResult::err(err),
    },
    SourceConfig::Sftp { .. } => IpcResult::err("SFTP 路径无法在本地访达中打开"),
  }
}

#[tauri::command]
pub async fn rename_path(
  app: AppHandle,
  source: SourceConfig,
  old_relative_path: String,
  new_name: String,
) -> Result<IpcResult<()>, String> {
  tauri::async_runtime::spawn_blocking(
    move || match rename_source(&app, &source, &old_relative_path, &new_name) {
      Ok(()) => IpcResult::ok_empty(),
      Err(err) => IpcResult::err(err),
    },
  )
  .await
  .map_err(|err| format!("重命名任务失败: {err}"))
}

#[tauri::command]
pub async fn delete_path(
  app: AppHandle,
  source: SourceConfig,
  relative_path: String,
  is_directory: bool,
) -> Result<IpcResult<()>, String> {
  tauri::async_runtime::spawn_blocking(
    move || match delete_source(&app, &source, &relative_path, is_directory) {
      Ok(()) => IpcResult::ok_empty(),
      Err(err) => IpcResult::err(err),
    },
  )
  .await
  .map_err(|err| format!("删除任务失败: {err}"))
}

#[tauri::command]
pub fn write_log(app: AppHandle, entry: LogEntry) {
  log_bridge::write_and_emit(&app, entry);
}

#[tauri::command]
pub fn history_list(app: AppHandle) -> IpcResult<Vec<CompareHistoryEntry>> {
  match history::list_history(&app) {
    Ok(entries) => IpcResult::ok(entries),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> IpcResult<()> {
  match history::clear_history(&app) {
    Ok(()) => IpcResult::ok_empty(),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> IpcResult<()> {
  match history::delete_history(&app, &id) {
    Ok(()) => IpcResult::ok_empty(),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub async fn sync_prepare(
  app: AppHandle,
  state: State<'_, AppState>,
  mut request: StartSyncRequest,
) -> Result<IpcResult<SyncPlanPreview>, String> {
  request.entries = match state.assert_sync_entries(&request) {
    Ok(entries) => entries,
    Err(err) => return Ok(IpcResult::err(err)),
  };
  tauri::async_runtime::spawn_blocking(move || match sync_manager().prepare(&app, request) {
    Ok(plan) => IpcResult::ok(plan),
    Err(err) => IpcResult::err(err),
  }).await.map_err(|err| format!("同步预检失败: {err}"))
}

#[tauri::command]
pub async fn sync_prepare_resume(app: AppHandle) -> Result<IpcResult<SyncPlanPreview>, String> {
  tauri::async_runtime::spawn_blocking(move || match sync_manager().prepare_resume(&app) {
    Ok(plan) => IpcResult::ok(plan),
    Err(err) => IpcResult::err(err),
  }).await.map_err(|err| format!("继续同步预检失败: {err}"))
}

#[tauri::command]
pub async fn sync_start(
  app: AppHandle,
  state: State<'_, AppState>,
  mut request: StartSyncRequest,
) -> Result<IpcResult<SyncTaskSnapshot>, String> {
  // State 借用不满足 'static：先完成信任校验并取出净化后的条目，再进入阻塞任务
  let entries = match state.assert_sync_entries(&request) {
    Ok(entries) => entries,
    Err(err) => return Ok(IpcResult::err(err)),
  };
  request.entries = entries;
  tauri::async_runtime::spawn_blocking(move || match sync_manager().start(app, request) {
    Ok(task) => IpcResult::ok(task),
    Err(err) => IpcResult::err(err),
  })
  .await
  .map_err(|err| format!("启动同步任务失败: {err}"))
}

#[tauri::command]
pub fn sync_pause(app: AppHandle) -> IpcResult<Option<SyncTaskSnapshot>> {
  IpcResult::ok(sync_manager().pause(&app))
}

#[tauri::command]
pub fn sync_resume(app: AppHandle, plan_id: Option<String>) -> IpcResult<Option<SyncTaskSnapshot>> {
  match sync_manager().resume(app, plan_id) {
    Ok(task) => IpcResult::ok(task),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn sync_get_status() -> IpcResult<Option<SyncTaskSnapshot>> {
  IpcResult::ok(sync_manager().get_snapshot())
}

#[tauri::command]
pub fn sync_clear(app: AppHandle) -> IpcResult<()> {
  match sync_manager().clear(&app) {
    Ok(()) => IpcResult::ok_empty(),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn ssh_list_configs(app: AppHandle) -> IpcResult<Vec<SshConfig>> {
  match ssh_store::list_configs(&app) {
    Ok(configs) => IpcResult::ok(configs),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn ssh_save_config(app: AppHandle, input: SshConfigInput) -> IpcResult<SshConfig> {
  match ssh_store::save_config(&app, input) {
    Ok(config) => IpcResult::ok(config),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub fn ssh_delete_config(app: AppHandle, id: String) -> IpcResult<()> {
  crate::ssh_pool::invalidate(&id);
  match ssh_store::delete_config(&app, &id) {
    Ok(()) => IpcResult::ok_empty(),
    Err(err) => IpcResult::err(err),
  }
}

#[tauri::command]
pub async fn ssh_test(app: AppHandle, id: String) -> Result<IpcResult<bool>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    match ssh_store::get_internal(&app, &id).and_then(|config| ssh::test_connection(&config)) {
      Ok(ok) => IpcResult::ok(ok),
      Err(err) => IpcResult::err(err),
    }
  })
  .await
  .map_err(|err| format!("SSH 连接测试任务失败: {err}"))
}

#[tauri::command]
pub async fn ssh_browse(
  app: AppHandle,
  config_id: String,
  dir_path: String,
) -> Result<IpcResult<crate::types::SshBrowseResult>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let listing = (|| {
      let config = ssh_store::get_internal(&app, &config_id)?;
      let root = config
        .default_path
        .clone()
        .unwrap_or_else(|| "/".to_string());
      let session = connect_session(&config)?;
      ssh::browse_remote(&session, &root, &dir_path)
    })();
    match listing {
      Ok(entries) => IpcResult::ok(entries),
      Err(err) => IpcResult::err(err),
    }
  })
  .await
  .map_err(|err| format!("SSH 目录浏览任务失败: {err}"))
}
