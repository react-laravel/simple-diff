use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
  pub name: String,
  pub path: String,
  pub is_directory: bool,
  #[serde(default)]
  pub is_symlink: bool,
  pub size: u64,
  pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshBrowseResult {
  pub path: String,
  pub root_path: String,
  pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SourceConfig {
  #[serde(rename = "local")]
  Local { path: String },
  #[serde(rename = "sftp")]
  Sftp {
    #[serde(rename = "configId")]
    config_id: String,
    path: String,
  },
}

impl SourceConfig {
  pub fn as_local_path(&self) -> Result<&str, String> {
    match self {
      Self::Local { path } => Ok(path),
      Self::Sftp { .. } => Err("需要本地路径".into()),
    }
  }

  pub fn is_local(&self) -> bool {
    matches!(self, Self::Local { .. })
  }

  #[allow(dead_code)]
  pub fn sftp_config_id(&self) -> Option<&str> {
    match self {
      Self::Sftp { config_id, .. } => Some(config_id),
      _ => None,
    }
  }

  #[allow(dead_code)]
  pub fn root_path(&self) -> &str {
    match self {
      Self::Local { path } => path,
      Self::Sftp { path, .. } => path,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompareState {
  Pending,
  Comparing,
  Equal,
  LeftOnly,
  RightOnly,
  Different,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DiffReason {
  Type {
    #[serde(rename = "leftType")]
    left_type: String,
    #[serde(rename = "rightType")]
    right_type: String,
  },
  Size {
    #[serde(rename = "leftSize")]
    left_size: u64,
    #[serde(rename = "rightSize")]
    right_size: u64,
  },
  Mtime {
    #[serde(rename = "leftMtime")]
    left_mtime: u64,
    #[serde(rename = "rightMtime")]
    right_mtime: u64,
  },
  Hash {
    #[serde(rename = "leftHash")]
    left_hash: String,
    #[serde(rename = "rightHash")]
    right_hash: String,
  },
  QuickHash {
    #[serde(rename = "leftHash")]
    left_hash: String,
    #[serde(rename = "rightHash")]
    right_hash: String,
  },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StrategyName {
  Size,
  Mtime,
  Hash,
  QuickHash,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareEntry {
  pub relative_path: String,
  pub name: String,
  pub is_directory: bool,
  pub state: CompareState,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub left: Option<FileEntry>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub right: Option<FileEntry>,
  pub reasons: Vec<DiffReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareFileFingerprint {
  pub is_directory: bool,
  #[serde(default)]
  pub is_symlink: bool,
  pub size: u64,
  pub mtime: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareCacheEntry {
  pub relative_path: String,
  pub state: CompareState,
  pub left: CompareFileFingerprint,
  pub right: CompareFileFingerprint,
  pub reasons: Vec<DiffReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareRequest {
  pub compare_id: String,
  pub left: SourceConfig,
  pub right: SourceConfig,
  pub strategies: Vec<StrategyName>,
  pub extension_filter: Option<Vec<String>>,
  pub previous_entries: Option<Vec<CompareCacheEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComparePartialRequest {
  /// 原始全量对比会话 id；提供时局部结果会并入该会话的受信任映射
  pub compare_id: Option<String>,
  pub left: SourceConfig,
  pub right: SourceConfig,
  pub relative_roots: Vec<String>,
  pub strategies: Vec<StrategyName>,
  pub extension_filter: Option<Vec<String>>,
  pub previous_entries: Option<Vec<CompareCacheEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareLocalWatchRequest {
  pub session_id: String,
  pub left: SourceConfig,
  pub right: SourceConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareStats {
  pub total: u64,
  pub equal: u64,
  pub different: u64,
  pub left_only: u64,
  pub right_only: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareResult {
  pub entries: Vec<CompareEntry>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub entries_included: Option<bool>,
  pub stats: CompareStats,
  pub duration: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub left_source: Option<SourceConfig>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub right_source: Option<SourceConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcResult<T> {
  pub success: bool,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub data: Option<T>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub error: Option<String>,
}

impl<T> IpcResult<T> {
  pub fn ok(data: T) -> Self {
    Self {
      success: true,
      data: Some(data),
      error: None,
    }
  }

  pub fn err(message: impl Into<String>) -> Self {
    Self {
      success: false,
      data: None,
      error: Some(message.into()),
    }
  }
}

impl IpcResult<()> {
  pub fn ok_empty() -> Self {
    Self {
      success: true,
      data: None,
      error: None,
    }
  }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncDirection {
  LeftToRight,
  RightToLeft,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncTaskStatus {
  Running,
  Paused,
  Completed,
  Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncItemKind {
  Directory,
  File,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncTaskItemStatus {
  Pending,
  Running,
  Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
  pub relative_path: String,
  pub kind: SyncItemKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTaskItemSnapshot {
  pub relative_path: String,
  pub kind: SyncItemKind,
  pub status: SyncTaskItemStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTaskSnapshot {
  pub id: String,
  pub left_source: SourceConfig,
  pub right_source: SourceConfig,
  pub direction: SyncDirection,
  pub status: SyncTaskStatus,
  pub total_items: u64,
  pub completed_items: u64,
  pub current_path: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub current_bytes: Option<u64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub current_total_bytes: Option<u64>,
  pub last_completed_path: Option<String>,
  pub last_error: Option<String>,
  pub created_at: u64,
  pub updated_at: u64,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub items: Option<Vec<SyncTaskItemSnapshot>>,
  #[serde(default)]
  pub items_delta: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSyncRequest {
  pub compare_id: String,
  pub left_source: SourceConfig,
  pub right_source: SourceConfig,
  pub direction: SyncDirection,
  pub entries: Vec<CompareEntry>,
  #[serde(default)]
  pub plan_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlanPreview {
  pub plan_id: String,
  pub files: u64,
  pub directories: u64,
  pub overwrites: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareHistoryEntry {
  pub id: String,
  pub timestamp: u64,
  pub left_label: String,
  pub right_label: String,
  pub left_source: SourceConfig,
  pub right_source: SourceConfig,
  pub stats: CompareStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
  Info,
  Warn,
  Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LogScope {
  App,
  Compare,
  #[serde(rename = "compare-watch")]
  CompareWatch,
  Sync,
  Ssh,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
  pub timestamp: u64,
  pub level: LogLevel,
  pub scope: LogScope,
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshAuthType {
  Password,
  PrivateKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
  pub id: String,
  pub label: String,
  pub host: String,
  pub port: u16,
  pub username: String,
  pub auth_type: SshAuthType,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigInput {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub id: Option<String>,
  pub label: String,
  pub host: String,
  pub port: u16,
  pub username: String,
  pub auth_type: SshAuthType,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub password: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub private_key_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigInternal {
  pub id: String,
  pub label: String,
  pub host: String,
  pub port: u16,
  pub username: String,
  pub auth_type: SshAuthType,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub default_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub password: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub private_key_path: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub passphrase: Option<String>,
}
