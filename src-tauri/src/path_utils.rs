fn normalize_path_value(value: &str) -> String {
  value.trim().trim_matches('/').to_string()
}

const EXACT_PATH_PREFIX: &str = "path:";

pub fn matches_path_filter(relative_path: &str, filters: &[String]) -> bool {
  let normalized_path = normalize_path_value(relative_path);
  let lower_path = normalized_path.to_lowercase();
  if normalized_path.is_empty() {
    return false;
  }

  let segments: Vec<&str> = lower_path.split('/').collect();

  filters.iter().any(|filter| {
    let normalized_filter = normalize_path_value(filter);
    let lower_filter = normalized_filter.to_lowercase();
    if normalized_filter.is_empty() {
      return false;
    }

    if lower_filter.starts_with(EXACT_PATH_PREFIX) {
      let exact_path = normalize_path_value(&normalized_filter[EXACT_PATH_PREFIX.len()..]);
      if exact_path.is_empty() {
        return false;
      }
      return normalized_path == exact_path
        || normalized_path.starts_with(&format!("{exact_path}/"));
    }

    if lower_filter.contains('/') {
      return lower_path == lower_filter || lower_path.starts_with(&format!("{lower_filter}/"));
    }

    segments.iter().any(|segment| *segment == lower_filter)
  })
}

pub fn join_path(root: &str, relative: &str) -> String {
  if relative.is_empty() {
    return root.to_string();
  }
  let root = root.trim_end_matches(['/', '\\']);
  format!("{root}/{relative}")
}

pub fn normalize_relative(relative: &str) -> String {
  relative
    .replace('\\', "/")
    .trim_matches('/')
    .split('/')
    .filter(|part| !part.is_empty() && *part != ".")
    .collect::<Vec<_>>()
    .join("/")
}

/// Like normalize_relative but rejects `..` segments.
pub fn normalize_relative_safe(relative: &str) -> Result<String, String> {
  if relative.contains('\0') {
    return Err("路径包含非法片段".into());
  }
  if relative.split(['/', '\\']).any(|part| part == "..") {
    return Err("路径包含非法片段".into());
  }
  Ok(normalize_relative(relative))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn normalize_relative_safe_rejects_dotdot() {
    assert!(normalize_relative_safe("../secret").is_err());
    assert_eq!(normalize_relative_safe("a/b").unwrap(), "a/b");
  }
}
