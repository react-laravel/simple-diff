use super::*;

fn install_task(manager: &SyncManager, status: SyncTaskStatus, in_flight: bool) {
  *manager.inner.lock() = Some(InnerTask {
    snapshot: snapshot_with(status, if in_flight { Some("a.txt") } else { None }),
    pending: vec![file_item("a.txt")].into(),
    all_items: vec![file_item("a.txt")],
    completed_keys: HashSet::new(),
    in_flight,
    pending_updates: HashMap::new(),
    expected_targets: [(item_key(&file_item("a.txt")), TargetFingerprint::Missing)].into(),
  });
}

#[test]
fn resuming_running_and_completed_tasks_is_idempotent_and_releases_lock() {
  let manager = SyncManager::new();
  for status in [SyncTaskStatus::Running, SyncTaskStatus::Completed] {
    install_task(&manager, status.clone(), false);
    assert!(!manager.resume_state(None).unwrap());
    assert!(manager.inner.try_lock().is_some());
    assert_eq!(manager.get_snapshot().unwrap().status, status);
  }
  install_task(&manager, SyncTaskStatus::Failed, false);
  assert!(manager.resume_state(None).is_err());
  *manager.prepared_resume.lock() = Some(PreparedResume {
    plan_id: "confirmed".into(), task_id: "task".into(), pending_keys: vec![item_key(&file_item("a.txt"))], prepared_at: Instant::now(),
  });
  assert!(manager.resume_state(Some("confirmed")).unwrap());
  assert_eq!(
    manager.get_snapshot().unwrap().status,
    SyncTaskStatus::Running
  );
}

#[test]
fn target_content_changes_are_detected_even_if_size_and_mtime_match() {
  let expected = TargetFingerprint::File { size: 3, mtime: 100, sha256: "old".into() };
  let changed = TargetFingerprint::File { size: 3, mtime: 100, sha256: "new".into() };
  assert!(assert_target_unchanged(&expected, &changed, "a.txt").is_err());
  assert!(assert_target_unchanged(&TargetFingerprint::Missing, &expected, "a.txt").is_err());
  assert!(assert_target_unchanged(&expected, &TargetFingerprint::Missing, "a.txt").is_err());
  assert!(assert_target_unchanged(&expected, &expected, "a.txt").is_ok());
}

#[test]
fn preview_counts_every_expanded_file_and_actual_overwrite() {
  let items = vec![dir_item("dir"), dir_item("dir/nested"), file_item("dir/a"), file_item("dir/nested/b")];
  let expected = [
    (item_key(&items[0]), TargetFingerprint::Missing),
    (item_key(&items[1]), TargetFingerprint::Directory),
    (item_key(&items[2]), TargetFingerprint::File { size: 1, mtime: 1, sha256: "hash".into() }),
    (item_key(&items[3]), TargetFingerprint::Missing),
  ].into();
  let preview = plan_preview("plan".into(), &items, &expected);
  assert_eq!((preview.files, preview.directories, preview.overwrites), (2, 2, 1));
}

#[test]
fn restored_or_changed_queue_cannot_resume_without_new_valid_confirmation() {
  let manager = SyncManager::new();
  install_task(&manager, SyncTaskStatus::Paused, false);
  assert!(manager.resume_state(None).is_err());
  assert_eq!(manager.get_snapshot().unwrap().status, SyncTaskStatus::Paused);
  *manager.prepared_resume.lock() = Some(PreparedResume {
    plan_id: "confirmed".into(), task_id: "task".into(), pending_keys: vec![item_key(&file_item("different.txt"))], prepared_at: Instant::now(),
  });
  assert!(manager.resume_state(Some("confirmed")).is_err());
  assert_eq!(manager.get_snapshot().unwrap().status, SyncTaskStatus::Paused);
}

#[test]
fn confirmation_plan_is_bound_to_request_and_cannot_be_reused() {
  let manager = SyncManager::new();
  let mut request = StartSyncRequest { compare_id: "compare".into(), left_source: SourceConfig::Local { path: "/l".into() }, right_source: SourceConfig::Local { path: "/r".into() }, direction: SyncDirection::LeftToRight, entries: vec![], plan_id: None };
  assert!(manager.take_plan(&request).is_err());
  manager.prepared.lock().insert("plan".into(), PreparedPlan { request: request.clone(), items: vec![], expected_targets: HashMap::new(), prepared_at: Instant::now(), queue: None });
  request.plan_id = Some("plan".into());
  assert!(manager.take_plan(&request).is_ok());
  assert!(manager.take_plan(&request).is_err());
  let original = request.clone();
  manager.prepared.lock().insert("changed".into(), PreparedPlan { request: original, items: vec![], expected_targets: HashMap::new(), prepared_at: Instant::now(), queue: None });
  request.plan_id = Some("changed".into());
  request.right_source = SourceConfig::Local { path: "/other".into() };
  assert!(manager.take_plan(&request).is_err());
}

#[test]
fn paused_in_flight_transfer_cannot_be_cleared_or_replaced() {
  let manager = SyncManager::new();
  install_task(&manager, SyncTaskStatus::Paused, true);
  assert!(manager.clear_state().is_err());
  assert_eq!(
    manager.get_snapshot().unwrap().current_path.as_deref(),
    Some("a.txt")
  );
  manager.inner.lock().as_mut().unwrap().in_flight = false;
  assert!(manager.clear_state().is_ok());
  assert!(manager.get_snapshot().is_none());
}

fn file_item(path: &str) -> SyncItem {
  SyncItem {
    relative_path: path.into(),
    kind: SyncItemKind::File,
  }
}

fn dir_item(path: &str) -> SyncItem {
  SyncItem {
    relative_path: path.into(),
    kind: SyncItemKind::Directory,
  }
}

fn snapshot_with(status: SyncTaskStatus, current_path: Option<&str>) -> SyncTaskSnapshot {
  SyncTaskSnapshot {
    id: "task".into(),
    left_source: SourceConfig::Local { path: "/l".into() },
    right_source: SourceConfig::Local { path: "/r".into() },
    direction: SyncDirection::LeftToRight,
    status,
    total_items: 0,
    completed_items: 0,
    current_path: current_path.map(|p| p.to_string()),
    current_bytes: None,
    current_total_bytes: None,
    last_completed_path: None,
    last_error: None,
    created_at: 0,
    updated_at: 0,
    items: None,
    items_delta: false,
  }
}

#[test]
fn item_key_distinguishes_kind() {
  assert_ne!(item_key(&dir_item("x")), item_key(&file_item("x")));
}

#[test]
fn build_item_snapshots_uses_completed_keys_not_index() {
  let all = vec![file_item("a.txt"), file_item("b.txt"), file_item("c.txt")];
  let mut task = snapshot_with(SyncTaskStatus::Running, Some("a.txt"));
  task.completed_items = 1;
  // 完成顺序与 all_items 顺序不一致：只有 b.txt 已完成
  let completed: HashSet<String> = [item_key(&all[1])].into_iter().collect();
  let items = build_item_snapshots(&all, &task, &completed);
  assert_eq!(items[0].status, SyncTaskItemStatus::Running);
  assert_eq!(items[1].status, SyncTaskItemStatus::Completed);
  assert_eq!(items[2].status, SyncTaskItemStatus::Pending);
}

#[test]
fn build_item_snapshots_keeps_paused_in_flight_file_running() {
  let all = vec![file_item("a.txt")];
  let task = snapshot_with(SyncTaskStatus::Paused, Some("a.txt"));
  let items = build_item_snapshots(&all, &task, &HashSet::new());
  assert_eq!(items[0].status, SyncTaskItemStatus::Running);
}

#[test]
fn derive_completed_keys_excludes_pending_items() {
  let all = vec![
    dir_item("dir"),
    file_item("dir/a.txt"),
    file_item("dir/b.txt"),
  ];
  let pending: VecDeque<SyncItem> = vec![file_item("dir/a.txt"), file_item("dir/b.txt")].into();
  let keys = derive_completed_keys(&all, &pending);
  assert_eq!(keys.len(), 1);
  assert!(keys.contains(&item_key(&all[0])));
  assert!(!keys.contains(&item_key(&all[1])));
}
