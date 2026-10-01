use crate::path_utils::{join_path, normalize_relative};
use crate::types::SourceConfig;

/// Resolve a path that must stay under the source root (local or SFTP).
pub fn resolve_allowed_source_path(
  source: &SourceConfig,
  file_path: &str,
) -> Result<String, String> {
  match source {
    SourceConfig::Local { path } => resolve_allowed_local(path, file_path),
    SourceConfig::Sftp { path, .. } => resolve_allowed_remote(path, file_path),
  }
}

pub fn resolve_allowed_local(root: &str, file_path: &str) -> Result<String, String> {
  let source = SourceConfig::Local { path: root.into() };
  crate::files::resolve_local_abs(&source, file_path)
    .map(|path| path.to_string_lossy().replace('\\', "/"))
}

pub fn resolve_allowed_remote(root: &str, file_path: &str) -> Result<String, String> {
  let source_root = posix_resolve(if root.is_empty() { "/" } else { root });
  if !source_root.starts_with('/') {
    return Err("远程根目录必须是绝对路径".into());
  }
  crate::path_utils::normalize_relative_safe(file_path)?;
  let normalized_input = file_path.replace('\\', "/");
  let resolved = if normalized_input.starts_with('/') {
    posix_resolve(&normalized_input)
  } else {
    posix_resolve(&join_path(&source_root, &normalized_input))
  };

  let relative = posix_relative(&source_root, &resolved)?;
  if relative == ".." || relative.starts_with("../") {
    return Err("文件路径超出允许范围".into());
  }
  Ok(resolved)
}

/// Convert absolute-or-relative input into a relative path under source root.
pub fn relative_under_source(source: &SourceConfig, file_path: &str) -> Result<String, String> {
  let abs = resolve_allowed_source_path(source, file_path)?;
  let root = match source {
    SourceConfig::Local { path } => std::path::PathBuf::from(path)
      .canonicalize()
      .map_err(|e| format!("无法解析路径: {e}"))?
      .to_string_lossy()
      .replace('\\', "/"),
    SourceConfig::Sftp { path, .. } => {
      let r = if path.is_empty() { "/" } else { path };
      posix_resolve(r)
    }
  };

  if abs == root || abs.trim_end_matches('/') == root.trim_end_matches('/') {
    return Ok(String::new());
  }
  let prefix = format!("{}/", root.trim_end_matches('/'));
  if let Some(rest) = abs.strip_prefix(&prefix) {
    return Ok(normalize_relative(rest));
  }
  // Already relative
  let rel = normalize_relative(file_path);
  if rel.split('/').any(|p| p == "..") {
    return Err("文件路径超出允许范围".into());
  }
  Ok(rel)
}

pub fn posix_resolve(path: &str) -> String {
  let absolute = path.starts_with('/');
  let mut parts: Vec<&str> = Vec::new();
  for part in path.split('/') {
    if part.is_empty() || part == "." {
      continue;
    }
    if part == ".." {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  if absolute {
    format!("/{}", parts.join("/"))
  } else {
    parts.join("/")
  }
}

fn posix_relative(from: &str, to: &str) -> Result<String, String> {
  let from_n = posix_resolve(from);
  let to_n = posix_resolve(to);
  if to_n == from_n {
    return Ok(String::new());
  }
  let from_prefix = if from_n == "/" {
    "/".to_string()
  } else {
    format!("{}/", from_n.trim_end_matches('/'))
  };
  if let Some(rest) = to_n.strip_prefix(&from_prefix) {
    return Ok(rest.to_string());
  }
  if from_n == "/" && to_n.starts_with('/') {
    return Ok(to_n.trim_start_matches('/').to_string());
  }
  Err("文件路径超出允许范围".into())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::types::SourceConfig;

  #[test]
  fn sftp_jail_blocks_parent_escape() {
    let source = SourceConfig::Sftp {
      config_id: "x".into(),
      path: "/home/user".into(),
    };
    assert!(resolve_allowed_source_path(&source, "/home/user/../etc/passwd").is_err());
    assert!(resolve_allowed_source_path(&source, "../etc").is_err());
  }

  #[test]
  fn sftp_absolute_paths_are_never_reinterpreted_as_relative_children() {
    let source = SourceConfig::Sftp {
      config_id: "x".into(),
      path: "/var/www".into(),
    };
    for path in [
      "/var",
      "/var/www2",
      "/var/www/../etc",
      "/var/www/a/../../etc",
    ] {
      assert!(relative_under_source(&source, path).is_err(), "{path}");
    }
    assert_eq!(relative_under_source(&source, "/var/www/").unwrap(), "");
    assert_eq!(relative_under_source(&source, "images").unwrap(), "images");
  }

  #[test]
  fn sftp_jail_allows_child() {
    let source = SourceConfig::Sftp {
      config_id: "x".into(),
      path: "/home/user".into(),
    };
    let path = resolve_allowed_source_path(&source, "docs/a.txt").unwrap();
    assert_eq!(path, "/home/user/docs/a.txt");
  }

  #[test]
  fn relative_under_source_strips_root() {
    let source = SourceConfig::Sftp {
      config_id: "x".into(),
      path: "/var/www".into(),
    };
    assert_eq!(
      relative_under_source(&source, "/var/www/index.html").unwrap(),
      "index.html"
    );
  }
}
