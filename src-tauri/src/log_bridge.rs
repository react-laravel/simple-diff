use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::secret_crypto::{app_data_dir, set_private_permissions};
use crate::types::{LogEntry, LogLevel, LogScope};

const MAX_MESSAGE_BYTES: usize = 16 * 1024;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const LOG_BACKUPS: usize = 3;
static LOG_LOCK: Mutex<()> = Mutex::new(());

fn bounded_message(message: &str) -> String {
  let mut end = message.len().min(MAX_MESSAGE_BYTES);
  while !message.is_char_boundary(end) {
    end -= 1;
  }
  let mut result = message[..end].to_owned();
  if end < message.len() {
    result.push_str("…[已截断]");
  }
  result
}

fn append_rotating(path: &Path, line: &[u8], max_bytes: u64, backups: usize) -> io::Result<()> {
  let _guard = LOG_LOCK.lock();
  let current_size = match fs::metadata(path) {
    Ok(metadata) => {
      // Harden an existing legacy log before rotation preserves its mode.
      set_private_permissions(path, false).map_err(io::Error::other)?;
      metadata.len()
    }
    Err(error) if error.kind() == io::ErrorKind::NotFound => 0,
    Err(error) => return Err(error),
  };
  if current_size > 0 && current_size.saturating_add(line.len() as u64) > max_bytes {
    let archive = |index: usize| path.with_extension(format!("log.{index}"));
    match fs::remove_file(archive(backups)) {
      Ok(()) => {}
      Err(error) if error.kind() == io::ErrorKind::NotFound => {}
      Err(error) => return Err(error),
    }
    for index in (1..backups).rev() {
      match fs::rename(archive(index), archive(index + 1)) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
      }
    }
    fs::rename(path, archive(1))?;
  }
  let mut options = OpenOptions::new();
  options.create(true).append(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options.open(path)?;
  set_private_permissions(path, false).map_err(io::Error::other)?;
  file.write_all(line)
}

fn append_log_file(app: &AppHandle, entry: &LogEntry) {
  let Ok(dir) = app_data_dir(app) else {
    return;
  };
  let log_dir = dir.join("logs");
  if fs::create_dir_all(&log_dir).is_err() || set_private_permissions(&log_dir, true).is_err() {
    return;
  }
  let line = format!(
    "{} {:?} {:?} {}\n",
    entry.timestamp,
    entry.level,
    entry.scope,
    entry.message.replace('\r', "\\r").replace('\n', "\\n")
  );
  let _ = append_rotating(
    &log_dir.join("simple-diff.log"),
    line.as_bytes(),
    MAX_LOG_BYTES,
    LOG_BACKUPS,
  );
}

pub fn emit_log(app: &AppHandle, scope: LogScope, level: LogLevel, message: impl Into<String>) {
  let entry = LogEntry {
    timestamp: std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis() as u64)
      .unwrap_or(0),
    level,
    scope,
    message: message.into(),
  };
  write_and_emit(app, entry);
}

pub fn write_and_emit(app: &AppHandle, mut entry: LogEntry) {
  if entry.message.trim().is_empty() {
    return;
  }
  entry.message = bounded_message(&entry.message);
  match entry.level {
    LogLevel::Info => log::info!("[{:?}] {}", entry.scope, entry.message),
    LogLevel::Warn => log::warn!("[{:?}] {}", entry.scope, entry.message),
    LogLevel::Error => log::error!("[{:?}] {}", entry.scope, entry.message),
  }
  append_log_file(app, &entry);
  let _ = app.emit("app:log", entry);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn messages_are_bounded_at_utf8_boundaries() {
    let message = "中文🔑".repeat(MAX_MESSAGE_BYTES);
    let bounded = bounded_message(&message);
    assert!(bounded.len() < MAX_MESSAGE_BYTES + 32);
    assert!(bounded.ends_with("[已截断]"));
  }

  #[cfg(unix)]
  #[test]
  fn rotating_legacy_log_does_not_preserve_public_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("simple-diff.log");
    fs::write(&path, b"legacy log content").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    append_rotating(&path, b"new log\n", 16, 3).unwrap();
    assert_eq!(
      fs::metadata(path.with_extension("log.1"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777,
      0o600
    );
    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    fs::remove_dir_all(&directory).unwrap();
  }

  #[test]
  fn rotation_keeps_only_bounded_history_and_latest_lines() {
    let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("simple-diff.log");
    for index in 0..20 {
      append_rotating(&path, format!("line-{index:02}\n").as_bytes(), 24, 3).unwrap();
    }
    assert_eq!(fs::read_dir(&directory).unwrap().count(), 4);
    for item in fs::read_dir(&directory).unwrap() {
      assert!(item.unwrap().metadata().unwrap().len() <= 24);
    }
    assert!(fs::read_to_string(&path).unwrap().contains("line-19"));
    fs::remove_dir_all(directory).unwrap();
  }
}
