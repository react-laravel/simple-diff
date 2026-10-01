use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rayon::prelude::*;
use tauri::{AppHandle, Emitter};

use crate::files::{
  file_quick_hash_cancel, file_sha256_cancel, resolve_local_abs, resolve_local_path,
};
use crate::path_utils::{matches_path_filter, normalize_relative, normalize_relative_safe};
use crate::source_ops::SourceSession;
use crate::state::ActiveCompare;
use crate::types::{
  CompareCacheEntry, CompareEntry, CompareResult, CompareState, CompareStats, DiffReason,
  FileEntry, SourceConfig, StrategyName,
};

const ENTRY_FLUSH_MS: u128 = 100;
const ENTRY_FLUSH_SIZE: usize = 200;

pub struct CompareCallbacks<'a> {
  pub app: &'a AppHandle,
  pub compare_id: &'a str,
  pub cancelled: Arc<AtomicBool>,
  pub session: Option<Arc<ActiveCompare>>,
}

struct PendingDirectoryScan {
  rel: String,
}

struct EntryBatcher<'a> {
  callbacks: &'a CompareCallbacks<'a>,
  buffer: Vec<CompareEntry>,
  last_flush: Instant,
}

impl<'a> EntryBatcher<'a> {
  fn new(callbacks: &'a CompareCallbacks<'a>) -> Self {
    Self {
      callbacks,
      buffer: Vec::new(),
      last_flush: Instant::now(),
    }
  }

  fn push(&mut self, entry: CompareEntry) {
    if let Some(session) = &self.callbacks.session {
      session.register_entries(std::slice::from_ref(&entry));
    }
    self.buffer.push(entry);
    if self.buffer.len() >= ENTRY_FLUSH_SIZE
      || self.last_flush.elapsed() >= Duration::from_millis(ENTRY_FLUSH_MS as u64)
    {
      self.flush();
    }
  }

  fn flush(&mut self) {
    if self.buffer.is_empty() {
      return;
    }
    let batch = std::mem::take(&mut self.buffer);
    let _ = self.callbacks.app.emit(
      "compare:entry-update",
      (self.callbacks.compare_id.to_string(), batch),
    );
    self.last_flush = Instant::now();
  }
}

fn throw_if_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
  if cancelled.load(Ordering::Relaxed) {
    Err("对比已取消".into())
  } else {
    Ok(())
  }
}

fn compare_files(
  left: &FileEntry,
  right: &FileEntry,
  strategies: &[StrategyName],
  mut hash: impl FnMut(bool, bool) -> Result<String, String>,
) -> Result<(CompareState, Vec<DiffReason>), String> {
  let mut reasons = Vec::new();
  for strategy in strategies {
    match strategy {
      StrategyName::Size if left.size != right.size => reasons.push(DiffReason::Size {
        left_size: left.size,
        right_size: right.size,
      }),
      StrategyName::Mtime if left.mtime.abs_diff(right.mtime) > 2000 => {
        reasons.push(DiffReason::Mtime {
          left_mtime: left.mtime,
          right_mtime: right.mtime,
        })
      }
      StrategyName::QuickHash | StrategyName::Hash => {
        let quick = *strategy == StrategyName::QuickHash;
        let left_hash = hash(true, quick)?;
        let right_hash = hash(false, quick)?;
        if left_hash != right_hash {
          reasons.push(if quick {
            DiffReason::QuickHash {
              left_hash,
              right_hash,
            }
          } else {
            DiffReason::Hash {
              left_hash,
              right_hash,
            }
          });
        }
      }
      _ => {}
    }
  }
  Ok((
    if reasons.is_empty() {
      CompareState::Equal
    } else {
      CompareState::Different
    },
    reasons,
  ))
}

fn compare_local_files(
  left_root: &str,
  right_root: &str,
  left: &FileEntry,
  right: &FileEntry,
  strategies: &[StrategyName],
  cancelled: Option<&AtomicBool>,
) -> Result<(CompareState, Vec<DiffReason>), String> {
  compare_files(left, right, strategies, |is_left, quick| {
    if let Some(flag) = cancelled {
      throw_if_cancelled(flag)?;
    }
    let (root, entry) = if is_left {
      (left_root, left)
    } else {
      (right_root, right)
    };
    let source = SourceConfig::Local { path: root.into() };
    if entry.is_symlink {
      use sha2::Digest;
      let target = std::fs::read_link(resolve_local_path(&source, &entry.path, true)?)
        .map_err(|e| format!("读取符号链接失败: {e}"))?;
      return Ok(hex::encode(sha2::Sha256::digest(
        target.to_string_lossy().as_bytes(),
      )));
    }
    let path = resolve_local_abs(&source, &entry.path)?;
    if quick {
      file_quick_hash_cancel(&path, cancelled)
    } else {
      file_sha256_cancel(&path, cancelled)
    }
  })
}

fn parallel_hash_pair(
  left: impl FnOnce() -> Result<String, String> + Send,
  right: impl FnOnce() -> Result<String, String> + Send,
) -> Result<(String, String), String> {
  let (left_hash, right_hash) = rayon::join(left, right);
  Ok((left_hash?, right_hash?))
}

fn compare_file_with_sessions(
  left_session: &SourceSession<'_>,
  right_session: &SourceSession<'_>,
  left: &FileEntry,
  right: &FileEntry,
  strategies: &[StrategyName],
  cancelled: Option<&AtomicBool>,
) -> Result<(CompareState, Vec<DiffReason>), String> {
  // The two sessions already own independent connections. Read both sides of
  // a selected hash strategy together, and reuse that pair for the callback.
  let mut quick_pair = None;
  let mut full_pair = None;
  compare_files(left, right, strategies, |is_left, quick| {
    if let Some(flag) = cancelled {
      throw_if_cancelled(flag)?;
    }
    let pair = if quick {
      &mut quick_pair
    } else {
      &mut full_pair
    };
    if pair.is_none() {
      let hash = |session: &SourceSession<'_>, entry: &FileEntry| {
        if let Some(flag) = cancelled {
          throw_if_cancelled(flag)?;
        }
        if entry.is_symlink {
          session.link_hash(&entry.path)
        } else if quick {
          session.quick_hash_cancel(&entry.path, cancelled)
        } else {
          session.hash_cancel(&entry.path, cancelled)
        }
      };
      *pair = Some(parallel_hash_pair(
        || hash(left_session, left),
        || hash(right_session, right),
      )?);
    }
    let (left_hash, right_hash) = pair.as_ref().ok_or("未读取哈希")?;
    Ok(if is_left { left_hash } else { right_hash }.clone())
  })
}

fn entry_type(entry: &FileEntry) -> &'static str {
  if entry.is_symlink {
    "symlink"
  } else if entry.is_directory {
    "directory"
  } else {
    "file"
  }
}

fn match_level(
  left_list: &[FileEntry],
  right_list: &[FileEntry],
  parent_relative: &str,
  path_filters: &[String],
  _reusable: &HashMap<String, CompareCacheEntry>,
) -> Vec<CompareEntry> {
  let mut left_map: HashMap<String, FileEntry> = HashMap::new();
  for entry in left_list {
    left_map.insert(entry.name.clone(), entry.clone());
  }
  let mut right_map: HashMap<String, FileEntry> = HashMap::new();
  for entry in right_list {
    right_map.insert(entry.name.clone(), entry.clone());
  }

  let mut names: Vec<String> = left_map
    .keys()
    .chain(right_map.keys())
    .cloned()
    .collect::<std::collections::BTreeSet<_>>()
    .into_iter()
    .collect();
  names.sort_by_key(|n| n.to_lowercase());

  let mut entries = Vec::new();
  for name in names {
    let left = left_map.get(&name);
    let right = right_map.get(&name);
    let is_dir = left
      .map(|e| e.is_directory)
      .or_else(|| right.map(|e| e.is_directory))
      .unwrap_or(false);
    let relative_path = if parent_relative.is_empty() {
      name.clone()
    } else {
      format!("{parent_relative}/{name}")
    };
    let relative_path = normalize_relative(&relative_path);

    if matches_path_filter(&relative_path, path_filters) {
      continue;
    }

    if let (Some(left), None) = (left, right) {
      entries.push(CompareEntry {
        relative_path,
        name,
        is_directory: is_dir,
        state: CompareState::LeftOnly,
        left: Some(left.clone()),
        right: None,
        reasons: Vec::new(),
      });
    } else if let (None, Some(right)) = (left, right) {
      entries.push(CompareEntry {
        relative_path,
        name,
        is_directory: is_dir,
        state: CompareState::RightOnly,
        left: None,
        right: Some(right.clone()),
        reasons: Vec::new(),
      });
    } else if let (Some(left), Some(right)) = (left, right) {
      if entry_type(left) != entry_type(right) {
        entries.push(CompareEntry {
          relative_path,
          name,
          is_directory: false,
          state: CompareState::Different,
          left: Some(left.clone()),
          right: Some(right.clone()),
          reasons: vec![DiffReason::Type {
            left_type: entry_type(left).into(),
            right_type: entry_type(right).into(),
          }],
        });
      } else if is_dir {
        entries.push(CompareEntry {
          relative_path,
          name,
          is_directory: true,
          state: CompareState::Pending,
          left: Some(left.clone()),
          right: Some(right.clone()),
          reasons: Vec::new(),
        });
      } else {
        entries.push(CompareEntry {
          relative_path,
          name,
          is_directory: false,
          state: CompareState::Pending,
          left: Some(left.clone()),
          right: Some(right.clone()),
          reasons: Vec::new(),
        });
      }
    }
  }

  entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
  });

  entries
}

fn bump_stats(stats: &mut CompareStats, state: &CompareState) {
  stats.total += 1;
  match state {
    CompareState::Equal => stats.equal += 1,
    CompareState::Different => stats.different += 1,
    CompareState::LeftOnly => stats.left_only += 1,
    CompareState::RightOnly => stats.right_only += 1,
    _ => {}
  }
}

pub fn compare_directories(
  app: &AppHandle,
  left: &SourceConfig,
  right: &SourceConfig,
  relative_roots: &[String],
  strategies: &[StrategyName],
  extension_filter: Option<&[String]>,
  _previous_entries: Option<&[CompareCacheEntry]>,
  retain_entries: bool,
  callbacks: Option<&CompareCallbacks<'_>>,
) -> Result<CompareResult, String> {
  let left_session = SourceSession::open(app, left)?;
  let right_session = SourceSession::open(app, right)?;
  let path_filters = extension_filter.unwrap_or(&[]).to_vec();
  let both_local = left.is_local() && right.is_local();
  let list_concurrency = if both_local { 8usize } else { 2usize };

  // Frontend cache entries have no source or strategy identity and therefore
  // cannot prove results for this run. Recompute all selected strategies.
  let reusable: HashMap<String, CompareCacheEntry> = HashMap::new();

  let started = Instant::now();
  let mut stats = CompareStats::default();
  let mut all_entries: Vec<CompareEntry> = Vec::new();

  let roots: Vec<String> = if relative_roots.is_empty() {
    vec![String::new()]
  } else {
    relative_roots
      .iter()
      .map(|root| normalize_relative_safe(root))
      .collect::<Result<Vec<_>, _>>()?
  };

  let mut current_level: Vec<PendingDirectoryScan> = roots
    .into_iter()
    .map(|rel| PendingDirectoryScan { rel })
    .collect();

  while !current_level.is_empty() {
    if let Some(cb) = callbacks {
      throw_if_cancelled(&cb.cancelled)?;
    }

    let mut next_level: Vec<PendingDirectoryScan> = Vec::new();
    let mut level_entries: Vec<CompareEntry> = Vec::new();

    // Concurrent directory listing within the level (chunked).
    for chunk in current_level.chunks(list_concurrency) {
      if let Some(cb) = callbacks {
        throw_if_cancelled(&cb.cancelled)?;
      }
      let list_scan = |scan: &PendingDirectoryScan| -> Result<Vec<CompareEntry>, String> {
        if let Some(cb) = callbacks {
          throw_if_cancelled(&cb.cancelled)?;
        }
        let (left_list, right_list) = rayon::join(
          || {
            left_session
              .list(&scan.rel)
              .map_err(|e| format!("读取左侧目录 {} 失败: {e}", scan.rel))
          },
          || {
            right_session
              .list(&scan.rel)
              .map_err(|e| format!("读取右侧目录 {} 失败: {e}", scan.rel))
          },
        );
        Ok(match_level(
          &left_list?,
          &right_list?,
          &scan.rel,
          &path_filters,
          &reusable,
        ))
      };
      let listed: Result<Vec<_>, String> = if both_local {
        chunk.par_iter().map(list_scan).collect()
      } else {
        chunk.iter().map(list_scan).collect()
      };
      for matched in listed? {
        level_entries.extend(matched);
      }
    }

    if let Some(cb) = callbacks {
      if let Some(session) = &cb.session {
        session.register_entries(&level_entries);
      }
      let _ = cb.app.emit(
        "compare:scan-complete",
        (cb.compare_id.to_string(), level_entries.clone()),
      );
    }

    let mut pending_files: Vec<CompareEntry> = Vec::new();
    let mut other_entries: Vec<CompareEntry> = Vec::new();
    for entry in level_entries {
      if !entry.is_directory && entry.state == CompareState::Pending {
        pending_files.push(entry);
      } else {
        other_entries.push(entry);
      }
    }

    let mut batcher = callbacks.map(EntryBatcher::new);

    for entry in other_entries {
      if let Some(cb) = callbacks {
        throw_if_cancelled(&cb.cancelled)?;
      }

      if entry.is_directory {
        match entry.state {
          CompareState::Pending => {
            // Emit comparing state for UI spinner before descending.
            let mut comparing = entry.clone();
            comparing.state = CompareState::Comparing;
            if let Some(batcher) = batcher.as_mut() {
              batcher.push(comparing);
            } else if let Some(cb) = callbacks {
              let _ = cb.app.emit(
                "compare:entry-update",
                (cb.compare_id.to_string(), vec![comparing]),
              );
            }
            next_level.push(PendingDirectoryScan {
              rel: entry.relative_path.clone(),
            });
            if retain_entries {
              all_entries.push(entry);
            }
          }
          CompareState::LeftOnly | CompareState::RightOnly => {
            bump_stats(&mut stats, &entry.state);
            if let Some(batcher) = batcher.as_mut() {
              batcher.push(entry.clone());
            }
            if retain_entries {
              all_entries.push(entry);
            }
          }
          _ => {
            if retain_entries {
              all_entries.push(entry);
            }
          }
        }
      } else {
        bump_stats(&mut stats, &entry.state);
        if let Some(batcher) = batcher.as_mut() {
          batcher.push(entry.clone());
        }
        if retain_entries {
          all_entries.push(entry);
        }
      }
    }

    if both_local && pending_files.len() > 1 {
      let left_root = left.as_local_path()?.to_string();
      let right_root = right.as_local_path()?.to_string();
      let strategies = strategies.to_vec();
      let results: Result<Vec<_>, String> = pending_files
        .par_iter()
        .map(|entry| {
          let left_fe = entry.left.as_ref().ok_or("缺少左侧文件")?;
          let right_fe = entry.right.as_ref().ok_or("缺少右侧文件")?;
          let (state, reasons) = compare_local_files(
            &left_root,
            &right_root,
            left_fe,
            right_fe,
            &strategies,
            callbacks.map(|cb| cb.cancelled.as_ref()),
          )?;
          Ok((entry.relative_path.clone(), state, reasons))
        })
        .collect();
      let results = results?;
      let mut by_path: HashMap<String, (CompareState, Vec<DiffReason>)> = HashMap::new();
      for (path, state, reasons) in results {
        by_path.insert(path, (state, reasons));
      }

      for mut entry in pending_files {
        if let Some(cb) = callbacks {
          throw_if_cancelled(&cb.cancelled)?;
        }
        if let Some((state, reasons)) = by_path.remove(&entry.relative_path) {
          entry.state = state;
          entry.reasons = reasons;
        }
        bump_stats(&mut stats, &entry.state);
        if let Some(batcher) = batcher.as_mut() {
          batcher.push(entry.clone());
        }
        if retain_entries {
          all_entries.push(entry);
        }
      }
    } else {
      for mut entry in pending_files {
        if let Some(cb) = callbacks {
          throw_if_cancelled(&cb.cancelled)?;
        }
        if let (Some(left_fe), Some(right_fe)) = (&entry.left, &entry.right) {
          let (state, reasons) = compare_file_with_sessions(
            &left_session,
            &right_session,
            left_fe,
            right_fe,
            strategies,
            callbacks.map(|cb| cb.cancelled.as_ref()),
          )?;
          entry.state = state;
          entry.reasons = reasons;
        }
        bump_stats(&mut stats, &entry.state);
        if let Some(batcher) = batcher.as_mut() {
          batcher.push(entry.clone());
        }
        if retain_entries {
          all_entries.push(entry);
        }
      }
    }

    if let Some(mut batcher) = batcher {
      batcher.flush();
    }

    current_level = next_level;
  }

  Ok(CompareResult {
    entries: all_entries,
    entries_included: Some(retain_entries),
    stats,
    duration: started.elapsed().as_millis() as u64,
    left_source: Some(left.clone()),
    right_source: Some(right.clone()),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::CompareFileFingerprint;

  fn fe(name: &str, is_directory: bool, size: u64, mtime: u64) -> FileEntry {
    FileEntry {
      name: name.into(),
      path: name.into(),
      is_directory,
      is_symlink: false,
      size,
      mtime,
    }
  }

  fn cache_entry(
    relative_path: &str,
    state: CompareState,
    size: u64,
    mtime: u64,
  ) -> CompareCacheEntry {
    CompareCacheEntry {
      relative_path: relative_path.into(),
      state,
      left: CompareFileFingerprint {
        is_directory: false,
        is_symlink: false,
        size,
        mtime,
      },
      right: CompareFileFingerprint {
        is_directory: false,
        is_symlink: false,
        size,
        mtime,
      },
      reasons: Vec::new(),
    }
  }

  #[test]
  fn hash_pair_reads_both_sides_concurrently() {
    let pool = rayon::ThreadPoolBuilder::new()
      .num_threads(2)
      .build()
      .unwrap();
    let (left_started, wait_left) = std::sync::mpsc::channel();
    let (right_started, wait_right) = std::sync::mpsc::channel();
    let hashes = pool
      .install(move || {
        parallel_hash_pair(
          move || {
            left_started.send(()).unwrap();
            wait_right
              .recv_timeout(Duration::from_secs(2))
              .map_err(|_| "right hash did not start concurrently".to_string())?;
            Ok("left".into())
          },
          move || {
            wait_left
              .recv_timeout(Duration::from_secs(2))
              .map_err(|_| "left hash did not start".to_string())?;
            right_started.send(()).unwrap();
            Ok("right".into())
          },
        )
      })
      .unwrap();
    assert_eq!(hashes, ("left".into(), "right".into()));
  }

  #[test]
  fn compare_collects_every_selected_reason_with_two_second_tolerance() {
    let left = fe("a", false, 1, 1000);
    let right = fe("a", false, 2, 3001);
    let mut calls = 0;
    let (_, reasons) = compare_files(
      &left,
      &right,
      &[
        StrategyName::Size,
        StrategyName::Mtime,
        StrategyName::QuickHash,
        StrategyName::Hash,
      ],
      |is_left, _| {
        calls += 1;
        Ok(if is_left { "left" } else { "right" }.into())
      },
    )
    .unwrap();
    assert_eq!(reasons.len(), 4);
    assert_eq!(calls, 4);
    let within = fe("a", false, 1, 3000);
    assert_eq!(
      compare_files(
        &left,
        &within,
        &[StrategyName::Mtime],
        |_, _| unreachable!()
      )
      .unwrap()
      .0,
      CompareState::Equal
    );
  }

  #[test]
  fn type_mismatches_are_not_descended_or_reused() {
    let mut link = fe("a", false, 0, 0);
    link.is_symlink = true;
    let directory = fe("a", true, 0, 0);
    let entries = match_level(&[directory], &[link], "", &[], &HashMap::new());
    assert!(!entries[0].is_directory);
    assert_eq!(entries[0].state, CompareState::Different);
    assert!(matches!(entries[0].reasons[0], DiffReason::Type { .. }));
  }

  #[test]
  fn match_level_marks_one_sided_entries() {
    let left = vec![
      fe("only-left.txt", false, 1, 1),
      fe("both.txt", false, 1, 1),
    ];
    let right = vec![
      fe("only-right.txt", false, 1, 1),
      fe("both.txt", false, 2, 1),
    ];
    let entries = match_level(&left, &right, "", &[], &HashMap::new());

    assert_eq!(entries.len(), 3);
    assert_eq!(entries[0].relative_path, "both.txt");
    assert_eq!(entries[0].state, CompareState::Pending);
    assert_eq!(entries[1].relative_path, "only-left.txt");
    assert_eq!(entries[1].state, CompareState::LeftOnly);
    assert_eq!(entries[2].relative_path, "only-right.txt");
    assert_eq!(entries[2].state, CompareState::RightOnly);
  }

  #[test]
  fn match_level_sorts_directories_first_and_prefixes_parent() {
    let left = vec![fe("b.txt", false, 1, 1), fe("zdir", true, 0, 0)];
    let right = vec![fe("zdir", true, 0, 0)];
    let entries = match_level(&left, &right, "root/sub", &[], &HashMap::new());

    assert_eq!(entries.len(), 2);
    // 目录排在文件前面，且相对路径带上父级前缀
    assert_eq!(entries[0].relative_path, "root/sub/zdir");
    assert!(entries[0].is_directory);
    assert_eq!(entries[0].state, CompareState::Pending);
    assert_eq!(entries[1].relative_path, "root/sub/b.txt");
    assert_eq!(entries[1].state, CompareState::LeftOnly);
  }

  #[test]
  fn match_level_ignores_unverified_cached_results_even_when_metadata_matches() {
    let left = vec![fe("a.txt", false, 5, 100)];
    let right = vec![fe("a.txt", false, 5, 100)];
    let mut reusable = HashMap::new();
    reusable.insert(
      "a.txt".to_string(),
      cache_entry("a.txt", CompareState::Equal, 5, 100),
    );
    let entries = match_level(&left, &right, "", &[], &reusable);

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, CompareState::Pending);
  }

  #[test]
  fn match_level_ignores_cache_when_fingerprint_changed() {
    let left = vec![fe("a.txt", false, 5, 100)];
    let right = vec![fe("a.txt", false, 6, 100)];
    let mut reusable = HashMap::new();
    reusable.insert(
      "a.txt".to_string(),
      cache_entry("a.txt", CompareState::Equal, 5, 100),
    );
    let entries = match_level(&left, &right, "", &[], &reusable);

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].state, CompareState::Pending);
  }

  #[test]
  fn match_level_applies_path_filters() {
    let left = vec![fe("node_modules", true, 0, 0), fe("a.txt", false, 1, 1)];
    let right = vec![fe("node_modules", true, 0, 0)];
    let filters = vec!["node_modules".to_string()];
    let entries = match_level(&left, &right, "", &filters, &HashMap::new());

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].relative_path, "a.txt");
  }

  #[test]
  fn bump_stats_counts_each_state() {
    let mut stats = CompareStats::default();
    bump_stats(&mut stats, &CompareState::Equal);
    bump_stats(&mut stats, &CompareState::Different);
    bump_stats(&mut stats, &CompareState::LeftOnly);
    bump_stats(&mut stats, &CompareState::RightOnly);
    // Pending / Comparing 只计入 total
    bump_stats(&mut stats, &CompareState::Pending);

    assert_eq!(stats.total, 5);
    assert_eq!(stats.equal, 1);
    assert_eq!(stats.different, 1);
    assert_eq!(stats.left_only, 1);
    assert_eq!(stats.right_only, 1);
  }
}
