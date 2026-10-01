use tauri::AppHandle;

use crate::files::{
  delete_file, file_quick_hash, file_sha256, list_directory_relative, read_text, rename_file,
  resolve_local_abs, write_text,
};
use crate::path_guards::relative_under_source;
use crate::ssh::{
  delete_remote, ensure_remote_dir_on, list_remote, read_remote_text, remote_quick_hash,
  remote_sha256, rename_remote, write_remote_text,
};
use crate::ssh_pool::{self, PooledConn};
use crate::ssh_store;
use crate::types::{FileEntry, SourceConfig};

/// List directory for IPC. `dir_path` may be absolute (UI lazy-load) or relative.
pub fn list_entries(
  app: &AppHandle,
  source: &SourceConfig,
  dir_path: &str,
) -> Result<Vec<FileEntry>, String> {
  match source {
    SourceConfig::Local { .. } => {
      let abs = resolve_local_abs(source, dir_path)?;
      if !abs.is_dir() {
        return Err("不是目录".into());
      }
      let relative = relative_under_source(source, dir_path)?;
      let mut entries = list_directory_relative(source.as_local_path()?, &relative)?;
      for entry in &mut entries {
        entry.path = entry.name.clone();
      }
      entries.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
      });
      Ok(entries)
    }
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      let relative = relative_under_source(source, dir_path)?;
      let mut entries =
        ssh_pool::with_shared(&config, |session| list_remote(session, path, &relative))?;
      for entry in &mut entries {
        entry.path = entry.name.clone();
      }
      Ok(entries)
    }
  }
}

pub fn read_text_source(
  app: &AppHandle,
  source: &SourceConfig,
  file_path: &str,
) -> Result<String, String> {
  match source {
    SourceConfig::Local { .. } => read_text(source, file_path),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      let relative = relative_under_source(source, file_path)?;
      ssh_pool::with_shared(&config, |session| {
        read_remote_text(session, path, &relative)
      })
    }
  }
}

pub fn write_text_source(
  app: &AppHandle,
  source: &SourceConfig,
  file_path: &str,
  content: &str,
  expected_content: Option<&str>,
  expected_exists: Option<bool>,
) -> Result<(), String> {
  if let Some(should_exist) = expected_exists {
    let exists = match source {
      SourceConfig::Local { .. } => resolve_local_abs(source, file_path)?
        .try_exists()
        .map_err(|e| e.to_string())?,
      SourceConfig::Sftp { config_id, path } => {
        let config = ssh_store::get_internal(app, config_id)?;
        let relative = relative_under_source(source, file_path)?;
        ssh_pool::with_shared(&config, |session| {
          crate::ssh::remote_exists(session, path, &relative)
        })?
      }
    };
    if exists != should_exist
      || (exists && expected_content != Some(read_text_source(app, source, file_path)?.as_str()))
    {
      return Err("文件已被其他程序修改，已停止覆盖。请重新读取并合并修改后保存。".into());
    }
  }
  match source {
    SourceConfig::Local { .. } => write_text(source, file_path, content),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      let relative = relative_under_source(source, file_path)?;
      ssh_pool::with_shared(&config, |session| {
        write_remote_text(session, path, &relative, content)
      })
    }
  }
}

pub fn rename_source(
  app: &AppHandle,
  source: &SourceConfig,
  old_relative: &str,
  new_name: &str,
) -> Result<(), String> {
  match source {
    SourceConfig::Local { .. } => rename_file(source, old_relative, new_name),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      let relative = relative_under_source(source, old_relative)?;
      ssh_pool::with_shared(&config, |session| {
        rename_remote(session, path, &relative, new_name)
      })
    }
  }
}

pub fn delete_source(
  app: &AppHandle,
  source: &SourceConfig,
  relative: &str,
  is_directory: bool,
) -> Result<(), String> {
  match source {
    SourceConfig::Local { .. } => delete_file(source, relative, is_directory),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      let relative = relative_under_source(source, relative)?;
      ssh_pool::with_shared(&config, |session| {
        delete_remote(session, path, &relative, is_directory)
      })
    }
  }
}

#[allow(dead_code)]
pub fn hash_file(app: &AppHandle, source: &SourceConfig, relative: &str) -> Result<String, String> {
  match source {
    SourceConfig::Local { .. } => file_sha256(&resolve_local_abs(source, relative)?),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      ssh_pool::with_shared(&config, |session| remote_sha256(session, path, relative))
    }
  }
}

#[allow(dead_code)]
pub fn quick_hash_file(
  app: &AppHandle,
  source: &SourceConfig,
  relative: &str,
) -> Result<String, String> {
  match source {
    SourceConfig::Local { .. } => file_quick_hash(&resolve_local_abs(source, relative)?),
    SourceConfig::Sftp { config_id, path } => {
      let config = ssh_store::get_internal(app, config_id)?;
      ssh_pool::with_shared(&config, |session| {
        remote_quick_hash(session, path, relative)
      })
    }
  }
}

/// Open sessions once for a compare/sync run when SFTP is involved.
/// SFTP uses an **isolated** (non-pooled) connection for the long-lived session.
pub struct SourceSession<'a> {
  app: &'a AppHandle,
  source: &'a SourceConfig,
  remote: Option<parking_lot::Mutex<PooledConn>>,
}

impl<'a> SourceSession<'a> {
  pub fn open(app: &'a AppHandle, source: &'a SourceConfig) -> Result<Self, String> {
    let remote = match source {
      SourceConfig::Local { .. } => None,
      SourceConfig::Sftp { config_id, .. } => {
        let config = ssh_store::get_internal(app, config_id)?;
        // Isolated: long compare/sync must not share the short-op pool.
        Some(parking_lot::Mutex::new(ssh_pool::connect_isolated(
          &config,
        )?))
      }
    };
    Ok(Self {
      app,
      source,
      remote,
    })
  }

  fn with_remote<T>(&self, f: impl FnOnce(&PooledConn) -> Result<T, String>) -> Result<T, String> {
    let guard = self.remote.as_ref().ok_or("SFTP 会话未建立")?.lock();
    f(&guard)
  }

  fn with_remote_mut<T>(
    &self,
    f: impl FnOnce(&mut PooledConn) -> Result<T, String>,
  ) -> Result<T, String> {
    let mut guard = self.remote.as_ref().ok_or("SFTP 会话未建立")?.lock();
    f(&mut guard)
  }

  pub fn list(&self, relative: &str) -> Result<Vec<FileEntry>, String> {
    match self.source {
      SourceConfig::Local { path } => list_directory_relative(path, relative),
      SourceConfig::Sftp { path, .. } => {
        self.with_remote(|conn| list_remote(&conn.session, path, relative))
      }
    }
  }

  pub fn metadata(&self, relative: &str) -> Result<Option<FileEntry>, String> {
    match self.source {
      SourceConfig::Local { .. } => crate::files::local_metadata(self.source, relative),
      SourceConfig::Sftp { path, .. } => {
        self.with_remote(|conn| crate::ssh::remote_metadata(&conn.session, path, relative))
      }
    }
  }

  pub fn link_hash(&self, relative: &str) -> Result<String, String> {
    use sha2::Digest;
    let target = match self.source {
      SourceConfig::Local { .. } => std::fs::read_link(crate::files::resolve_local_path(
        self.source,
        relative,
        true,
      )?)
      .map_err(|e| format!("读取符号链接失败: {e}"))?
      .to_string_lossy()
      .into_owned(),
      SourceConfig::Sftp { path, .. } => {
        self.with_remote(|conn| crate::ssh::remote_link_target(&conn.session, path, relative))?
      }
    };
    Ok(hex::encode(sha2::Sha256::digest(target.as_bytes())))
  }

  pub fn hash(&self, relative: &str) -> Result<String, String> {
    self.hash_cancel(relative, None)
  }

  pub fn hash_cancel(
    &self,
    relative: &str,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
  ) -> Result<String, String> {
    match self.source {
      SourceConfig::Local { .. } => {
        crate::files::file_sha256_cancel(&resolve_local_abs(self.source, relative)?, cancelled)
      }
      SourceConfig::Sftp { path, .. } => self.with_remote(|conn| {
        crate::ssh::remote_sha256_cancel(&conn.session, path, relative, cancelled)
      }),
    }
  }

  #[allow(dead_code)]
  pub fn quick_hash(&self, relative: &str) -> Result<String, String> {
    self.quick_hash_cancel(relative, None)
  }

  pub fn quick_hash_cancel(
    &self,
    relative: &str,
    cancelled: Option<&std::sync::atomic::AtomicBool>,
  ) -> Result<String, String> {
    match self.source {
      SourceConfig::Local { .. } => {
        crate::files::file_quick_hash_cancel(&resolve_local_abs(self.source, relative)?, cancelled)
      }
      SourceConfig::Sftp { path, .. } => self.with_remote(|conn| {
        crate::ssh::remote_quick_hash_cancel(&conn.session, path, relative, cancelled)
      }),
    }
  }

  pub fn ensure_dir(&self, relative: &str) -> Result<(), String> {
    match self.source {
      SourceConfig::Local { path } => {
        let _ = path;
        let abs = resolve_local_abs(self.source, relative)?;
        std::fs::create_dir_all(&abs).map_err(|e| format!("创建目录失败: {e}"))
      }
      SourceConfig::Sftp { path, .. } => {
        self.with_remote_mut(|conn| ensure_remote_dir_on(conn, path, relative))
      }
    }
  }

  #[allow(dead_code)]
  pub fn app(&self) -> &AppHandle {
    self.app
  }
}

#[allow(dead_code)]
pub fn copy_between(
  from: &SourceSession<'_>,
  to: &SourceSession<'_>,
  relative: &str,
  progress: &mut dyn FnMut(u64, u64),
) -> Result<(), String> {
  copy_between_checked(from, to, relative, progress, &mut || Ok(()))
}

pub fn copy_between_checked(
  from: &SourceSession<'_>,
  to: &SourceSession<'_>,
  relative: &str,
  progress: &mut dyn FnMut(u64, u64),
  before_commit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), String> {
  let (mut reader, permissions, modified, total): (
    Box<dyn std::io::Read>,
    Option<u32>,
    Option<std::time::SystemTime>,
    u64,
  ) = match from.source {
    SourceConfig::Local { .. } => {
      let file = std::fs::File::open(resolve_local_abs(from.source, relative)?)
        .map_err(|e| format!("读取文件失败: {e}"))?;
      let meta = file
        .metadata()
        .map_err(|e| format!("读取文件信息失败: {e}"))?;
      #[cfg(unix)]
      let permissions = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
      };
      #[cfg(not(unix))]
      let permissions = None;
      (
        Box::new(file),
        permissions,
        meta.modified().ok(),
        meta.len(),
      )
    }
    SourceConfig::Sftp { path, .. } => {
      let mut file =
        from.with_remote(|conn| crate::ssh::open_remote_reader(&conn.session, path, relative))?;
      let meta = file
        .stat()
        .map_err(|e| format!("读取远程文件信息失败: {e}"))?;
      (
        Box::new(file),
        meta.perm,
        meta
          .mtime
          .map(|seconds| std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds)),
        meta.size.unwrap_or(0),
      )
    }
  };
  let mut report = |bytes| progress(bytes, total);
  match to.source {
    SourceConfig::Local { .. } => {
      let target = resolve_local_abs(to.source, relative)?;
      #[cfg(unix)]
      let local_permissions = {
        use std::os::unix::fs::PermissionsExt;
        permissions.map(std::fs::Permissions::from_mode)
      };
      #[cfg(not(unix))]
      let local_permissions = None;
      let mut check = || {
        before_commit()?;
        if resolve_local_abs(to.source, relative)? != target {
          return Err("目标根目录已改变，已停止覆盖".into());
        }
        Ok(())
      };
      crate::atomic_file::replace_from_reader_with_metadata_checked(
        &target,
        reader.as_mut(),
        local_permissions,
        modified,
        &mut report,
        &mut check,
      )
      .map(|_| ())
    }
    SourceConfig::Sftp { path, .. } => to.with_remote(|conn| {
      crate::ssh::write_remote_stream_with_metadata_checked(
        &conn.session,
        path,
        relative,
        reader.as_mut(),
        permissions,
        modified,
        &mut report,
        before_commit,
      )
    }),
  }
}
