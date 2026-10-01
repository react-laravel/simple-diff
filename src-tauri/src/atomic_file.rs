use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

struct TempFile(PathBuf);
impl Drop for TempFile {
  fn drop(&mut self) {
    let _ = fs::remove_file(&self.0);
  }
}

/// Bounded memory even for remote inputs; a failed read leaves the old target intact.
pub fn replace_from_reader(target: &Path, reader: &mut dyn Read) -> Result<u64, String> {
  replace_from_reader_with_metadata(target, reader, None, None, &mut |_| {})
}

pub fn replace_from_reader_with_metadata(
  target: &Path,
  reader: &mut dyn Read,
  permissions: Option<fs::Permissions>,
  modified: Option<std::time::SystemTime>,
  progress: &mut dyn FnMut(u64),
) -> Result<u64, String> {
  replace_from_reader_with_metadata_checked(target, reader, permissions, modified, progress, &mut || Ok(()))
}

/// Revalidate the destination after streaming, immediately before publishing the temporary file.
pub fn replace_from_reader_with_metadata_checked(
  target: &Path,
  reader: &mut dyn Read,
  permissions: Option<fs::Permissions>,
  modified: Option<std::time::SystemTime>,
  progress: &mut dyn FnMut(u64),
  before_commit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<u64, String> {
  let parent = target.parent().ok_or("无效文件路径")?;
  fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
  let temp = TempFile(parent.join(format!(".simple-diff-{}.tmp", uuid::Uuid::new_v4())));
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
  }
  let mut file = options
    .open(&temp.0)
    .map_err(|e| format!("创建临时文件失败: {e}"))?;
  let bytes = copy_buffered_with_progress(reader, &mut file, progress)
    .map_err(|e| format!("写入文件失败: {e}"))?;
  if let Some(permissions) = permissions.or_else(|| {
    fs::metadata(target)
      .ok()
      .map(|metadata| metadata.permissions())
  }) {
    file
      .set_permissions(permissions)
      .map_err(|e| format!("保留文件权限失败: {e}"))?;
  }
  if let Some(modified) = modified {
    file
      .set_times(fs::FileTimes::new().set_modified(modified))
      .map_err(|e| format!("保留修改时间失败: {e}"))?;
  }
  file.sync_all().map_err(|e| format!("保存文件失败: {e}"))?;
  drop(file);
  before_commit()?;
  fs::rename(&temp.0, target).map_err(|e| format!("替换文件失败: {e}"))?;
  #[cfg(unix)]
  {
    if let Ok(directory) = File::open(parent) {
      let _ = directory.sync_all();
    }
  }
  Ok(bytes)
}

#[cfg(test)]
pub fn copy_buffered(reader: &mut dyn Read, writer: &mut dyn Write) -> io::Result<u64> {
  copy_buffered_with_progress(reader, writer, &mut |_| {})
}

pub fn copy_buffered_with_progress(
  reader: &mut dyn Read,
  writer: &mut dyn Write,
  progress: &mut dyn FnMut(u64),
) -> io::Result<u64> {
  let mut buffer = [0u8; 64 * 1024];
  let mut total = 0;
  loop {
    let read = match reader.read(&mut buffer) {
      Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
      result => result?,
    };
    if read == 0 {
      break;
    }
    writer.write_all(&buffer[..read])?;
    total += read as u64;
    progress(total);
  }
  writer.flush()?;
  Ok(total)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn destination_change_during_stream_is_preserved_and_temp_is_removed() {
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("target");
    fs::write(&path, b"original").unwrap();
    let mut input = &b"sync content"[..];
    let mut progress = |_| { fs::write(&path, b"external edit").unwrap(); };
    let mut validate = || if fs::read(&path).unwrap() == b"original" { Ok(()) } else { Err("destination changed".into()) };
    assert!(replace_from_reader_with_metadata_checked(&path, &mut input, None, None, &mut progress, &mut validate).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external edit");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn failed_stream_does_not_truncate_target_or_leave_temporary_file() {
    struct FailedInput(bool);
    impl Read for FailedInput {
      fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.0 {
          return Err(io::Error::new(
            io::ErrorKind::ConnectionReset,
            "disconnected",
          ));
        }
        self.0 = true;
        buf[..3].copy_from_slice(b"new");
        Ok(3)
      }
    }
    let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("target");
    fs::write(&path, b"original").unwrap();
    assert!(replace_from_reader(&path, &mut FailedInput(false)).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"original");
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    replace_from_reader(&path, &mut &b"complete"[..]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"complete");
    fs::remove_dir_all(dir).unwrap();
  }

  #[test]
  fn streaming_reads_are_bounded() {
    struct LargeInput(usize);
    impl Read for LargeInput {
      fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        assert!(buf.len() <= 64 * 1024);
        let n = self.0.min(buf.len());
        buf[..n].fill(42);
        self.0 -= n;
        Ok(n)
      }
    }
    assert_eq!(
      copy_buffered(&mut LargeInput(16 * 1024 * 1024), &mut io::sink()).unwrap(),
      16 * 1024 * 1024
    );
  }
}
