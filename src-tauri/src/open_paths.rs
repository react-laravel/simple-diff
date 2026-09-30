use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 启动参数 / Dock 打开的路径可能早于前端订阅 `app:open-paths`。
/// 未就绪时先缓存；就绪后边缓存边立刻 emit。
pub struct OpenPathQueue {
  frontend_ready: AtomicBool,
  pending: Mutex<Vec<String>>,
}

impl OpenPathQueue {
  pub fn new(initial: Vec<String>) -> Self {
    Self {
      frontend_ready: AtomicBool::new(false),
      pending: Mutex::new(initial),
    }
  }

  pub fn enqueue(&self, app: &AppHandle, paths: Vec<String>) {
    let mut incoming: Vec<String> = paths.into_iter().filter(|path| !path.is_empty()).collect();
    if incoming.is_empty() {
      return;
    }

    reveal_main_window(app);

    let mut pending = self.pending.lock();
    pending.append(&mut incoming);
    if self.frontend_ready.load(Ordering::SeqCst) {
      let ready = std::mem::take(&mut *pending);
      drop(pending);
      let _ = app.emit("app:open-paths", ready);
    }
  }

  pub fn take_and_mark_ready(&self) -> Vec<String> {
    let mut paths = std::mem::take(&mut *self.pending.lock());
    self.frontend_ready.store(true, Ordering::SeqCst);
    paths.append(&mut std::mem::take(&mut *self.pending.lock()));
    paths
  }
}

pub fn collect_open_path_args<I>(args: I) -> Vec<String>
where
  I: IntoIterator<Item = String>,
{
  args
    .into_iter()
    .skip(1)
    .filter(|arg| !arg.starts_with('-'))
    .map(PathBuf::from)
    .map(normalize_dropped_path)
    .filter(|path| !path.is_empty())
    .collect()
}

pub fn normalize_dropped_path(path: PathBuf) -> String {
  if path.is_file() {
    if let Some(parent) = path.parent() {
      if !parent.as_os_str().is_empty() {
        return parent.to_string_lossy().into_owned();
      }
    }
  }
  path.to_string_lossy().into_owned()
}

fn reveal_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn unique_temp(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .map(|duration| duration.as_nanos())
      .unwrap_or(0);
    std::env::temp_dir().join(format!("simple-diff-{name}-{nanos}"))
  }

  #[test]
  fn collect_open_path_args_skips_flags_and_binary() {
    let dir = unique_temp("open-args-dir");
    fs::create_dir_all(&dir).expect("temp dir");
    let args = vec![
      "/Applications/Simple Diff.app/Contents/MacOS/simple-diff".into(),
      "-psn_0_123".into(),
      dir.to_string_lossy().into_owned(),
    ];
    let paths = collect_open_path_args(args);
    fs::remove_dir_all(&dir).ok();
    assert_eq!(paths, vec![dir.to_string_lossy().into_owned()]);
  }

  #[test]
  fn dropped_file_uses_parent_directory() {
    let dir = unique_temp("open-file-dir");
    fs::create_dir_all(&dir).expect("temp dir");
    let file = dir.join("readme.txt");
    fs::write(&file, b"x").expect("temp file");
    let normalized = normalize_dropped_path(file);
    fs::remove_dir_all(&dir).ok();
    assert_eq!(PathBuf::from(normalized), dir);
  }

  #[test]
  fn dropped_directory_stays_directory() {
    let dir = unique_temp("open-dir");
    fs::create_dir_all(&dir).expect("temp dir");
    let normalized = normalize_dropped_path(dir.clone());
    fs::remove_dir_all(&dir).ok();
    assert_eq!(PathBuf::from(normalized), dir);
  }

  #[test]
  fn take_and_mark_ready_drains_initial_paths_once() {
    let queue = OpenPathQueue::new(vec!["/left".into(), "/right".into()]);
    assert_eq!(queue.take_and_mark_ready(), vec!["/left", "/right"]);
    assert!(queue.take_and_mark_ready().is_empty());
  }
}
