use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use tauri::AppHandle;
use uuid::Uuid;

static STORE_LOCK: Mutex<()> = Mutex::new(());

use crate::secret_crypto::{self, app_data_dir};
use crate::types::{SshConfig, SshConfigInput, SshConfigInternal};

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(app_data_dir(app)?.join("ssh-configs.json"))
}

fn read_all(app: &AppHandle) -> Result<Vec<SshConfigInternal>, String> {
  let path = store_path(app)?;
  if !path.exists() {
    return Ok(Vec::new());
  }
  secret_crypto::set_private_permissions(&path, false)?;
  let raw = fs::read_to_string(&path).map_err(|e| format!("读取 SSH 配置失败: {e}"))?;
  let mut configs: Vec<SshConfigInternal> =
    serde_json::from_str(&raw).map_err(|e| format!("解析 SSH 配置失败: {e}"))?;
  migrate_and_commit(
    &mut configs,
    |raw| secret_crypto::decrypt_secret(app, Some(raw.into())).map(|_| ()),
    |raw| secret_crypto::encrypt_secret(app, secret_crypto::decrypt_secret(app, Some(raw))?),
    |configs| write_all(app, configs),
    || secret_crypto::remove_legacy_key(app),
  )?;
  Ok(configs)
}

/// Verify existing v2 ciphertext before creating any key for legacy migration.
/// An inaccessible/missing system key must never produce a store with mixed keys.
fn migrate_and_commit(
  configs: &mut [SshConfigInternal],
  mut validate_current: impl FnMut(&str) -> Result<(), String>,
  migrate: impl FnMut(String) -> Result<Option<String>, String>,
  persist: impl FnOnce(&[SshConfigInternal]) -> Result<(), String>,
  cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
  for config in configs.iter() {
    for raw in [config.password.as_deref(), config.passphrase.as_deref()]
      .into_iter()
      .flatten()
    {
      if secret_crypto::is_current_secret(raw) {
        validate_current(raw)?;
      }
    }
  }
  if migrate_secrets(configs, migrate)? {
    persist(configs)?;
  }
  cleanup()
}

fn migrate_secrets(
  configs: &mut [SshConfigInternal],
  mut migrate: impl FnMut(String) -> Result<Option<String>, String>,
) -> Result<bool, String> {
  let mut changed = false;
  for config in configs {
    for secret in [&mut config.password, &mut config.passphrase] {
      if let Some(raw) = secret
        .as_ref()
        .filter(|raw| !secret_crypto::is_current_secret(raw))
      {
        *secret = migrate(raw.clone())?;
        changed = true;
      }
    }
  }
  Ok(changed)
}

fn write_all(app: &AppHandle, configs: &[SshConfigInternal]) -> Result<(), String> {
  let path = store_path(app)?;
  let raw =
    serde_json::to_string_pretty(configs).map_err(|e| format!("序列化 SSH 配置失败: {e}"))?;
  let permissions = {
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      Some(fs::Permissions::from_mode(0o600))
    }
    #[cfg(not(unix))]
    {
      None
    }
  };
  crate::atomic_file::replace_from_reader_with_metadata(
    &path,
    &mut raw.as_bytes(),
    permissions,
    None,
    &mut |_| {},
  )?;
  secret_crypto::set_private_permissions(&path, false)?;
  Ok(())
}

fn to_public(config: &SshConfigInternal) -> SshConfig {
  SshConfig {
    id: config.id.clone(),
    label: config.label.clone(),
    host: config.host.clone(),
    port: config.port,
    username: config.username.clone(),
    auth_type: config.auth_type.clone(),
    default_path: config.default_path.clone(),
  }
}

pub fn list_configs(app: &AppHandle) -> Result<Vec<SshConfig>, String> {
  let _guard = STORE_LOCK.lock();
  Ok(read_all(app)?.iter().map(to_public).collect())
}

pub fn get_internal(app: &AppHandle, id: &str) -> Result<SshConfigInternal, String> {
  let _guard = STORE_LOCK.lock();
  let config = read_all(app)?
    .into_iter()
    .find(|c| c.id == id)
    .ok_or_else(|| "SSH 配置未找到".to_string())?;
  Ok(SshConfigInternal {
    password: secret_crypto::decrypt_secret(app, config.password)?,
    passphrase: secret_crypto::decrypt_secret(app, config.passphrase)?,
    ..config
  })
}

pub fn save_config(app: &AppHandle, input: SshConfigInput) -> Result<SshConfig, String> {
  let _guard = STORE_LOCK.lock();
  let mut configs = read_all(app)?;
  let id = input.id.unwrap_or_else(|| Uuid::new_v4().to_string());
  let host = input.host.trim().to_string();
  if host.is_empty() {
    return Err("主机不能为空".into());
  }
  let label = {
    let trimmed = input.label.trim();
    if trimmed.is_empty() {
      host.clone()
    } else {
      trimmed.to_string()
    }
  };
  let username = validated_username(&input.username)?;

  let existing = configs.iter().find(|c| c.id == id);
  let password = if input.password.is_some() {
    secret_crypto::encrypt_secret(app, input.password)?
  } else {
    existing.and_then(|c| c.password.clone())
  };
  let private_key_path = input
    .private_key_path
    .or_else(|| existing.and_then(|c| c.private_key_path.clone()));
  let passphrase = if input.passphrase.is_some() {
    secret_crypto::encrypt_secret(app, input.passphrase)?
  } else {
    existing.and_then(|c| c.passphrase.clone())
  };

  let record = SshConfigInternal {
    id: id.clone(),
    label,
    host,
    port: if input.port == 0 { 22 } else { input.port },
    username,
    auth_type: input.auth_type,
    default_path: input.default_path,
    password,
    private_key_path,
    passphrase,
  };

  if let Some(idx) = configs.iter().position(|c| c.id == id) {
    configs[idx] = record.clone();
  } else {
    configs.push(record.clone());
  }
  write_all(app, &configs)?;
  Ok(to_public(&record))
}

pub fn delete_config(app: &AppHandle, id: &str) -> Result<(), String> {
  let _guard = STORE_LOCK.lock();
  let mut configs = read_all(app)?;
  configs.retain(|c| c.id != id);
  write_all(app, &configs)
}

fn validated_username(username: &str) -> Result<String, String> {
  let username = username.trim();
  if username.is_empty() {
    return Err("用户名不能为空".into());
  }
  Ok(username.into())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_username_never_silently_selects_root() {
    assert!(validated_username(" \t").is_err());
    assert_eq!(validated_username(" root ").unwrap(), "root");
  }

  fn sample_config(secret: &str) -> SshConfigInternal {
    serde_json::from_value(
      serde_json::json!({ "id":"one", "label":"one", "host":"localhost", "port":22,
      "username":"user", "authType":"password", "password":secret }),
    )
    .unwrap()
  }

  #[test]
  fn inaccessible_current_key_prevents_migration_persistence_and_key_cleanup() {
    let mut configs = vec![sample_config("old-plain"), sample_config("enc:v2:existing")];
    let error = migrate_and_commit(
      &mut configs,
      |_| Err("system key unavailable".into()),
      |_| panic!("must not generate replacement key"),
      |_| panic!("must preserve original config"),
      || panic!("must preserve legacy key"),
    )
    .unwrap_err();
    assert_eq!(error, "system key unavailable");
    assert_eq!(configs[0].password.as_deref(), Some("old-plain"));
  }

  #[test]
  fn failed_migration_or_persistence_never_removes_legacy_key() {
    let mut configs = vec![sample_config("enc:v1:old")];
    assert!(migrate_and_commit(
      &mut configs,
      |_| Ok(()),
      |_| Err("legacy decrypt failure".into()),
      |_| panic!("must not persist failed migration"),
      || panic!("must preserve legacy key")
    )
    .is_err());
    assert!(migrate_and_commit(
      &mut configs,
      |_| Ok(()),
      |_| Ok(Some("enc:v2:converted".into())),
      |_| Err("config write failure".into()),
      || panic!("must preserve legacy key until durable save")
    )
    .is_err());
  }

  #[test]
  fn reads_migrate_plaintext_and_v1_secrets_together() {
    let mut configs: Vec<SshConfigInternal> = serde_json::from_value(serde_json::json!([{
      "id":"one", "label":"one", "host":"localhost", "port":22,
      "username":"user", "authType":"password", "password":"old-plain",
      "passphrase":"enc:v1:legacy"
    }]))
    .unwrap();
    let mut seen = Vec::new();
    assert!(migrate_secrets(&mut configs, |raw| {
      seen.push(raw);
      Ok(Some("enc:v2:migrated".into()))
    })
    .unwrap());
    assert_eq!(seen, ["old-plain", "enc:v1:legacy"]);
    assert!(!migrate_secrets(&mut configs, |_| panic!("already migrated")).unwrap());
    let public = serde_json::to_value(to_public(&configs[0])).unwrap();
    assert!(public.get("password").is_none());
    assert!(public.get("passphrase").is_none());
  }
}

pub fn label_for(app: &AppHandle, config_id: &str) -> Option<String> {
  list_configs(app).ok().and_then(|configs| {
    configs
      .into_iter()
      .find(|c| c.id == config_id)
      .map(|c| c.label)
  })
}
