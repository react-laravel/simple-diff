use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::path_utils::normalize_relative;
use crate::types::{FileEntry, SourceConfig};

/// Validate every descendant without following symlinks. The selected root itself
/// may be a symlink; its canonical directory is the boundary for this source.
pub fn resolve_local_path(
  source: &SourceConfig,
  input: &str,
  allow_leaf_link: bool,
) -> Result<PathBuf, String> {
  let selected_root = PathBuf::from(source.as_local_path()?);
  let root = selected_root
    .canonicalize()
    .map_err(|e| format!("无法解析路径: {e}"))?;
  if !root.is_dir() {
    return Err("源路径不是目录".into());
  }
  crate::path_utils::normalize_relative_safe(input)?;
  let relative = if Path::new(input).is_absolute() {
    Path::new(input)
      .strip_prefix(&root)
      .or_else(|_| Path::new(input).strip_prefix(&selected_root))
      .map_err(|_| "文件路径超出允许范围".to_string())?
      .to_path_buf()
  } else {
    PathBuf::from(input)
  };
  let parts: Vec<_> = relative.components().collect();
  let mut candidate = root;
  for (index, component) in parts.iter().enumerate() {
    match component {
      std::path::Component::Normal(name) => candidate.push(name),
      std::path::Component::CurDir => continue,
      _ => return Err("文件路径超出允许范围".into()),
    }
    match fs::symlink_metadata(&candidate) {
      Ok(meta)
        if meta.file_type().is_symlink() && !(allow_leaf_link && index + 1 == parts.len()) =>
      {
        return Err("不允许通过符号链接访问文件或目录".into())
      }
      Ok(meta) if index + 1 < parts.len() && !meta.is_dir() => return Err("父路径不是目录".into()),
      Ok(_) => {}
      Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
      Err(error) => return Err(format!("读取文件信息失败: {error}")),
    }
  }
  Ok(candidate)
}

pub fn resolve_local_abs(source: &SourceConfig, input: &str) -> Result<PathBuf, String> {
  resolve_local_path(source, input, false)
}

pub fn local_metadata(source: &SourceConfig, relative: &str) -> Result<Option<FileEntry>, String> {
  let abs = resolve_local_path(source, relative, true)?;
  let meta = match fs::symlink_metadata(&abs) {
    Ok(meta) => meta,
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(error) => return Err(format!("读取文件信息失败: {error}")),
  };
  Ok(Some(FileEntry {
    name: abs
      .file_name()
      .map(|name| name.to_string_lossy().into_owned())
      .unwrap_or_default(),
    path: relative.into(),
    is_directory: meta.is_dir(),
    is_symlink: meta.file_type().is_symlink(),
    size: if meta.is_dir() { 0 } else { meta.len() },
    mtime: mtime_ms(&meta),
  }))
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

#[allow(dead_code)]
pub fn list_directory(source: &SourceConfig, dir_path: &str) -> Result<Vec<FileEntry>, String> {
  let abs = resolve_local_abs(source, dir_path)?;
  if !abs.is_dir() {
    return Err("不是目录".into());
  }

  let root = PathBuf::from(source.as_local_path()?)
    .canonicalize()
    .map_err(|e| format!("无法解析路径: {e}"))?;
  let mut entries = Vec::new();

  for item in fs::read_dir(&abs).map_err(|e| format!("读取目录失败: {e}"))? {
    let item = item.map_err(|e| format!("读取目录失败: {e}"))?;
    let meta = fs::symlink_metadata(item.path()).map_err(|e| format!("读取元数据失败: {e}"))?;
    let name = item.file_name().to_string_lossy().to_string();
    let full = item.path();
    let relative = full
      .strip_prefix(&root)
      .unwrap_or(&full)
      .to_string_lossy()
      .replace('\\', "/");

    entries.push(FileEntry {
      name,
      path: relative,
      is_directory: meta.is_dir(),
      is_symlink: meta.file_type().is_symlink(),
      size: if meta.is_file() { meta.len() } else { 0 },
      mtime: mtime_ms(&meta),
    });
  }

  entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
  });

  Ok(entries)
}

pub fn list_directory_relative(root: &str, relative: &str) -> Result<Vec<FileEntry>, String> {
  let source = SourceConfig::Local { path: root.into() };
  let abs = resolve_local_abs(&source, relative)?;
  match fs::symlink_metadata(&abs) {
    Ok(meta) if meta.is_dir() => {}
    Ok(_) => return Err("不是目录".into()),
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(error) => return Err(format!("读取目录失败: {error}")),
  }

  let mut entries = Vec::new();
  for item in fs::read_dir(&abs).map_err(|e| format!("读取目录失败: {e}"))? {
    let item = item.map_err(|e| format!("读取目录失败: {e}"))?;
    let meta = match fs::symlink_metadata(item.path()) {
      Ok(meta) => meta,
      Err(_) => continue,
    };
    let name = item.file_name().to_string_lossy().to_string();
    let path = if relative.is_empty() {
      name.clone()
    } else {
      format!("{relative}/{name}")
    };

    entries.push(FileEntry {
      name,
      path: normalize_relative(&path),
      is_directory: meta.is_dir(),
      is_symlink: meta.file_type().is_symlink(),
      size: if meta.is_file() { meta.len() } else { 0 },
      mtime: mtime_ms(&meta),
    });
  }

  Ok(entries)
}

pub fn read_text(source: &SourceConfig, file_path: &str) -> Result<String, String> {
  let abs = resolve_local_abs(source, file_path)?;
  let file = fs::File::open(&abs).map_err(|e| format!("读取文件失败: {e}"))?;
  read_text_limited(file)
}

pub const MAX_TEXT_BYTES: u64 = 32 * 1024 * 1024;

pub fn read_text_limited(reader: impl std::io::Read) -> Result<String, String> {
  use std::io::Read;
  let mut bytes = Vec::new();
  reader
    .take(MAX_TEXT_BYTES + 1)
    .read_to_end(&mut bytes)
    .map_err(|e| format!("读取文件失败: {e}"))?;
  if bytes.len() as u64 > MAX_TEXT_BYTES {
    return Err("文本预览仅支持 32 MB 以内的文件；大文件仍可进行目录对比和同步。".into());
  }
  String::from_utf8(bytes).map_err(|e| format!("文件不是有效 UTF-8: {e}"))
}

pub fn write_text(source: &SourceConfig, file_path: &str, content: &str) -> Result<(), String> {
  let abs = resolve_local_abs(source, file_path)?;
  if let Some(parent) = abs.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
  }
  crate::atomic_file::replace_from_reader(&abs, &mut content.as_bytes()).map(|_| ())
}

pub fn rename_file(
  source: &SourceConfig,
  old_relative: &str,
  new_name: &str,
) -> Result<(), String> {
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

  let old_path = resolve_local_path(source, old_relative, true)?;
  if old_path
    == PathBuf::from(source.as_local_path()?)
      .canonicalize()
      .map_err(|e| e.to_string())?
  {
    return Err("无法重命名根目录".into());
  }
  let parent_rel = {
    let parts: Vec<&str> = old_relative
      .split(['/', '\\'])
      .filter(|p| !p.is_empty())
      .collect();
    if parts.len() <= 1 {
      String::new()
    } else {
      parts[..parts.len() - 1].join("/")
    }
  };
  let new_rel = if parent_rel.is_empty() {
    new_name.to_string()
  } else {
    format!("{parent_rel}/{new_name}")
  };
  let new_path = resolve_local_path(source, &new_rel, true)?;
  fs::rename(&old_path, &new_path).map_err(|e| format!("重命名失败: {e}"))
}

pub fn delete_file(
  source: &SourceConfig,
  relative: &str,
  is_directory: bool,
) -> Result<(), String> {
  if relative.is_empty() {
    return Err("不允许删除根目录".into());
  }
  let _ = is_directory; // Determine the actual type instead of trusting IPC.
  let abs = resolve_local_path(source, relative, true)?;
  if abs
    == PathBuf::from(source.as_local_path()?)
      .canonicalize()
      .map_err(|e| e.to_string())?
  {
    return Err("不允许删除根目录".into());
  }
  let meta = fs::symlink_metadata(&abs).map_err(|e| format!("读取文件信息失败: {e}"))?;
  if meta.is_dir() {
    fs::remove_dir_all(&abs).map_err(|e| format!("删除失败: {e}"))
  } else {
    fs::remove_file(&abs).map_err(|e| format!("删除失败: {e}"))
  }
}

pub fn file_sha256(path: &Path) -> Result<String, String> {
  file_sha256_cancel(path, None)
}

fn check_hash_cancelled(cancelled: Option<&std::sync::atomic::AtomicBool>) -> Result<(), String> {
  if cancelled.is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Relaxed)) {
    return Err("对比已取消".into());
  }
  Ok(())
}

pub fn file_sha256_cancel(
  path: &Path,
  cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
  let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
  sha256_reader_cancel(&mut file, cancelled)
}

fn sha256_reader_cancel(
  reader: &mut dyn std::io::Read,
  cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
  let mut hasher = Sha256::new();
  let mut buf = [0u8; 64 * 1024];
  loop {
    check_hash_cancelled(cancelled)?;
    let read = reader
      .read(&mut buf)
      .map_err(|e| format!("读取文件失败: {e}"))?;
    if read == 0 {
      break;
    }
    hasher.update(&buf[..read]);
  }
  Ok(hex::encode(hasher.finalize()))
}

pub fn file_quick_hash(path: &Path) -> Result<String, String> {
  file_quick_hash_cancel(path, None)
}

pub fn file_quick_hash_cancel(
  path: &Path,
  cancelled: Option<&std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
  check_hash_cancelled(cancelled)?;
  use std::io::{Read, Seek, SeekFrom};

  let meta = fs::metadata(path).map_err(|e| format!("读取元数据失败: {e}"))?;
  let size = meta.len();
  let mut file = fs::File::open(path).map_err(|e| format!("打开文件失败: {e}"))?;
  const CHUNK: usize = 64 * 1024;
  let mut buf = vec![0u8; CHUNK];

  // Small files: whole-file hash (matches Electron quick_hash semantics).
  if size <= CHUNK as u64 {
    let mut hasher = Sha256::new();
    loop {
      check_hash_cancelled(cancelled)?;
      let n = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
      if n == 0 {
        break;
      }
      hasher.update(&buf[..n]);
    }
    return Ok(hex::encode(hasher.finalize()));
  }

  check_hash_cancelled(cancelled)?;
  let head_read = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
  let mut head_hasher = Sha256::new();
  head_hasher.update(&buf[..head_read]);
  let head_hash = hex::encode(head_hasher.finalize());

  let mut tail_hasher = Sha256::new();
  let seek_pos = size.saturating_sub(CHUNK as u64);
  file
    .seek(SeekFrom::Start(seek_pos))
    .map_err(|e| format!("定位失败: {e}"))?;
  check_hash_cancelled(cancelled)?;
  let tail_read = file.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
  tail_hasher.update(&buf[..tail_read]);
  let tail_hash = hex::encode(tail_hasher.finalize());

  Ok(format!("{head_hash}:{tail_hash}"))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::Write;

  struct TestDir(PathBuf);
  impl Drop for TestDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }
  fn test_dir() -> TestDir {
    let dir =
      TestDir(std::env::temp_dir().join(format!("simple-diff-path-{}", uuid::Uuid::new_v4())));
    fs::create_dir(&dir.0).unwrap();
    dir
  }

  #[test]
  fn relative_directory_paths_cannot_escape_root() {
    let dir = test_dir();
    fs::create_dir(dir.0.join("root")).unwrap();
    fs::write(dir.0.join("secret"), "outside").unwrap();
    let root = dir.0.join("root");
    let source = SourceConfig::Local {
      path: root.to_string_lossy().into_owned(),
    };
    assert!(list_directory_relative(source.as_local_path().unwrap(), "../").is_err());
    assert!(resolve_local_abs(&source, "../secret").is_err());
    assert!(rename_file(&source, ".", "other").is_err());
    assert!(delete_file(&source, ".", true).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn symlink_cycles_are_leaf_entries_and_operations_never_follow_them() {
    use std::os::unix::fs::symlink;
    let dir = test_dir();
    let root = dir.0.join("root");
    let outside = dir.0.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), "safe").unwrap();
    symlink(&root, root.join("cycle")).unwrap();
    symlink(&outside, root.join("outside")).unwrap();
    symlink(outside.join("secret"), root.join("file-link")).unwrap();
    let source = SourceConfig::Local {
      path: root.to_string_lossy().into_owned(),
    };
    let entries = list_directory_relative(source.as_local_path().unwrap(), "").unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries
      .iter()
      .all(|entry| entry.is_symlink && !entry.is_directory));
    for input in ["cycle", "outside/secret", "file-link"] {
      assert!(resolve_local_abs(&source, input).is_err(), "{input}");
    }
    assert!(list_directory_relative(source.as_local_path().unwrap(), "cycle").is_err());
    assert!(rename_file(&source, "outside/secret", "bad").is_err());
    rename_file(&source, "file-link", "renamed-link").unwrap();
    delete_file(&source, "outside", true).unwrap();
    delete_file(&source, "cycle", true).unwrap();
    assert_eq!(fs::read_to_string(outside.join("secret")).unwrap(), "safe");
    assert!(fs::symlink_metadata(root.join("renamed-link"))
      .unwrap()
      .file_type()
      .is_symlink());
    assert!(local_metadata(&source, "missing/child").unwrap().is_none());
  }

  #[test]
  fn cancellation_is_observed_between_hash_chunks() {
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    struct CancelAfterRead<'a> {
      cancelled: &'a std::sync::atomic::AtomicBool,
      reads: usize,
    }
    impl std::io::Read for CancelAfterRead<'_> {
      fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        self.reads += 1;
        buffer.fill(1);
        self
          .cancelled
          .store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(buffer.len())
      }
    }
    let mut reader = CancelAfterRead {
      cancelled: &cancelled,
      reads: 0,
    };
    assert_eq!(
      sha256_reader_cancel(&mut reader, Some(&cancelled)).unwrap_err(),
      "对比已取消"
    );
    assert_eq!(reader.reads, 1);
  }

  #[test]
  fn cancelled_hash_stops_before_reading_file() {
    let dir = test_dir();
    let path = dir.0.join("large");
    fs::write(&path, vec![1u8; 1024 * 1024]).unwrap();
    let cancelled = std::sync::atomic::AtomicBool::new(true);
    assert_eq!(
      file_sha256_cancel(&path, Some(&cancelled)).unwrap_err(),
      "对比已取消"
    );
    assert_eq!(
      file_quick_hash_cancel(&path, Some(&cancelled)).unwrap_err(),
      "对比已取消"
    );
  }

  #[test]
  fn quick_hash_small_file_is_single_digest() {
    let dir = std::env::temp_dir().join(format!("simple-diff-qh-{}", std::process::id()));
    let _ = fs::create_dir_all(&dir);
    let path = dir.join("small.txt");
    let mut f = fs::File::create(&path).unwrap();
    write!(f, "hello").unwrap();
    let hash = file_quick_hash(&path).unwrap();
    assert!(
      !hash.contains(':'),
      "small file should be whole-file hash, got {hash}"
    );
    let _ = fs::remove_dir_all(&dir);
  }
}
