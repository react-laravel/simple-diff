use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use ssh2::{OpenFlags, OpenType, Session, Sftp};

use crate::path_utils::{normalize_relative, normalize_relative_safe};
use crate::ssh_pool::PooledConn;
use crate::types::{FileEntry, SourceConfig, SshAuthType, SshBrowseResult, SshConfigInternal};

const CONNECT_TIMEOUT_SECS: u64 = 10;
const KEEPALIVE_INTERVAL_SECS: u32 = 30;
const META_TIMEOUT_MS: u32 = 20_000;
const STREAM_TIMEOUT_MS: u32 = 60_000;
const MAX_ATTEMPTS: u32 = 2;
const QUICK_HASH_CHUNK: usize = 64 * 1024;
const SYMLINK_MODE: u32 = 0o120_000;
const FILE_TYPE_MASK: u32 = 0o170_000;
const DIRECTORY_MODE: u32 = 0o040_000;

fn expand_home(path: &str) -> PathBuf {
  if let Some(rest) = path.strip_prefix("~/") {
    if let Some(home) = dirs::home_dir() {
      return home.join(rest);
    }
  }
  if path == "~" {
    if let Some(home) = dirs::home_dir() {
      return home;
    }
  }
  PathBuf::from(path)
}

fn find_default_key() -> Option<PathBuf> {
  let home = dirs::home_dir()?;
  let ssh_dir = home.join(".ssh");
  for name in ["id_ed25519", "id_rsa", "id_ecdsa"] {
    let path = ssh_dir.join(name);
    if path.exists() {
      return Some(path);
    }
  }
  None
}

/// True when the error string suggests a transient SSH/SFTP failure worth retrying.
pub fn is_retryable(err: &str) -> bool {
  let lower = err.to_lowercase();
  lower.contains("channel closed")
    || lower.contains("channel has been closed")
    || (lower.contains("channel") && lower.contains("closed"))
    || lower.contains("not connected")
    || lower.contains("timeout")
    || lower.contains("timed out")
    || lower.contains("no response")
    || lower.contains("connection reset")
    || lower.contains("connection aborted")
    || lower.contains("session has been closed")
    || lower.contains("socket is not connected")
}

/// Broader connection failure — pool should invalidate.
pub fn is_connection_error(err: &str) -> bool {
  let lower = err.to_lowercase();
  is_retryable(err)
    || lower.contains("broken pipe")
    || (lower.contains("ssh") && lower.contains("fail"))
}

fn with_sftp_retry<T>(
  session: &Session,
  timeout_ms: u32,
  mut op: impl FnMut(&Sftp) -> Result<T, String>,
) -> Result<T, String> {
  session.set_timeout(timeout_ms);
  let mut last_err = String::from("SFTP 操作失败");
  for attempt in 0..MAX_ATTEMPTS {
    let sftp = match session.sftp() {
      Ok(s) => s,
      Err(e) => {
        last_err = format!("打开 SFTP 失败: {e}");
        if attempt + 1 < MAX_ATTEMPTS && is_retryable(&last_err) {
          continue;
        }
        return Err(last_err);
      }
    };
    match op(&sftp) {
      Ok(v) => return Ok(v),
      Err(e) => {
        last_err = e;
        if attempt + 1 < MAX_ATTEMPTS && is_retryable(&last_err) {
          continue;
        }
        return Err(last_err);
      }
    }
  }
  Err(last_err)
}

pub fn connect_session(config: &SshConfigInternal) -> Result<Session, String> {
  let known_hosts = dirs::home_dir()
    .ok_or("无法读取用户 SSH 信任目录")?
    .join(".ssh/known_hosts");
  connect_session_with_known_hosts(config, &known_hosts)
}

fn connect_session_with_known_hosts(
  config: &SshConfigInternal,
  known_hosts: &Path,
) -> Result<Session, String> {
  use std::net::ToSocketAddrs;

  let addr = format!("{}:{}", config.host, config.port);
  let socket = addr
    .to_socket_addrs()
    .map_err(|e| format!("解析地址 {addr} 失败: {e}"))?
    .next()
    .ok_or_else(|| format!("无法解析地址 {addr}"))?;
  let tcp = TcpStream::connect_timeout(&socket, Duration::from_secs(CONNECT_TIMEOUT_SECS))
    .map_err(|e| format!("连接 {addr} 失败: {e}"))?;
  tcp.set_read_timeout(Some(Duration::from_secs(30))).ok();
  tcp.set_write_timeout(Some(Duration::from_secs(30))).ok();

  let mut session = Session::new().map_err(|e| format!("创建 SSH 会话失败: {e}"))?;
  session.set_tcp_stream(tcp);
  session
    .handshake()
    .map_err(|e| format!("SSH 握手失败: {e}"))?;

  crate::ssh_host_key::verify(&session, &config.host, config.port, known_hosts)?;

  match config.auth_type {
    SshAuthType::Password => {
      let password = config
        .password
        .as_deref()
        .ok_or_else(|| "未设置密码".to_string())?;
      session
        .userauth_password(&config.username, password)
        .map_err(|e| format!("密码认证失败: {e}"))?;
    }
    SshAuthType::PrivateKey => {
      authenticate_private_key(&session, config)?;
    }
  }

  if !session.authenticated() {
    return Err("SSH 认证失败".into());
  }

  session.set_keepalive(true, KEEPALIVE_INTERVAL_SECS);
  session.set_timeout(META_TIMEOUT_MS);

  Ok(session)
}

fn authenticate_private_key(session: &Session, config: &SshConfigInternal) -> Result<(), String> {
  let key_path = config
    .private_key_path
    .as_deref()
    .map(expand_home)
    .or_else(find_default_key);

  if let Some(key_path) = key_path {
    let passphrase = config.passphrase.as_deref();
    return session
      .userauth_pubkey_file(&config.username, None, &key_path, passphrase)
      .map_err(|e| format!("私钥认证失败: {e}"));
  }

  // No key file: try SSH agent when SSH_AUTH_SOCK is available.
  if std::env::var_os("SSH_AUTH_SOCK").is_some() {
    return session
      .userauth_agent(&config.username)
      .map_err(|e| format!("SSH Agent 认证失败: {e}"));
  }

  Err("未找到私钥，且未配置 SSH Agent (SSH_AUTH_SOCK)".into())
}

pub fn test_connection(config: &SshConfigInternal) -> Result<bool, String> {
  connect_session(config).map(|_| true)
}

fn is_directory_mode(mode: u32) -> bool {
  (mode & FILE_TYPE_MASK) == DIRECTORY_MODE
}

fn is_symlink_mode(mode: u32) -> bool {
  (mode & FILE_TYPE_MASK) == SYMLINK_MODE
}

fn remote_join(root: &str, relative: &str) -> Result<String, String> {
  let relative = normalize_relative_safe(relative)?;
  crate::path_guards::resolve_allowed_remote(root, &relative)
}

/// Resolve the selected root once through realpath, then refuse symlinks in
/// descendants. A leaf link is allowed only for metadata, unlink and rename.
fn checked_remote_path(
  sftp: &Sftp,
  root: &str,
  relative: &str,
  allow_leaf_link: bool,
  allow_missing: bool,
) -> Result<String, String> {
  let lexical = remote_join(root, relative)?;
  let root = crate::path_guards::posix_resolve(if root.is_empty() { "/" } else { root });
  let relative = lexical
    .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
    .unwrap_or(if lexical == root { "" } else { &lexical });
  let canonical = sftp
    .realpath(Path::new(&root))
    .map_err(|e| format!("无法解析远程根目录: {e}"))?;
  let root_stat = sftp
    .lstat(&canonical)
    .map_err(|e| format!("读取远程根目录失败: {e}"))?;
  if !is_directory_mode(root_stat.perm.unwrap_or(0)) {
    return Err("远程根路径不是目录".into());
  }
  let mut current = canonical;
  let parts: Vec<_> = relative
    .split('/')
    .filter(|part| !part.is_empty())
    .collect();
  for (index, part) in parts.iter().enumerate() {
    current.push(part);
    match sftp.lstat(&current) {
      Ok(stat)
        if is_symlink_mode(stat.perm.unwrap_or(0))
          && !(allow_leaf_link && index + 1 == parts.len()) =>
      {
        return Err("不允许通过远程符号链接访问文件或目录".into())
      }
      Ok(stat) if index + 1 < parts.len() && !is_directory_mode(stat.perm.unwrap_or(0)) => {
        return Err("远程父路径不是目录".into())
      }
      Ok(_) => {}
      Err(error) if allow_missing && error.code() == ssh2::ErrorCode::SFTP(2) => {}
      Err(error) => return Err(format!("读取远程文件信息失败: {error}")),
    }
  }
  Ok(current.to_string_lossy().into_owned())
}

fn resolve_list_entry(stat: &ssh2::FileStat) -> (bool, bool, u64, u64) {
  let mode = stat.perm.unwrap_or(0);
  let is_link = is_symlink_mode(mode);
  let is_dir = is_directory_mode(mode) && !is_link;
  (
    is_dir,
    is_link,
    if is_dir { 0 } else { stat.size.unwrap_or(0) },
    stat.mtime.unwrap_or(0).saturating_mul(1000),
  )
}

pub fn remote_metadata(
  session: &Session,
  root: &str,
  relative: &str,
) -> Result<Option<FileEntry>, String> {
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, relative, true, true)?;
    let stat = match sftp.lstat(Path::new(&abs)) {
      Ok(stat) => stat,
      Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => return Ok(None),
      Err(error) => return Err(format!("读取远程文件信息失败: {error}")),
    };
    let (is_directory, is_symlink, size, mtime) = resolve_list_entry(&stat);
    Ok(Some(FileEntry {
      name: Path::new(&abs)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default(),
      path: normalize_relative(relative),
      is_directory,
      is_symlink,
      size,
      mtime,
    }))
  })
}

pub fn list_remote(
  session: &Session,
  root: &str,
  relative: &str,
) -> Result<Vec<FileEntry>, String> {
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, relative, false, true)?;
    let stat = match sftp.lstat(Path::new(&abs)) {
      Ok(stat) => stat,
      Err(error) if !relative.is_empty() && error.code() == ssh2::ErrorCode::SFTP(2) => {
        return Ok(Vec::new())
      }
      Err(error) => return Err(format!("读取远程目录失败: {error}")),
    };
    if !is_directory_mode(stat.perm.unwrap_or(0)) {
      return Err("不是远程目录".into());
    }
    let entries = sftp
      .readdir(Path::new(&abs))
      .map_err(|e| format!("读取远程目录失败 ({abs}): {e}"))?;

    let mut result = Vec::new();
    for (path, stat) in entries {
      let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
      if name == "." || name == ".." || name.is_empty() {
        continue;
      }
      let rel = if relative.is_empty() {
        name.clone()
      } else {
        format!("{relative}/{name}")
      };
      let (is_directory, is_symlink, size, mtime) = resolve_list_entry(&stat);
      result.push(FileEntry {
        name,
        path: normalize_relative(&rel),
        is_directory,
        is_symlink,
        size,
        mtime,
      });
    }

    result.sort_by(|a, b| match (a.is_directory, b.is_directory) {
      (true, false) => std::cmp::Ordering::Less,
      (false, true) => std::cmp::Ordering::Greater,
      _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(result)
  })
}

pub fn browse_remote(
  session: &Session,
  root: &str,
  dir_path: &str,
) -> Result<SshBrowseResult, String> {
  let sftp = session.sftp().map_err(|e| format!("打开 SFTP 失败: {e}"))?;
  let root_path = sftp
    .realpath(Path::new(&remote_join(root, "")?))
    .map_err(|e| format!("无法解析远程根目录: {e}"))?
    .to_string_lossy()
    .into_owned();
  let original = SourceConfig::Sftp {
    config_id: String::new(),
    path: root.into(),
  };
  let canonical = SourceConfig::Sftp {
    config_id: String::new(),
    path: root_path.clone(),
  };
  let relative = if dir_path.is_empty() {
    String::new()
  } else {
    crate::path_guards::relative_under_source(&original, dir_path)
      .or_else(|_| crate::path_guards::relative_under_source(&canonical, dir_path))?
  };
  let path = checked_remote_path(&sftp, &root_path, &relative, false, false)?;
  let entries = list_remote(session, &root_path, &relative)?;
  Ok(SshBrowseResult {
    path,
    root_path,
    entries,
  })
}

pub fn remote_link_target(session: &Session, root: &str, relative: &str) -> Result<String, String> {
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, relative, true, false)?;
    sftp
      .readlink(Path::new(&abs))
      .map(|path| path.to_string_lossy().into_owned())
      .map_err(|e| format!("读取远程符号链接失败: {e}"))
  })
}

pub fn read_remote_text(session: &Session, root: &str, relative: &str) -> Result<String, String> {
  let file = open_remote_reader(session, root, relative)?;
  crate::files::read_text_limited(file)
}

pub fn remote_exists(session: &Session, root: &str, relative: &str) -> Result<bool, String> {
  Ok(remote_metadata(session, root, relative)?.is_some())
}

pub fn write_remote_bytes(
  session: &Session,
  root: &str,
  relative: &str,
  content: &[u8],
) -> Result<(), String> {
  write_remote_stream(session, root, relative, &mut &content[..])
}

pub fn open_remote_reader(
  session: &Session,
  root: &str,
  relative: &str,
) -> Result<ssh2::File, String> {
  session.set_timeout(STREAM_TIMEOUT_MS);
  let sftp = session.sftp().map_err(|e| format!("打开 SFTP 失败: {e}"))?;
  let abs = checked_remote_path(&sftp, root, relative, false, false)?;
  sftp
    .open(Path::new(&abs))
    .map_err(|e| format!("读取远程文件失败: {e}"))
}

pub fn write_remote_stream(
  session: &Session,
  root: &str,
  relative: &str,
  reader: &mut dyn Read,
) -> Result<(), String> {
  write_remote_stream_with_metadata(session, root, relative, reader, None, None, &mut |_| {})
}

pub fn write_remote_stream_with_metadata(
  session: &Session,
  root: &str,
  relative: &str,
  reader: &mut dyn Read,
  permissions: Option<u32>,
  modified: Option<std::time::SystemTime>,
  progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
  write_remote_stream_with_metadata_checked(
    session,
    root,
    relative,
    reader,
    permissions,
    modified,
    progress,
    &mut || Ok(()),
  )
}

pub fn write_remote_stream_with_metadata_checked(
  session: &Session,
  root: &str,
  relative: &str,
  reader: &mut dyn Read,
  permissions: Option<u32>,
  modified: Option<std::time::SystemTime>,
  progress: &mut dyn FnMut(u64),
  before_commit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
  ensure_remote_dir(session, root, &parent_relative(relative))?;
  session.set_timeout(STREAM_TIMEOUT_MS);
  let sftp = session.sftp().map_err(|e| format!("打开 SFTP 失败: {e}"))?;
  let target = PathBuf::from(checked_remote_path(&sftp, root, relative, false, true)?);
  let parent = target.parent().ok_or("无效远程路径")?;
  let temp = parent.join(format!(".simple-diff-{}.tmp", uuid::Uuid::new_v4()));
  let original = sftp.stat(&target).ok();
  let result = (|| {
    let mut file = sftp
      .open_mode(
        &temp,
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUSIVE,
        0o600,
        OpenType::File,
      )
      .map_err(|e| format!("创建远程临时文件失败: {e}"))?;
    crate::atomic_file::copy_buffered_with_progress(reader, &mut file, progress)
      .map_err(|e| format!("传输文件失败: {e}"))?;
    let permissions = permissions.or_else(|| original.as_ref().and_then(|stat| stat.perm));
    let mtime = modified
      .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
      .map(|time| time.as_secs());
    if permissions.is_some() || mtime.is_some() {
      file
        .setstat(ssh2::FileStat {
          size: None,
          uid: None,
          gid: None,
          perm: permissions,
          atime: mtime,
          mtime,
        })
        .map_err(|e| format!("保留远程文件信息失败: {e}"))?;
    }
    file.close().map_err(|e| format!("关闭远程文件失败: {e}"))?;
    before_commit()?;
    // Revalidate parent/leaf after transferring the temporary file.
    if PathBuf::from(checked_remote_path(&sftp, root, relative, false, true)?) != target {
      return Err("远程根目录已改变，已停止覆盖".into());
    }
    if original.is_some() {
      crate::sftp_atomic::rename(session, &temp, &target)
    } else {
      sftp
        .rename(&temp, &target, Some(ssh2::RenameFlags::empty()))
        .map_err(|e| format!("远程重命名失败: {e}"))
    }
  })();
  if result.is_err() {
    let _ = sftp.unlink(&temp);
  }
  result
}

pub fn write_remote_text(
  session: &Session,
  root: &str,
  relative: &str,
  content: &str,
) -> Result<(), String> {
  write_remote_bytes(session, root, relative, content.as_bytes())
}

fn parent_relative(relative: &str) -> String {
  let normalized = normalize_relative(relative);
  if normalized.is_empty() {
    return String::new();
  }
  let mut parts: Vec<&str> = normalized.split('/').collect();
  if parts.len() <= 1 {
    return String::new();
  }
  parts.pop();
  parts.join("/")
}

fn mkdir_all(
  sftp: &Sftp,
  root: &str,
  relative: &str,
  known_dirs: &mut HashSet<String>,
) -> Result<(), String> {
  let relative = normalize_relative_safe(relative)?;
  let canonical = sftp
    .realpath(Path::new(&remote_join(root, "")?))
    .map_err(|e| format!("无法解析远程根目录: {e}"))?;
  let mut current = canonical;
  for segment in relative.split('/').filter(|part| !part.is_empty()) {
    current.push(segment);
    match sftp.lstat(&current) {
      Ok(stat)
        if is_symlink_mode(stat.perm.unwrap_or(0))
          || !is_directory_mode(stat.perm.unwrap_or(0)) =>
      {
        return Err("远程父路径不是普通目录，不能创建文件".into())
      }
      Ok(_) => {}
      Err(error) if error.code() == ssh2::ErrorCode::SFTP(2) => {
        sftp
          .mkdir(&current, 0o755)
          .map_err(|e| format!("创建远程目录失败: {e}"))?;
        let stat = sftp
          .lstat(&current)
          .map_err(|e| format!("读取远程目录失败: {e}"))?;
        if !is_directory_mode(stat.perm.unwrap_or(0)) {
          return Err("远程父路径不是普通目录".into());
        }
      }
      Err(error) => return Err(format!("读取远程目录失败: {error}")),
    }
    known_dirs.insert(current.to_string_lossy().into_owned());
  }
  Ok(())
}

pub fn ensure_remote_dir(session: &Session, root: &str, relative: &str) -> Result<(), String> {
  ensure_remote_dir_cached(session, root, relative, &mut HashSet::new())
}

pub fn ensure_remote_dir_cached(
  session: &Session,
  root: &str,
  relative: &str,
  known_dirs: &mut HashSet<String>,
) -> Result<(), String> {
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    mkdir_all(sftp, root, relative, known_dirs)
  })
}

pub fn ensure_remote_dir_on(
  conn: &mut PooledConn,
  root: &str,
  relative: &str,
) -> Result<(), String> {
  conn.session.set_timeout(META_TIMEOUT_MS);
  for attempt in 0..MAX_ATTEMPTS {
    if attempt > 0 {
      conn.reset_sftp();
    }
    let sftp = match conn.take_sftp() {
      Ok(sftp) => sftp,
      Err(error) if attempt + 1 < MAX_ATTEMPTS && is_retryable(&error) => continue,
      Err(error) => return Err(error),
    };
    let result = mkdir_all(&sftp, root, relative, conn.known_dirs_mut());
    conn.restore_sftp(sftp);
    match result {
      Err(error) if attempt + 1 < MAX_ATTEMPTS && is_retryable(&error) => continue,
      result => return result,
    }
  }
  Err("创建远程目录失败".into())
}

pub fn remote_sha256(session: &Session, root: &str, relative: &str) -> Result<String, String> {
  remote_sha256_cancel(session, root, relative, None)
}

fn check_cancelled(cancelled: Option<&std::sync::atomic::AtomicBool>) -> Result<(), String> {
  if cancelled.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
    return Err("对比已取消".into());
  }
  Ok(())
}

pub fn remote_sha256_cancel(
  session: &Session,
  root: &str,
  relative: &str,
  cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
  with_sftp_retry(session, STREAM_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, relative, false, false)?;
    let mut file = sftp
      .open(Path::new(&abs))
      .map_err(|e| format!("打开远程文件失败 ({abs}): {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
      check_cancelled(cancelled)?;
      let n = file
        .read(&mut buf)
        .map_err(|e| format!("读取远程文件失败: {e}"))?;
      if n == 0 {
        break;
      }
      hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
  })
}

pub fn remote_quick_hash(session: &Session, root: &str, relative: &str) -> Result<String, String> {
  remote_quick_hash_cancel(session, root, relative, None)
}

pub fn remote_quick_hash_cancel(
  session: &Session,
  root: &str,
  relative: &str,
  cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
  check_cancelled(cancelled)?;
  with_sftp_retry(session, STREAM_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, relative, false, false)?;
    let stat = sftp
      .stat(Path::new(&abs))
      .map_err(|e| format!("获取远程文件属性失败: {e}"))?;
    let size = stat.size.unwrap_or(0);
    let mut file = sftp
      .open(Path::new(&abs))
      .map_err(|e| format!("打开远程文件失败 ({abs}): {e}"))?;

    let mut buf = vec![0u8; QUICK_HASH_CHUNK];

    // Small files: whole-file SHA256 (single hash, matches local file_quick_hash).
    if size <= QUICK_HASH_CHUNK as u64 {
      let mut hasher = Sha256::new();
      loop {
        check_cancelled(cancelled)?;
        let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
        if n == 0 {
          break;
        }
        hasher.update(&buf[..n]);
      }
      return Ok(hex::encode(hasher.finalize()));
    }

    let head_read = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    let mut head_hasher = Sha256::new();
    head_hasher.update(&buf[..head_read]);
    let head_hash = hex::encode(head_hasher.finalize());

    let seek_pos = size.saturating_sub(QUICK_HASH_CHUNK as u64);
    file
      .seek(SeekFrom::Start(seek_pos))
      .map_err(|e| format!("定位失败: {e}"))?;
    check_cancelled(cancelled)?;
    let tail_read = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    let mut tail_hasher = Sha256::new();
    tail_hasher.update(&buf[..tail_read]);
    let tail_hash = hex::encode(tail_hasher.finalize());

    Ok(format!("{head_hash}:{tail_hash}"))
  })
}

pub fn rename_remote(
  session: &Session,
  root: &str,
  old_relative: &str,
  new_name: &str,
) -> Result<(), String> {
  let old_relative = normalize_relative_safe(old_relative)?;
  let old_relative = old_relative.as_str();
  if old_relative.is_empty() {
    return Err("无法重命名根目录".into());
  }
  if new_name.contains('/')
    || new_name.contains('\\')
    || new_name == ".."
    || new_name == "."
    || new_name.contains('\0')
    || new_name.is_empty()
  {
    return Err("非法文件名".into());
  }
  let parent = parent_relative(old_relative);
  let new_rel = if parent.is_empty() {
    new_name.to_string()
  } else {
    format!("{parent}/{new_name}")
  };
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    let old_abs = checked_remote_path(sftp, root, old_relative, true, false)?;
    let new_abs = checked_remote_path(sftp, root, &new_rel, true, true)?;
    sftp
      .rename(Path::new(&old_abs), Path::new(&new_abs), None)
      .map_err(|e| format!("重命名失败: {e}"))
  })
}

pub fn delete_remote(
  session: &Session,
  root: &str,
  relative: &str,
  is_directory: bool,
) -> Result<(), String> {
  let relative = normalize_relative_safe(relative)?;
  if relative.is_empty() {
    return Err("不允许删除根目录".into());
  }
  let _ = is_directory;
  with_sftp_retry(session, META_TIMEOUT_MS, |sftp| {
    let abs = checked_remote_path(sftp, root, &relative, true, false)?;
    let stat = sftp
      .lstat(Path::new(&abs))
      .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
    if is_directory_mode(stat.perm.unwrap_or(0)) {
      delete_remote_dir_recursive(sftp, &abs)?;
    } else {
      sftp
        .unlink(Path::new(&abs))
        .map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
  })
}

fn delete_remote_dir_recursive(sftp: &Sftp, abs: &str) -> Result<(), String> {
  let stat = sftp
    .lstat(Path::new(abs))
    .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
  if !is_directory_mode(stat.perm.unwrap_or(0)) {
    return sftp
      .unlink(Path::new(abs))
      .map_err(|e| format!("删除失败: {e}"));
  }
  let entries = sftp
    .readdir(Path::new(abs))
    .map_err(|e| format!("读取远程目录失败: {e}"))?;
  for (path, stat) in entries {
    let name = path
      .file_name()
      .map(|n| n.to_string_lossy().to_string())
      .unwrap_or_default();
    if name == "." || name == ".." {
      continue;
    }
    let child = format!("{abs}/{name}");
    let _ = stat;
    let stat = sftp
      .lstat(Path::new(&child))
      .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
    let mode = stat.perm.unwrap_or(0);
    // Do not follow symlinks when deleting — treat symlink-to-dir as a link.
    if is_directory_mode(mode) && !is_symlink_mode(mode) {
      delete_remote_dir_recursive(sftp, &child)?;
    } else {
      sftp
        .unlink(Path::new(&child))
        .map_err(|e| format!("删除失败: {e}"))?;
    }
  }
  sftp
    .rmdir(Path::new(abs))
    .map_err(|e| format!("删除目录失败: {e}"))
}

#[allow(dead_code)]
pub fn absolute_remote(root: &str, relative: &str) -> Result<String, String> {
  remote_join(root, relative)
}

#[cfg(all(test, unix))]
#[path = "ssh_host_key_tests.rs"]
mod host_key_tests;

#[cfg(test)]
mod path_tests {
  use super::*;
  #[test]
  fn remote_join_rejects_parent_segments_for_every_caller() {
    for relative in ["../etc", "dir/../../etc", "dir\\..\\etc"] {
      assert!(remote_join("/root", relative).is_err());
    }
    assert_eq!(
      remote_join("/root", "./sub//file").unwrap(),
      "/root/sub/file"
    );
  }
  #[test]
  fn listing_symlink_never_resolves_target_type() {
    let stat = ssh2::FileStat {
      size: Some(12),
      uid: None,
      gid: None,
      perm: Some(SYMLINK_MODE | 0o777),
      atime: None,
      mtime: Some(1),
    };
    assert_eq!(resolve_list_entry(&stat), (false, true, 12, 1000));
  }
}
