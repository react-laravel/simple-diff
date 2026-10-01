use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use crate::path_utils::normalize_relative;
use crate::types::{CompareEntry, CompareState, SourceConfig, StartSyncRequest, SyncDirection};

const MAX_ACTIVE_COMPARES: usize = 32;

#[derive(Debug, Clone)]
pub struct CompareEntryMeta {
  pub is_directory: bool,
  pub state: CompareState,
}

pub struct ActiveCompare {
  pub cancelled: Arc<AtomicBool>,
  pub left_source: SourceConfig,
  pub right_source: SourceConfig,
  pub left_to_right: Mutex<HashMap<String, CompareEntryMeta>>,
  pub right_to_left: Mutex<HashMap<String, CompareEntryMeta>>,
  pub updated_at: Mutex<u64>,
  pub running: Mutex<bool>,
}

impl ActiveCompare {
  pub fn new(left: SourceConfig, right: SourceConfig, cancelled: Arc<AtomicBool>) -> Self {
    Self {
      cancelled,
      left_source: left,
      right_source: right,
      left_to_right: Mutex::new(HashMap::new()),
      right_to_left: Mutex::new(HashMap::new()),
      updated_at: Mutex::new(now_ms()),
      running: Mutex::new(true),
    }
  }

  pub fn touch(&self) {
    *self.updated_at.lock() = now_ms();
  }

  pub fn matches_sources(&self, left: &SourceConfig, right: &SourceConfig) -> bool {
    sources_same(&self.left_source, left) && sources_same(&self.right_source, right)
  }

  pub fn register_entries(&self, entries: &[CompareEntry]) {
    let mut l2r = self.left_to_right.lock();
    let mut r2l = self.right_to_left.lock();
    for entry in entries {
      let Ok(path) = normalize_relative_strict(&entry.relative_path) else {
        continue;
      };
      if entry.left.as_ref().is_some_and(|file| file.is_symlink)
        || entry.right.as_ref().is_some_and(|file| file.is_symlink)
      {
        l2r.remove(&path);
        r2l.remove(&path);
        continue;
      }
      match entry.state {
        CompareState::LeftOnly => {
          l2r.insert(
            path.clone(),
            CompareEntryMeta {
              is_directory: entry.is_directory,
              state: CompareState::LeftOnly,
            },
          );
          r2l.remove(&path);
        }
        CompareState::RightOnly => {
          r2l.insert(
            path.clone(),
            CompareEntryMeta {
              is_directory: entry.is_directory,
              state: CompareState::RightOnly,
            },
          );
          l2r.remove(&path);
        }
        CompareState::Different if !entry.is_directory => {
          let meta = CompareEntryMeta {
            is_directory: false,
            state: CompareState::Different,
          };
          l2r.insert(path.clone(), meta.clone());
          r2l.insert(path, meta);
        }
        _ => {
          l2r.remove(&path);
          r2l.remove(&path);
        }
      }
    }
    self.touch();
  }
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn normalize_relative_strict(path: &str) -> Result<String, String> {
  let normalized = normalize_relative(path);
  if path.split(['/', '\\']).any(|p| p == "..") {
    return Err("非法路径".into());
  }
  Ok(normalized)
}

fn sources_same(left: &SourceConfig, right: &SourceConfig) -> bool {
  match (left, right) {
    (SourceConfig::Local { path: a }, SourceConfig::Local { path: b }) => a == b,
    (
      SourceConfig::Sftp {
        config_id: a,
        path: pa,
      },
      SourceConfig::Sftp {
        config_id: b,
        path: pb,
      },
    ) => a == b && pa == pb,
    _ => false,
  }
}

pub struct AppState {
  pub active_compares: Mutex<HashMap<String, Arc<ActiveCompare>>>,
  pub watch_manager: crate::watch::SharedWatchManager,
}

impl AppState {
  pub fn new() -> Self {
    Self {
      active_compares: Mutex::new(HashMap::new()),
      watch_manager: Arc::new(crate::watch::WatchManager::new()),
    }
  }

  pub fn begin_compare(
    &self,
    compare_id: String,
    left: SourceConfig,
    right: SourceConfig,
    cancelled: Arc<AtomicBool>,
  ) -> Arc<ActiveCompare> {
    let session = Arc::new(ActiveCompare::new(left, right, cancelled));
    let mut map = self.active_compares.lock();
    map.insert(compare_id, session.clone());
    Self::prune_locked(&mut map);
    session
  }

  pub fn finish_compare(&self, compare_id: &str) {
    if let Some(session) = self.active_compares.lock().get(compare_id) {
      *session.running.lock() = false;
      session.touch();
    }
    let mut map = self.active_compares.lock();
    Self::prune_locked(&mut map);
  }

  pub fn cancel_compare(&self, compare_id: Option<&str>) {
    let compares = self.active_compares.lock();
    if let Some(id) = compare_id {
      if let Some(active) = compares.get(id) {
        active
          .cancelled
          .store(true, std::sync::atomic::Ordering::Relaxed);
      }
    } else {
      for active in compares.values() {
        active
          .cancelled
          .store(true, std::sync::atomic::Ordering::Relaxed);
      }
    }
  }

  pub fn get_compare(&self, compare_id: &str) -> Option<Arc<ActiveCompare>> {
    self.active_compares.lock().get(compare_id).cloned()
  }

  pub fn assert_sync_entries(
    &self,
    request: &StartSyncRequest,
  ) -> Result<Vec<CompareEntry>, String> {
    let compare = self
      .get_compare(&request.compare_id)
      .ok_or_else(|| "未找到匹配的对比会话".to_string())?;

    if !sources_same(&compare.left_source, &request.left_source)
      || !sources_same(&compare.right_source, &request.right_source)
    {
      return Err("当前对比会话与同步参数不一致".into());
    }

    let allowed = match request.direction {
      SyncDirection::LeftToRight => compare.left_to_right.lock(),
      SyncDirection::RightToLeft => compare.right_to_left.lock(),
    };

    let mut sanitized = Vec::with_capacity(request.entries.len());
    for entry in &request.entries {
      let path = normalize_relative_strict(&entry.relative_path)?;
      let expected = allowed
        .get(&path)
        .ok_or_else(|| "同步条目不在受信任范围".to_string())?;

      let direction_ok = match request.direction {
        SyncDirection::LeftToRight => {
          matches!(
            expected.state,
            CompareState::LeftOnly | CompareState::Different
          )
        }
        SyncDirection::RightToLeft => {
          matches!(
            expected.state,
            CompareState::RightOnly | CompareState::Different
          )
        }
      };
      if !direction_ok || expected.is_directory != entry.is_directory {
        return Err("同步条目不在受信任范围".into());
      }

      let mut clone = entry.clone();
      clone.relative_path = path;
      sanitized.push(clone);
    }
    Ok(sanitized)
  }

  fn prune_locked(map: &mut HashMap<String, Arc<ActiveCompare>>) {
    if map.len() <= MAX_ACTIVE_COMPARES {
      return;
    }
    let mut idle: Vec<(String, u64)> = map
      .iter()
      .filter(|(_, s)| !*s.running.lock())
      .map(|(id, s)| (id.clone(), *s.updated_at.lock()))
      .collect();
    idle.sort_by_key(|(_, ts)| *ts);
    for (id, _) in idle {
      if map.len() <= MAX_ACTIVE_COMPARES {
        break;
      }
      map.remove(&id);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::SyncDirection;

  fn local(path: &str) -> SourceConfig {
    SourceConfig::Local { path: path.into() }
  }

  fn file_entry(path: &str, state: CompareState) -> CompareEntry {
    CompareEntry {
      relative_path: path.into(),
      name: path.split('/').next_back().unwrap_or(path).into(),
      is_directory: false,
      state,
      left: None,
      right: None,
      reasons: Vec::new(),
    }
  }

  fn sync_request(compare_id: &str, entries: Vec<CompareEntry>) -> StartSyncRequest {
    StartSyncRequest {
      compare_id: compare_id.into(),
      left_source: local("/l"),
      right_source: local("/r"),
      direction: SyncDirection::LeftToRight,
      entries,
      plan_id: None,
    }
  }

  fn begin_test_compare(state: &AppState, compare_id: &str) -> Arc<ActiveCompare> {
    state.begin_compare(
      compare_id.into(),
      local("/l"),
      local("/r"),
      Arc::new(AtomicBool::new(false)),
    )
  }

  #[test]
  fn partial_register_trusts_newly_different_entries() {
    let state = AppState::new();
    let session = begin_test_compare(&state, "c1");
    // 全量对比时 a.txt 相同，不进入受信任映射
    session.register_entries(&[file_entry("a.txt", CompareState::Equal)]);
    let request = sync_request("c1", vec![file_entry("a.txt", CompareState::Different)]);
    assert!(state.assert_sync_entries(&request).is_err());

    // watch 触发的局部重比对发现 a.txt 变为不同后应可同步
    session.register_entries(&[file_entry("a.txt", CompareState::Different)]);
    let sanitized = state.assert_sync_entries(&request).expect("应通过信任校验");
    assert_eq!(sanitized.len(), 1);
    assert_eq!(sanitized[0].relative_path, "a.txt");
  }

  #[test]
  fn partial_register_revokes_now_equal_entries() {
    let state = AppState::new();
    let session = begin_test_compare(&state, "c1");
    session.register_entries(&[file_entry("a.txt", CompareState::Different)]);
    let request = sync_request("c1", vec![file_entry("a.txt", CompareState::Different)]);
    assert!(state.assert_sync_entries(&request).is_ok());

    // 局部重比对发现文件已恢复一致后应撤销信任
    session.register_entries(&[file_entry("a.txt", CompareState::Equal)]);
    assert!(state.assert_sync_entries(&request).is_err());
  }

  #[test]
  fn matches_sources_requires_same_pair() {
    let session = ActiveCompare::new(local("/l"), local("/r"), Arc::new(AtomicBool::new(false)));
    assert!(session.matches_sources(&local("/l"), &local("/r")));
    assert!(!session.matches_sources(&local("/other"), &local("/r")));
    assert!(!session.matches_sources(&local("/l"), &local("/other")));
  }
}
