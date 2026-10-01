use std::fs;
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use tauri::{AppHandle, Manager};

const LEGACY_PREFIX: &str = "enc:v1:";
const ENC_PREFIX: &str = "enc:v2:";
const SERVICE: &str = "com.simplediff.desktop";
const ACCOUNT: &str = "ssh-master-v2";

pub fn set_private_permissions(path: &Path, directory: bool) -> Result<(), String> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
      path,
      fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )
    .map_err(|e| format!("收紧数据权限失败: {e}"))?;
  }
  #[cfg(target_os = "windows")]
  crate::private_permissions_windows::set_private_permissions(path, directory)?;
  #[cfg(not(any(unix, target_os = "windows")))]
  let _ = (path, directory);
  Ok(())
}

pub fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("无法获取应用数据目录: {e}"))?;
  fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
  set_private_permissions(&dir, true)?;
  Ok(dir)
}

fn master_key(create: bool) -> Result<[u8; 32], String> {
  // No file or in-memory fallback: unavailable/locked system stores fail closed.
  #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
  return Err("此平台未启用系统凭据库，无法保存 SSH 密码".into());
  #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
  {
    let entry =
      keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("打开系统凭据库失败: {e}"))?;
    match entry.get_secret() {
      Ok(bytes) => bytes
        .try_into()
        .map_err(|_| "系统凭据库中的主密钥损坏".into()),
      Err(keyring::Error::NoEntry) if create => {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        entry
          .set_secret(&key)
          .map_err(|e| format!("保存系统凭据失败: {e}"))?;
        Ok(key)
      }
      Err(e) => Err(format!("读取系统凭据失败: {e}")),
    }
  }
}

fn encrypt_with_key(key: &[u8; 32], plain: &str) -> Result<String, String> {
  let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化加密失败: {e}"))?;
  let mut nonce_bytes = [0u8; 12];
  rand::thread_rng().fill_bytes(&mut nonce_bytes);
  let ciphertext = cipher
    .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes())
    .map_err(|e| format!("加密失败: {e}"))?;
  let mut packed = nonce_bytes.to_vec();
  packed.extend_from_slice(&ciphertext);
  Ok(format!(
    "{ENC_PREFIX}{}",
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, packed)
  ))
}

fn decrypt_with_key(key: &[u8; 32], encoded: &str) -> Result<String, String> {
  let packed = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
    .map_err(|e| format!("解密失败: {e}"))?;
  if packed.len() < 28 {
    return Err("密文损坏".into());
  }
  let (nonce, ciphertext) = packed.split_at(12);
  let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| format!("初始化解密失败: {e}"))?;
  let plain = cipher
    .decrypt(Nonce::from_slice(nonce), ciphertext)
    .map_err(|_| "解密失败".to_string())?;
  String::from_utf8(plain).map_err(|e| format!("解密结果无效: {e}"))
}

pub fn is_current_secret(raw: &str) -> bool {
  raw.starts_with(ENC_PREFIX)
}

pub fn encrypt_secret(_app: &AppHandle, value: Option<String>) -> Result<Option<String>, String> {
  value
    .filter(|v| !v.is_empty())
    .map(|plain| encrypt_with_key(&master_key(true)?, &plain))
    .transpose()
}

pub fn decrypt_secret(app: &AppHandle, value: Option<String>) -> Result<Option<String>, String> {
  let Some(raw) = value.filter(|v| !v.is_empty()) else {
    return Ok(None);
  };
  if let Some(encoded) = raw.strip_prefix(ENC_PREFIX) {
    return decrypt_with_key(&master_key(false)?, encoded).map(Some);
  }
  if let Some(encoded) = raw.strip_prefix(LEGACY_PREFIX) {
    // Only read the old key for migration; never replace a missing legacy key.
    let path = app_data_dir(app)?.join("master.key");
    set_private_permissions(&path, false)?;
    let key: [u8; 32] = fs::read(path)
      .map_err(|e| format!("读取旧主密钥失败: {e}"))?
      .try_into()
      .map_err(|_| "旧主密钥损坏".to_string())?;
    return decrypt_with_key(&key, encoded).map(Some);
  }
  Ok(Some(raw))
}

pub fn remove_legacy_key(app: &AppHandle) -> Result<(), String> {
  match fs::remove_file(app_data_dir(app)?.join("master.key")) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("删除旧主密钥失败: {e}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[cfg(unix)]
  #[test]
  fn private_permission_modes_and_failures_are_enforced() {
    use std::os::unix::fs::PermissionsExt;
    let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
    fs::create_dir(&directory).unwrap();
    let path = directory.join("test-data");
    fs::write(&path, "test").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o666)).unwrap();
    set_private_permissions(&path, false).unwrap();
    set_private_permissions(&directory, true).unwrap();
    assert_eq!(
      fs::metadata(&path).unwrap().permissions().mode() & 0o777,
      0o600
    );
    assert_eq!(
      fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
      0o700
    );
    assert!(set_private_permissions(&directory.join("missing"), false).is_err());
    fs::remove_dir_all(directory).unwrap();
  }

  #[test]
  fn authenticated_roundtrip_and_tamper_rejection() {
    let key = [7; 32];
    let encrypted = encrypt_with_key(&key, "密码🔑").unwrap();
    assert_eq!(
      decrypt_with_key(&key, encrypted.strip_prefix(ENC_PREFIX).unwrap()).unwrap(),
      "密码🔑"
    );
    assert!(decrypt_with_key(&[8; 32], encrypted.strip_prefix(ENC_PREFIX).unwrap()).is_err());
    assert!(decrypt_with_key(&key, "AQID").is_err());
  }

  #[test]
  fn user_password_resembling_ciphertext_is_still_encrypted() {
    let plain = "enc:v2:not-actually-ciphertext";
    let encrypted = encrypt_with_key(&[3; 32], plain).unwrap();
    assert_ne!(encrypted, plain);
    assert_eq!(
      decrypt_with_key(&[3; 32], &encrypted[ENC_PREFIX.len()..]).unwrap(),
      plain
    );
  }
}
