use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::log_bridge;
use crate::path_utils::normalize_relative_safe;
use crate::secret_crypto::app_data_dir;
use crate::source_ops::{copy_between_checked, SourceSession};
use crate::sync_plan::{expand_directory_entries, seed_sync_queues};
use crate::types::{
  LogLevel, LogScope, SourceConfig, StartSyncRequest, SyncDirection, SyncItem, SyncItemKind,
  SyncPlanPreview, SyncTaskItemSnapshot, SyncTaskItemStatus, SyncTaskSnapshot, SyncTaskStatus,
};

const PROGRESS_NOTIFY_MS: u128 = 250;
const PERSIST_INTERVAL_MS: u128 = 5000;
const PLAN_TTL_SECS: u64 = 15 * 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TargetFingerprint {
  Missing,
  Directory,
  File { size: u64, mtime: u64, sha256: String },
}

fn target_fingerprint(session: &SourceSession<'_>, relative: &str) -> Result<TargetFingerprint, String> {
  let Some(meta) = session.metadata(relative)? else { return Ok(TargetFingerprint::Missing); };
  if meta.is_symlink { return Err(format!("同步不支持符号链接: {relative}")); }
  if meta.is_directory { return Ok(TargetFingerprint::Directory); }
  let sha256 = session.hash(relative)?;
  let after = session.metadata(relative)?.ok_or_else(|| format!("目标文件在检查时发生变化: {relative}"))?;
  if after.is_symlink || after.is_directory || after.size != meta.size || after.mtime != meta.mtime {
    return Err(format!("目标文件在检查时发生变化: {relative}"));
  }
  Ok(TargetFingerprint::File { size: meta.size, mtime: meta.mtime, sha256 })
}

fn assert_target_unchanged(expected: &TargetFingerprint, actual: &TargetFingerprint, relative: &str) -> Result<(), String> {
  if expected == actual { return Ok(()); }
  Err(format!("目标已被其他程序修改，已停止覆盖: {relative}。请重新对比并确认同步。"))
}

struct PreparedPlan {
  request: StartSyncRequest,
  items: Vec<SyncItem>,
  expected_targets: HashMap<String, TargetFingerprint>,
  prepared_at: Instant,
  queue: Option<(String, HashSet<String>)>,
}

struct PreparedResume {
  plan_id: String,
  task_id: String,
  pending_keys: Vec<String>,
  prepared_at: Instant,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn assert_safe_relative(path: &str) -> Result<String, String> {
  normalize_relative_safe(path).map_err(|_| "同步项路径包含非法路径片段".into())
}

fn source_pair(
  direction: &SyncDirection,
  left: &SourceConfig,
  right: &SourceConfig,
) -> (SourceConfig, SourceConfig) {
  match direction {
    SyncDirection::LeftToRight => (left.clone(), right.clone()),
    SyncDirection::RightToLeft => (right.clone(), left.clone()),
  }
}

fn sources_same(a: &SourceConfig, b: &SourceConfig) -> bool {
  match (a, b) {
    (SourceConfig::Local { path: x }, SourceConfig::Local { path: y }) => x == y,
    (
      SourceConfig::Sftp {
        config_id: cx,
        path: px,
      },
      SourceConfig::Sftp {
        config_id: cy,
        path: py,
      },
    ) => cx == cy && px == py,
    _ => false,
  }
}

fn item_key(item: &SyncItem) -> String {
  format!("{:?}:{}", item.kind, item.relative_path)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedSyncTask {
  snapshot: SyncTaskSnapshot,
  pending_items: Vec<SyncItem>,
  all_items: Vec<SyncItem>,
  #[serde(default)]
  expected_targets: HashMap<String, TargetFingerprint>,
}

fn persist_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app_data_dir(app)?.join("sync-task.json"))
}

fn load_persisted(app: &AppHandle) -> Option<PersistedSyncTask> {
  let path = persist_path(app).ok()?;
  if !path.exists() {
    return None;
  }
  let raw = fs::read_to_string(path).ok()?;
  serde_json::from_str(&raw).ok()
}

fn save_persisted(app: &AppHandle, task: Option<&PersistedSyncTask>) {
  let Ok(path) = persist_path(app) else {
    return;
  };
  match task {
    None => {
      let _ = fs::remove_file(path);
    }
    Some(task) => {
      if let Ok(raw) = serde_json::to_string_pretty(task) {
        if let Err(error) = crate::atomic_file::replace_from_reader(&path, &mut raw.as_bytes()) {
          log_bridge::emit_log(app, LogScope::Sync, LogLevel::Error, format!("保存同步恢复数据失败: {error}"));
        }
        #[cfg(unix)]
        {
          use std::os::unix::fs::PermissionsExt;
          let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
        }
      }
    }
  }
}

struct InnerTask {
  snapshot: SyncTaskSnapshot,
  pending: VecDeque<SyncItem>,
  all_items: Vec<SyncItem>,
  completed_keys: HashSet<String>,
  in_flight: bool,
  pending_updates: HashMap<String, SyncTaskItemSnapshot>,
  expected_targets: HashMap<String, TargetFingerprint>,
}

impl InnerTask {
  fn to_persisted(&self) -> PersistedSyncTask {
    PersistedSyncTask {
      snapshot: {
        let mut snap = self.snapshot.clone();
        snap.items = None;
        snap
      },
      pending_items: self.pending.iter().cloned().collect(),
      all_items: self.all_items.clone(),
      expected_targets: self.expected_targets.clone(),
    }
  }
}

pub struct SyncManager {
  inner: Mutex<Option<InnerTask>>,
  progress_lock: Mutex<()>,
  loop_running: Mutex<bool>,
  last_notify: Mutex<Instant>,
  last_persist: Mutex<Instant>,
  dirty: Mutex<bool>,
  prepared: Mutex<HashMap<String, PreparedPlan>>,
  prepared_resume: Mutex<Option<PreparedResume>>,
}

impl SyncManager {
  pub fn new() -> Self {
    Self {
      inner: Mutex::new(None),
      progress_lock: Mutex::new(()),
      loop_running: Mutex::new(false),
      last_notify: Mutex::new(Instant::now() - std::time::Duration::from_secs(1)),
      last_persist: Mutex::new(Instant::now() - std::time::Duration::from_secs(10)),
      dirty: Mutex::new(false),
      prepared: Mutex::new(HashMap::new()),
      prepared_resume: Mutex::new(None),
    }
  }

  pub fn hydrate_from_disk(&self, app: &AppHandle) {
    if let Some(mut persisted) = load_persisted(app) {
      if matches!(persisted.snapshot.status, SyncTaskStatus::Running | SyncTaskStatus::Paused) {
        persisted.snapshot.status = SyncTaskStatus::Paused;
        persisted.snapshot.current_path = None;
        persisted.snapshot.current_bytes = None;
        persisted.snapshot.current_total_bytes = None;
        persisted.snapshot.updated_at = now_ms();
      }
      let pending: VecDeque<SyncItem> = persisted.pending_items.into_iter().collect();
      let completed_keys = derive_completed_keys(&persisted.all_items, &pending);
      *self.inner.lock() = Some(InnerTask {
        snapshot: persisted.snapshot,
        pending,
        all_items: persisted.all_items,
        completed_keys,
        in_flight: false,
        pending_updates: HashMap::new(),
        expected_targets: persisted.expected_targets,
      });
      if let Some(task) = self.inner.lock().as_ref() {
        save_persisted(app, Some(&task.to_persisted()));
      }
    }
  }

  pub fn get_snapshot(&self) -> Option<SyncTaskSnapshot> {
    self.inner.lock().as_ref().map(|t| {
      let mut snap = t.snapshot.clone();
      snap.items = Some(build_item_snapshots(
        &t.all_items,
        &t.snapshot,
        &t.completed_keys,
      ));
      snap
    })
  }

  pub fn prepare(&self, app: &AppHandle, request: StartSyncRequest) -> Result<SyncPlanPreview, String> {
    let seeded = seed_sync_queues(&request.entries, &request.direction);
    let (_, mut items) = self.expand_items(app, &request, seeded.pending_items)?;
    let queue = {
      let guard = self.inner.lock();
      guard.as_ref().filter(|task| task.snapshot.status == SyncTaskStatus::Running
        && sources_same(&task.snapshot.left_source, &request.left_source)
        && sources_same(&task.snapshot.right_source, &request.right_source)
        && task.snapshot.direction == request.direction)
        .map(|task| (task.snapshot.id.clone(), task.all_items.iter().map(item_key).collect::<HashSet<_>>()))
    };
    if let Some((_, existing)) = &queue { items.retain(|item| !existing.contains(&item_key(item))); }
    let (_, target_cfg) = source_pair(&request.direction, &request.left_source, &request.right_source);
    let target = SourceSession::open(app, &target_cfg)?;
    let expected_targets = capture_targets(&target, &items)?;
    let plan_id = Uuid::new_v4().to_string();
    let preview = plan_preview(plan_id.clone(), &items, &expected_targets);
    let mut prepared = self.prepared.lock();
    prepared.retain(|_, plan| plan.prepared_at.elapsed().as_secs() < PLAN_TTL_SECS);
    if prepared.len() >= 8 { prepared.clear(); }
    prepared.insert(plan_id, PreparedPlan { request, items, expected_targets, prepared_at: Instant::now(), queue });
    Ok(preview)
  }

  fn take_plan(&self, request: &StartSyncRequest) -> Result<PreparedPlan, String> {
    let plan_id = request.plan_id.as_ref().ok_or("请先检查同步范围并确认覆盖数量")?;
    let plan = self.prepared.lock().remove(plan_id).ok_or("同步确认已失效，请重新检查并确认")?;
    if plan.prepared_at.elapsed().as_secs() >= PLAN_TTL_SECS || !same_plan_request(&plan.request, request) {
      return Err("同步范围已改变，请重新检查并确认".into());
    }
    Ok(plan)
  }

  pub fn prepare_resume(&self, app: &AppHandle) -> Result<SyncPlanPreview, String> {
    let (snapshot, pending, expected_targets) = {
      let guard = self.inner.lock();
      let task = guard.as_ref().ok_or("没有可继续的同步任务")?;
      if task.in_flight { return Err("正在完成当前文件，请稍后再继续".into()); }
      if !matches!(task.snapshot.status, SyncTaskStatus::Paused | SyncTaskStatus::Failed) {
        return Err("同步任务当前不需要继续".into());
      }
      (task.snapshot.clone(), task.pending.iter().cloned().collect::<Vec<_>>(), task.expected_targets.clone())
    };
    let (_, target_cfg) = source_pair(&snapshot.direction, &snapshot.left_source, &snapshot.right_source);
    let target = SourceSession::open(app, &target_cfg)?;
    for item in &pending {
      let expected = expected_targets.get(&item_key(item)).ok_or("恢复数据缺少目标校验，请清除任务并重新对比")?;
      assert_target_unchanged(expected, &target_fingerprint(&target, &assert_safe_relative(&item.relative_path)?)?, &item.relative_path)?;
    }
    let plan_id = Uuid::new_v4().to_string();
    let preview = plan_preview(plan_id.clone(), &pending, &expected_targets);
    *self.prepared_resume.lock() = Some(PreparedResume {
      plan_id, task_id: snapshot.id, pending_keys: pending.iter().map(item_key).collect(), prepared_at: Instant::now(),
    });
    Ok(preview)
  }

  pub fn start(&self, app: AppHandle, request: StartSyncRequest) -> Result<SyncTaskSnapshot, String> {
    let plan = self.take_plan(&request)?;
    let expected_task_id = {
      let guard = self.inner.lock();
      if let Some((id, keys)) = &plan.queue {
        if !guard.as_ref().map(|task| &task.snapshot.id == id && task.all_items.iter().map(item_key).collect::<HashSet<_>>() == *keys).unwrap_or(false) {
          return Err("同步队列已改变，请重新检查并确认".into());
        }
      }
      if let Some(task) = guard.as_ref() {
        if task.in_flight && task.snapshot.status != SyncTaskStatus::Running {
          return Err("正在完成当前文件，请稍后再创建同步任务".into());
        }
        if task.snapshot.status == SyncTaskStatus::Running {
          if sources_same(&task.snapshot.left_source, &request.left_source)
            && sources_same(&task.snapshot.right_source, &request.right_source)
            && task.snapshot.direction == request.direction
          {
            let task_id = task.snapshot.id.clone();
            drop(guard);
            return self.append_running(app, plan, &task_id);
          }
          return Err("已有同步任务正在运行".into());
        }
      }
      guard.as_ref().map(|task| task.snapshot.id.clone())
    };

    let all_items = plan.items;
    let pending = all_items.iter().cloned().collect();
    let timestamp = now_ms();
    let total_items = all_items.len() as u64;
    let status = if total_items == 0 {
      SyncTaskStatus::Completed
    } else {
      SyncTaskStatus::Running
    };

    let snapshot = SyncTaskSnapshot {
      id: Uuid::new_v4().to_string(),
      left_source: request.left_source.clone(),
      right_source: request.right_source.clone(),
      direction: request.direction.clone(),
      status,
      total_items,
      completed_items: 0,
      current_path: None,
      current_bytes: None,
      current_total_bytes: None,
      last_completed_path: None,
      last_error: None,
      created_at: timestamp,
      updated_at: timestamp,
      items: None,
      items_delta: false,
    };

    {
      let mut guard = self.inner.lock();
      if guard.as_ref().map(|task| &task.snapshot.id) != expected_task_id.as_ref()
        || guard.as_ref().map(|task| task.in_flight || task.snapshot.status == SyncTaskStatus::Running).unwrap_or(false) {
        return Err("同步队列已改变，请重新确认同步范围".into());
      }
      *guard = Some(InnerTask {
        snapshot: snapshot.clone(),
        pending,
        all_items,
        completed_keys: HashSet::new(),
        in_flight: false,
        pending_updates: HashMap::new(),
        expected_targets: plan.expected_targets,
      });
    }
    self.commit_progress(&app, true);

    if snapshot.status == SyncTaskStatus::Running {
      log_bridge::emit_log(
        &app,
        LogScope::Sync,
        LogLevel::Info,
        match request.direction {
          SyncDirection::LeftToRight => "开始同步: 左 -> 右",
          SyncDirection::RightToLeft => "开始同步: 右 -> 左",
        },
      );
      self.ensure_loop(app);
    } else {
      log_bridge::emit_log(&app, LogScope::Sync, LogLevel::Info, "同步完成（无变更）");
    }

    Ok(self.get_snapshot().unwrap_or(snapshot))
  }

  fn append_running(
    &self,
    app: AppHandle,
    plan: PreparedPlan,
    expected_task_id: &str,
  ) -> Result<SyncTaskSnapshot, String> {
    {
      let mut guard = self.inner.lock();
      let Some(task) = guard.as_mut() else {
        return Err("没有可追加的同步任务".into());
      };
      if task.snapshot.id != expected_task_id {
        return Err("同步队列已改变，请重试".into());
      }
      if let Some((_, keys)) = &plan.queue {
        if task.all_items.iter().map(item_key).collect::<HashSet<_>>() != *keys {
          return Err("同步队列已改变，请重新检查并确认".into());
        }
      }
      let mut existing: HashSet<String> = task
        .pending
        .iter()
        .chain(task.all_items.iter())
        .map(item_key)
        .collect();
      let mut appended = 0usize;
      for item in plan.items {
        if !existing.insert(item_key(&item)) {
          continue;
        }
        task.pending.push_back(item.clone());
        let key = item_key(&item);
        let expected = plan.expected_targets.get(&key).ok_or("同步计划缺少目标校验")?;
        task.expected_targets.insert(key, expected.clone());
        task.all_items.push(item);
        appended += 1;
      }
      task.snapshot.total_items = task.all_items.len() as u64;
      task.snapshot.updated_at = now_ms();
      // 展开远端目录期间未持锁，任务可能已在此窗口内完成；有新增项则重新置为运行中
      if appended > 0 && task.snapshot.status == SyncTaskStatus::Completed {
        task.snapshot.status = SyncTaskStatus::Running;
      }
      if appended > 0 {
        log_bridge::emit_log(
          &app,
          LogScope::Sync,
          LogLevel::Info,
          format!("追加同步项: {appended} 项"),
        );
      }
    }
    self.commit_progress(&app, true);
    self.ensure_loop(app);
    self.get_snapshot().ok_or_else(|| "同步任务丢失".into())
  }

  fn expand_items(
    &self,
    app: &AppHandle,
    request: &StartSyncRequest,
    seed_items: Vec<SyncItem>,
  ) -> Result<(VecDeque<SyncItem>, Vec<SyncItem>), String> {
    let (source_cfg, _) = source_pair(
      &request.direction,
      &request.left_source,
      &request.right_source,
    );
    let session = SourceSession::open(app, &source_cfg)?;
    let mut expanded_queue = VecDeque::from(seed_items);
    let mut collected = Vec::new();
    let mut seen = HashSet::new();
    while let Some(item) = expanded_queue.pop_front() {
      let safe = assert_safe_relative(&item.relative_path)?;
      let item = SyncItem {
        relative_path: safe,
        kind: item.kind.clone(),
      };
      if !seen.insert(item_key(&item)) { continue; }
      let meta = session.metadata(&item.relative_path)?.ok_or_else(|| format!("同步来源已不存在: {}", item.relative_path))?;
      if meta.is_symlink { return Err(format!("同步不支持符号链接: {}", item.relative_path)); }
      if meta.is_directory != (item.kind == SyncItemKind::Directory) {
        return Err(format!("同步来源类型已改变，请重新对比: {}", item.relative_path));
      }
      collected.push(item.clone());
      if item.kind == SyncItemKind::Directory {
        // 目录列取失败必须中止同步，静默按空目录处理会漏拷内容
        let children = session
          .list(&item.relative_path)
          .map_err(|e| format!("读取目录 {} 失败: {e}", item.relative_path))?;
        if let Some(link) = children.iter().find(|child| child.is_symlink) {
          return Err(format!("同步目录包含符号链接，请移除该项后重新对比: {}/{}", item.relative_path, link.name));
        }
        let child_pairs: Vec<(String, bool)> = children
          .into_iter()
          .map(|c| (c.name, c.is_directory))
          .collect();
        let expanded = expand_directory_entries(&item.relative_path, &child_pairs);
        for child in expanded.pending_items {
          expanded_queue.push_back(child);
        }
      }
    }
    collected.sort_by(|a, b| {
      let kind = (a.kind != SyncItemKind::Directory).cmp(&(b.kind != SyncItemKind::Directory));
      kind.then_with(|| a.relative_path.split('/').count().cmp(&b.relative_path.split('/').count()))
        .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    Ok((collected.iter().cloned().collect(), collected))
  }

  pub fn pause(&self, app: &AppHandle) -> Option<SyncTaskSnapshot> {
    {
      let mut guard = self.inner.lock();
      if let Some(task) = guard.as_mut() {
        if task.snapshot.status == SyncTaskStatus::Running {
          task.snapshot.status = SyncTaskStatus::Paused;
          if !task.in_flight { task.snapshot.current_path = None; }
          task.snapshot.updated_at = now_ms();
        }
      }
    }
    self.commit_progress(app, true);
    self.get_snapshot()
  }

  pub fn resume(&self, app: AppHandle, plan_id: Option<String>) -> Result<Option<SyncTaskSnapshot>, String> {
    if !self.resume_state(plan_id.as_deref())? { return Ok(self.get_snapshot()); }
    self.commit_progress(&app, true);
    self.ensure_loop(app);
    Ok(self.get_snapshot())
  }

  fn resume_state(&self, plan_id: Option<&str>) -> Result<bool, String> {
    let mut guard = self.inner.lock();
    let Some(task) = guard.as_mut() else { return Ok(false); };
    if task.snapshot.status == SyncTaskStatus::Completed || task.snapshot.status == SyncTaskStatus::Running { return Ok(false); }
    if task.in_flight { return Err("正在完成当前文件，请稍后再继续".into()); }
    let plan = self.prepared_resume.lock().take().ok_or("请先检查剩余同步范围并重新确认")?;
    if plan_id != Some(plan.plan_id.as_str()) || plan.task_id != task.snapshot.id
      || plan.prepared_at.elapsed().as_secs() >= PLAN_TTL_SECS
      || plan.pending_keys != task.pending.iter().map(item_key).collect::<Vec<_>>() {
      return Err("同步队列已改变，请重新检查并确认".into());
    }
    task.snapshot.status = SyncTaskStatus::Running;
    task.snapshot.last_error = None;
    task.snapshot.updated_at = now_ms();
    Ok(true)
  }

  fn clear_state(&self) -> Result<(), String> {
    let mut guard = self.inner.lock();
    if guard.as_ref().map(|task| task.snapshot.status == SyncTaskStatus::Running || task.in_flight).unwrap_or(false) {
      return Err("当前文件尚未完成，无法清除任务".into());
    }
    *guard = None;
    Ok(())
  }

  pub fn clear(&self, app: &AppHandle) -> Result<(), String> {
    let _progress = self.progress_lock.lock();
    self.clear_state()?;
    save_persisted(app, None);
    let _ = app.emit("sync:progress", Option::<SyncTaskSnapshot>::None);
    Ok(())
  }

  fn ensure_loop(&self, app: AppHandle) {
    {
      let mut running = self.loop_running.lock();
      if *running {
        return;
      }
      *running = true;
    }
    let manager = sync_manager();
    tauri::async_runtime::spawn_blocking(move || loop {
      manager.run_loop(app.clone());
      // 锁顺序与 ensure_loop 一致：先 loop_running 后 inner，避免丢失唤醒
      let mut running = manager.loop_running.lock();
      let has_work = manager
        .inner
        .lock()
        .as_ref()
        .map(|task| {
          task.snapshot.status == SyncTaskStatus::Running && !task.pending.is_empty()
        })
        .unwrap_or(false);
      if !has_work {
        *running = false;
        break;
      }
    });
  }

  fn run_loop(&self, app: AppHandle) {
    let (task_id, direction, left, right) = {
      let guard = self.inner.lock();
      let Some(task) = guard.as_ref() else {
        return;
      };
      if task.snapshot.status != SyncTaskStatus::Running {
        return;
      }
      (
        task.snapshot.id.clone(),
        task.snapshot.direction.clone(),
        task.snapshot.left_source.clone(),
        task.snapshot.right_source.clone(),
      )
    };

    let (source_cfg, target_cfg) = source_pair(&direction, &left, &right);
    let source = match SourceSession::open(&app, &source_cfg) {
      Ok(s) => s,
      Err(err) => {
        self.fail(&app, &task_id, err);
        return;
      }
    };
    let target = match SourceSession::open(&app, &target_cfg) {
      Ok(s) => s,
      Err(err) => {
        self.fail(&app, &task_id, err);
        return;
      }
    };
    // A separate connection permits validation while the writer owns its SFTP session lock.
    let verify_target = match SourceSession::open(&app, &target_cfg) {
      Ok(s) => s,
      Err(err) => { self.fail(&app, &task_id, err); return; }
    };

    loop {
      let item = {
        let mut guard = self.inner.lock();
        let Some(task) = guard.as_mut() else {
          break;
        };
        if task.snapshot.id != task_id || task.snapshot.status != SyncTaskStatus::Running {
          break;
        }
        // 仅窥视队首，成功后才真正出队，失败时保留在 pending 供 resume 重试
        let Some(item) = task.pending.front().cloned() else {
          task.snapshot.status = SyncTaskStatus::Completed;
          task.snapshot.current_path = None;
          task.snapshot.updated_at = now_ms();
          drop(guard);
          self.commit_progress(&app, true);
          log_bridge::emit_log(&app, LogScope::Sync, LogLevel::Info, "同步完成");
          break;
        };
        task.pending_updates.insert(item_key(&item), SyncTaskItemSnapshot {
          relative_path: item.relative_path.clone(), kind: item.kind.clone(), status: SyncTaskItemStatus::Running,
        });
        task.snapshot.current_bytes = None;
        task.snapshot.current_total_bytes = None;
        task.in_flight = true;
        task.snapshot.current_path = Some(item.relative_path.clone());
        task.snapshot.updated_at = now_ms();
        drop(guard);
        self.publish_progress(&app);
        item
      };

      let relative = match assert_safe_relative(&item.relative_path) {
        Ok(path) => path,
        Err(err) => {
          self.fail(&app, &task_id, err);
          break;
        }
      };

      let expected = self.inner.lock().as_ref()
        .and_then(|task| task.expected_targets.get(&item_key(&item)).cloned());
      let Some(expected) = expected else {
        self.fail(&app, &task_id, "恢复数据缺少目标校验，请清除任务并重新对比".into());
        break;
      };
      let mut verify = || {
        assert_target_unchanged(&expected, &target_fingerprint(&verify_target, &relative)?, &relative)
      };
      if let Err(err) = verify() {
        self.fail(&app, &task_id, err);
        break;
      }

      let exec = match item.kind {
        SyncItemKind::Directory => target.ensure_dir(&relative),
        SyncItemKind::File => {
          if let Some(parent) = parent_of(&relative) {
            if let Err(err) = target.ensure_dir(&parent) {
              self.fail(&app, &task_id, err);
              break;
            }
          }
          let mut last_update = Instant::now();
          copy_between_checked(&source, &target, &relative, &mut |bytes, total| {
            if bytes != total && last_update.elapsed().as_millis() < PROGRESS_NOTIFY_MS { return; }
            last_update = Instant::now();
            {
              let mut guard = self.inner.lock();
              if let Some(task) = guard.as_mut().filter(|task| task.snapshot.id == task_id) {
                task.snapshot.current_bytes = Some(bytes);
                task.snapshot.current_total_bytes = Some(total);
                task.snapshot.updated_at = now_ms();
              }
            }
            self.publish_progress(&app);
          }, &mut verify)
        }
      };

      if let Err(err) = exec {
        self.fail(&app, &task_id, err);
        break;
      }

      {
        let mut guard = self.inner.lock();
        let Some(task) = guard.as_mut() else {
          break;
        };
        if task.snapshot.id != task_id { break; }
        task.in_flight = false;
        task.snapshot.current_bytes = None;
        task.snapshot.current_total_bytes = None;
        task.pending.pop_front();
        task.pending_updates.insert(item_key(&item), SyncTaskItemSnapshot {
          relative_path: item.relative_path.clone(), kind: item.kind.clone(), status: SyncTaskItemStatus::Completed,
        });
        task.completed_keys.insert(item_key(&item));
        task.snapshot.completed_items += 1;
        task.snapshot.current_path = None;
        task.snapshot.last_completed_path.replace(relative);
        task.snapshot.updated_at = now_ms();
      }
      let paused = self.inner.lock().as_ref().map(|task| task.snapshot.status == SyncTaskStatus::Paused).unwrap_or(false);
      if paused { self.commit_progress(&app, true); } else { self.publish_progress(&app); }
    }
  }

  fn fail(&self, app: &AppHandle, task_id: &str, message: String) {
    log_bridge::emit_log(app, LogScope::Sync, LogLevel::Error, format!("同步失败: {message}"));
    {
      let mut guard = self.inner.lock();
      if let Some(task) = guard.as_mut() {
        if task.snapshot.id != task_id { return; }
        task.in_flight = false;
        task.snapshot.status = SyncTaskStatus::Failed;
        task.snapshot.current_path = None;
        task.snapshot.last_error = Some(message);
        task.snapshot.updated_at = now_ms();
      }
    }
    self.commit_progress(app, true);
  }

  fn publish_progress(&self, app: &AppHandle) {
    *self.dirty.lock() = true;
    let elapsed = self.last_notify.lock().elapsed().as_millis();
    if elapsed >= PROGRESS_NOTIFY_MS {
      self.commit_progress(app, false);
    }
  }

  fn commit_progress(&self, app: &AppHandle, force_persist: bool) {
    let _progress = self.progress_lock.lock();
    *self.dirty.lock() = false;
    *self.last_notify.lock() = Instant::now();

    let snapshot = {
      let mut guard = self.inner.lock();
      guard.as_mut().map(|task| {
        let mut snapshot = task.snapshot.clone();
        snapshot.items_delta = !force_persist;
        snapshot.items = Some(if force_persist {
          task.pending_updates.clear();
          build_item_snapshots(&task.all_items, &task.snapshot, &task.completed_keys)
        } else { task.pending_updates.drain().map(|(_, item)| item).collect() });
        snapshot
      })
    };
    let _ = app.emit("sync:progress", snapshot);

    let should_persist = force_persist
      || self.last_persist.lock().elapsed().as_millis() >= PERSIST_INTERVAL_MS;
    if should_persist {
      *self.last_persist.lock() = Instant::now();
      if let Some(task) = self.inner.lock().as_ref() {
        save_persisted(app, Some(&task.to_persisted()));
      } else {
        save_persisted(app, None);
      }
    }
  }
}

fn parent_of(relative: &str) -> Option<String> {
  let normalized = crate::path_utils::normalize_relative(relative);
  let mut parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
  if parts.len() <= 1 {
    return None;
  }
  parts.pop();
  Some(parts.join("/"))
}

fn same_plan_request(a: &StartSyncRequest, b: &StartSyncRequest) -> bool {
  a.compare_id == b.compare_id && a.direction == b.direction
    && sources_same(&a.left_source, &b.left_source) && sources_same(&a.right_source, &b.right_source)
    && serde_json::to_value(&a.entries).ok() == serde_json::to_value(&b.entries).ok()
}

fn capture_targets(session: &SourceSession<'_>, items: &[SyncItem]) -> Result<HashMap<String, TargetFingerprint>, String> {
  let mut expected = HashMap::new();
  for item in items {
    let fingerprint = target_fingerprint(session, &item.relative_path)?;
    if matches!((&item.kind, &fingerprint), (SyncItemKind::File, TargetFingerprint::Directory) | (SyncItemKind::Directory, TargetFingerprint::File { .. })) {
      return Err(format!("目标同名项的文件类型冲突，请先处理后重新对比: {}", item.relative_path));
    }
    expected.insert(item_key(item), fingerprint);
  }
  Ok(expected)
}

fn plan_preview(plan_id: String, items: &[SyncItem], expected: &HashMap<String, TargetFingerprint>) -> SyncPlanPreview {
  SyncPlanPreview {
    plan_id,
    files: items.iter().filter(|item| item.kind == SyncItemKind::File).count() as u64,
    directories: items.iter().filter(|item| item.kind == SyncItemKind::Directory).count() as u64,
    overwrites: items.iter().filter(|item| item.kind == SyncItemKind::File && matches!(expected.get(&item_key(item)), Some(TargetFingerprint::File { .. }))).count() as u64,
  }
}

fn derive_completed_keys(all: &[SyncItem], pending: &VecDeque<SyncItem>) -> HashSet<String> {
  let pending_keys: HashSet<String> = pending.iter().map(item_key).collect();
  all
    .iter()
    .map(item_key)
    .filter(|key| !pending_keys.contains(key))
    .collect()
}

fn build_item_snapshots(
  all: &[SyncItem],
  task: &SyncTaskSnapshot,
  completed_keys: &HashSet<String>,
) -> Vec<SyncTaskItemSnapshot> {
  all
    .iter()
    .map(|item| {
      let status = if completed_keys.contains(&item_key(item)) {
        SyncTaskItemStatus::Completed
      } else if matches!(task.status, SyncTaskStatus::Running | SyncTaskStatus::Paused)
        && task.current_path.as_deref() == Some(item.relative_path.as_str())
      {
        SyncTaskItemStatus::Running
      } else {
        SyncTaskItemStatus::Pending
      };
      SyncTaskItemSnapshot {
        relative_path: item.relative_path.clone(),
        kind: item.kind.clone(),
        status,
      }
    })
    .collect()
}

static SYNC_MANAGER: once_cell::sync::Lazy<Arc<SyncManager>> =
  once_cell::sync::Lazy::new(|| Arc::new(SyncManager::new()));

pub fn sync_manager() -> Arc<SyncManager> {
  SYNC_MANAGER.clone()
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;
