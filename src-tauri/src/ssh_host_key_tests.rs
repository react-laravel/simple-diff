//! Real OpenSSH: use temporary keys and loopback sockets, never user credentials.
use super::connect_session_with_known_hosts;
use crate::types::SshConfigInternal;
use std::fs;
use std::net::TcpListener;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

struct TestDir(PathBuf);
impl Drop for TestDir {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.0);
  }
}

#[test]
fn every_new_connection_checks_host_key_before_authentication() {
  let dir = TestDir(std::env::temp_dir().join(format!("simple-diff-ssh-{}", uuid::Uuid::new_v4())));
  fs::create_dir(&dir.0).unwrap();
  for key in ["trusted", "changed", "client"] {
    let mut command = Command::new("ssh-keygen");
    command.args(["-q", "-N", "", "-C", "simple-diff-test"]);
    if key == "client" {
      command.args(["-t", "rsa", "-b", "2048", "-m", "PEM"]);
    } else {
      command.args(["-t", "ed25519"]);
    }
    assert!(command
      .arg("-f")
      .arg(dir.0.join(key))
      .status()
      .unwrap()
      .success());
  }
  let listener = TcpListener::bind("127.0.0.1:0").unwrap();
  listener.set_nonblocking(true).unwrap();
  let port = listener.local_addr().unwrap().port();
  fs::write(
    dir.0.join("known_hosts"),
    format!(
      "[127.0.0.1]:{port} {}",
      fs::read_to_string(dir.0.join("trusted.pub")).unwrap()
    ),
  )
  .unwrap();
  fs::write(dir.0.join("config"), format!(
    "UsePAM no\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAuthorizedKeysFile \"{}\"\nLoginGraceTime 5\nLogLevel DEBUG1\nSubsystem sftp internal-sftp\n",
    dir.0.join("client.pub").display())).unwrap();
  let username = String::from_utf8(Command::new("id").arg("-un").output().unwrap().stdout).unwrap();
  let config: SshConfigInternal = serde_json::from_value(serde_json::json!({
    "id": "test", "label": "test", "host": "127.0.0.1", "port": port,
    "username": username.trim(), "authType": "privateKey", "privateKeyPath": dir.0.join("client"),
  }))
  .unwrap();

  // Positive authentication, key rotation, unknown host, then recovery at the same address.
  for (index, (key, known, accepted)) in [
    ("trusted", "known_hosts", true),
    ("changed", "known_hosts", false),
    ("trusted", "missing_hosts", false),
    ("trusted", "known_hosts", true),
  ]
  .into_iter()
  .enumerate()
  {
    let server = listener.try_clone().unwrap();
    let root = dir.0.clone();
    let worker = thread::spawn(move || {
      let deadline = Instant::now() + Duration::from_secs(10);
      let stream = loop {
        match server.accept() {
          Ok((stream, _)) => break stream,
          Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
          {
            thread::sleep(Duration::from_millis(10))
          }
          Err(error) => panic!("SSH test accept: {error}"),
        }
      };
      stream.set_nonblocking(false).unwrap();
      let log_path = root.join(format!("connection-{index}.log"));
      let mut child = Command::new("/usr/sbin/sshd")
        .args(["-i", "-e", "-f"])
        .arg(root.join("config"))
        .arg("-h")
        .arg(root.join(key))
        .stdin(Stdio::from(OwnedFd::from(stream.try_clone().unwrap())))
        .stdout(Stdio::from(OwnedFd::from(stream)))
        .stderr(fs::File::create(&log_path).unwrap())
        .spawn()
        .expect("OpenSSH sshd is required");
      while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
          let _ = child.kill();
          let _ = child.wait();
          panic!("SSH test timed out");
        }
        thread::sleep(Duration::from_millis(10));
      }
      fs::read_to_string(log_path).unwrap()
    });
    let result = connect_session_with_known_hosts(&config, &dir.0.join(known));
    let error = result.as_ref().err().cloned();
    let success = result
      .as_ref()
      .map(|session| session.authenticated())
      .unwrap_or(false);
    if index == 0 && success {
      let session = result.as_ref().unwrap();
      // Exercise the source boundary against a real SFTP implementation.
      let root = dir.0.join("root");
      let outside = dir.0.join("outside");
      fs::create_dir(&root).unwrap();
      fs::create_dir(&outside).unwrap();
      fs::write(outside.join("secret"), b"safe").unwrap();
      std::os::unix::fs::symlink(&outside, root.join("dir-link")).unwrap();
      std::os::unix::fs::symlink(outside.join("secret"), root.join("file-link")).unwrap();
      let root_str = root.to_str().unwrap();
      let entries = super::list_remote(session, root_str, "").unwrap();
      assert!(entries
        .iter()
        .all(|entry| entry.is_symlink && !entry.is_directory));
      assert!(super::read_remote_text(session, root_str, "file-link").is_err());
      assert!(super::read_remote_text(session, root_str, "dir-link/secret").is_err());
      assert!(super::write_remote_text(session, root_str, "dir-link/secret", "bad").is_err());
      assert!(super::delete_remote(session, root_str, "../outside", true).is_err());
      assert!(super::rename_remote(session, root_str, "../outside/secret", "bad").is_err());
      assert!(super::browse_remote(session, root_str, outside.to_str().unwrap()).is_err());
      let browse = super::browse_remote(session, root_str, root_str).unwrap();
      assert_eq!(browse.path, root.canonicalize().unwrap().to_string_lossy());
      assert_eq!(browse.root_path, browse.path);
      super::rename_remote(session, root_str, "file-link", "renamed-link").unwrap();
      super::delete_remote(session, root_str, "dir-link", true).unwrap();
      assert_eq!(fs::read(outside.join("secret")).unwrap(), b"safe");
      assert!(super::remote_metadata(session, root_str, "missing/child")
        .unwrap()
        .is_none());
      let changing_target = root.join("changing.txt");
      fs::write(&changing_target, b"original").unwrap();
      let changed = super::write_remote_stream_with_metadata_checked(
        session,
        root_str,
        "changing.txt",
        &mut b"replacement".as_slice(),
        None,
        None,
        &mut |_| {},
        &mut || {
          fs::remove_file(&changing_target).unwrap();
          std::os::unix::fs::symlink(outside.join("secret"), &changing_target).unwrap();
          Ok(())
        },
      );
      assert!(
        changed.is_err(),
        "a target replaced by a link during transfer must not be published"
      );
      assert_eq!(fs::read(outside.join("secret")).unwrap(), b"safe");
      assert!(fs::symlink_metadata(&changing_target)
        .unwrap()
        .file_type()
        .is_symlink());
      assert!(!fs::read_dir(&root).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-diff-")));
      let target = dir.0.join("transfer.bin");
      fs::write(&target, b"original").unwrap();
      let contents = vec![7u8; 2 * 1024 * 1024];
      let mut progress = 0;
      super::write_remote_stream_with_metadata(
        session,
        dir.0.to_str().unwrap(),
        "transfer.bin",
        &mut contents.as_slice(),
        Some(0o640),
        None,
        &mut |bytes| progress = bytes,
      )
      .unwrap();
      assert_eq!(progress, contents.len() as u64);
      assert_eq!(fs::read(&target).unwrap(), contents);
      struct BrokenInput;
      impl std::io::Read for BrokenInput {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
          Err(std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "test disconnect",
          ))
        }
      }
      assert!(super::write_remote_stream(
        session,
        dir.0.to_str().unwrap(),
        "transfer.bin",
        &mut BrokenInput
      )
      .is_err());
      assert_eq!(fs::read(&target).unwrap(), contents);
      assert!(!fs::read_dir(&dir.0).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with(".simple-diff-")));
    }
    drop(result);
    let log = worker.join().unwrap();
    assert_eq!(success, accepted, "{error:?}\n{log}");
    if accepted {
      assert!(log.contains("Accepted publickey"), "{log}");
    } else {
      assert!(error.unwrap().contains(if key == "changed" {
        "主机密钥不匹配"
      } else {
        "尚未信任"
      }));
      assert!(log.contains("SSH2_MSG_NEWKEYS received"), "{log}");
      assert!(
        !log.contains("userauth-request"),
        "authentication happened before trust check: {log}"
      );
    }
  }
}
