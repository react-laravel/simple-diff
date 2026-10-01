use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
use windows_sys::Win32::Security::Authorization::{
  BuildTrusteeWithSidW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W, SET_ACCESS,
  SE_FILE_OBJECT,
};
use windows_sys::Win32::Security::{
  GetTokenInformation, TokenUser, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION,
  OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

/// Replace the DACL with current-user full control, and remove inherited access.
pub fn set_private_permissions(path: &Path, directory: bool) -> Result<(), String> {
  let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
  let last_error = || format!("收紧数据权限失败: {}", std::io::Error::last_os_error());
  // All pointers below remain live until the OS calls complete. The token and
  // OS-allocated ACL are released on both success and error paths.
  unsafe {
    let mut token = null_mut();
    if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
      return Err(last_error());
    }
    let result = (|| {
      let mut required = 0;
      GetTokenInformation(token, TokenUser, null_mut(), 0, &mut required);
      if required == 0 {
        return Err(last_error());
      }
      // usize ensures TOKEN_USER alignment; the trailing SID occupies the same buffer.
      let words =
        (required as usize + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
      let mut buffer = vec![0usize; words];
      if GetTokenInformation(
        token,
        TokenUser,
        buffer.as_mut_ptr().cast(),
        required,
        &mut required,
      ) == 0
      {
        return Err(last_error());
      }
      let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
      let mut access = EXPLICIT_ACCESS_W::default();
      access.grfAccessPermissions = 0x001f01ff; // FILE_ALL_ACCESS
      access.grfAccessMode = SET_ACCESS;
      access.grfInheritance = if directory {
        OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
      } else {
        0
      };
      BuildTrusteeWithSidW(&mut access.Trustee, user.User.Sid);
      let mut acl = null_mut();
      let status = SetEntriesInAclW(1, &access, null(), &mut acl);
      if status != 0 {
        return Err(format!("创建私有 ACL 失败: {status}"));
      }
      let status = SetNamedSecurityInfoW(
        name.as_ptr(),
        SE_FILE_OBJECT,
        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
        null_mut(),
        null_mut(),
        acl,
        null(),
      );
      LocalFree(acl.cast());
      if status != 0 {
        return Err(format!("收紧数据 ACL 失败: {status}"));
      }
      Ok(())
    })();
    CloseHandle(token);
    result
  }
}
