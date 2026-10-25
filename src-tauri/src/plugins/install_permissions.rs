//! Windows 插件目录的一次性 UAC 准备；提升进程不启动 Tauri，也不加载插件。
//!
//! CLI 仅接收请求进程的 PID 和创建时间。目标永远由当前 EXE 推导，用户 SID
//! 从仍存活且 EXE 一致的原进程令牌读取，不能由 Renderer 或命令行指定。

use std::ffi::OsString;

const HELPER_FLAG: &str = "--prepare-plugin-directory";
pub(crate) const DIRECTORY_NAME: &str = "Plugin";
pub(crate) const STAGING_DIRECTORY_NAME: &str = "Plugin.installing";
pub(crate) const PREPARED_MARKER: &str = ".permissions-prepared";
pub(crate) const PREPARED_MARKER_CONTENT: &[u8] = b"AI_CANVAS_PLUGIN_DIRECTORY_V1\n";

fn helper_request(args: &[OsString]) -> Result<(u32, u64), ()> {
    if args.len() != 4 {
        return Err(());
    }
    let pid = args[2].to_str().ok_or(())?.parse::<u32>().map_err(|_| ())?;
    let created = args[3].to_str().ok_or(())?.parse::<u64>().map_err(|_| ())?;
    if pid == 0 || created == 0 {
        return Err(());
    }
    Ok((pid, created))
}

/// 必须在主应用或任何 Worker 初始化之前调用；参数包含 argv[0]。
pub fn dispatch_helper(args: &[OsString]) -> Option<i32> {
    if args.get(1).and_then(|arg| arg.to_str()) != Some(HELPER_FLAG) {
        return None;
    }
    let Ok((pid, created)) = helper_request(args) else {
        return Some(2);
    };
    #[cfg(windows)]
    {
        Some(windows_setup::dispatch(pid, created))
    }
    #[cfg(not(windows))]
    {
        let _ = (pid, created);
        Some(3)
    }
}

/// 仅供用户显式选择安装、更新或重新启用插件的受信原生流程调用。
pub(crate) fn request_directory_access() -> Result<(), String> {
    #[cfg(windows)]
    {
        windows_setup::request()
    }
    #[cfg(not(windows))]
    {
        Err("当前平台不支持 Windows 插件目录授权".into())
    }
}

#[cfg(windows)]
mod windows_setup {
    use super::{DIRECTORY_NAME, HELPER_FLAG, PREPARED_MARKER, PREPARED_MARKER_CONTENT, STAGING_DIRECTORY_NAME};
    use std::{
        ffi::{c_void, OsStr},
        fs::{self, OpenOptions},
        io::Write,
        mem::{offset_of, size_of},
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::{Path, PathBuf},
        ptr,
        sync::Mutex,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };
    use windows::{
        core::{Error as WinError, PCWSTR, PWSTR},
        Win32::{
            Foundation::{
                ERROR_ACCESS_DENIED, ERROR_NOT_ALL_ASSIGNED, ERROR_SUCCESS, FILETIME, GetLastError,
                HANDLE, HLOCAL, LUID, LocalFree, RPC_E_CHANGED_MODE, SetLastError, WAIT_OBJECT_0,
                WAIT_TIMEOUT,
            },
            Security::{
                Authorization::{
                    EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, NO_MULTIPLE_TRUSTEE,
                    SE_FILE_OBJECT, SetEntriesInAclW, TRUSTEE_IS_SID, TRUSTEE_IS_USER, TRUSTEE_W,
                },
                ACL, AdjustTokenPrivileges, DACL_SECURITY_INFORMATION, GetSecurityDescriptorControl,
                GetTokenInformation, InitializeSecurityDescriptor, IsValidSid, LookupPrivilegeValueW,
                LUID_AND_ATTRIBUTES, PSECURITY_DESCRIPTOR, PSID, SECURITY_DESCRIPTOR,
                SE_DACL_AUTO_INHERITED, SE_DACL_AUTO_INHERIT_REQ, SE_DACL_PROTECTED,
                SE_PRIVILEGE_ENABLED, SetFileSecurityW, SetSecurityDescriptorControl,
                SetSecurityDescriptorDacl, SUB_CONTAINERS_AND_OBJECTS_INHERIT, TOKEN_ELEVATION,
                TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER, TokenElevation,
                TokenUser,
            },
            Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY,
                FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ,
                FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_READ,
                FILE_SHARE_WRITE, FILE_TYPE_DISK, FileRenameInfo, GetFileInformationByHandle,
                GetFileType, OPEN_EXISTING, READ_CONTROL, SetFileInformationByHandle, WRITE_DAC,
            },
            System::{
                Com::{
                    COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoUninitialize,
                },
                Threading::{
                    GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
                    OpenProcessToken, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
                    PROCESS_SYNCHRONIZE, QueryFullProcessImageNameW, WaitForSingleObject,
                },
            },
            UI::Shell::{
                SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
                ShellExecuteExW,
            },
        },
    };

    const MAX_TREE_DEPTH: usize = 32;
    const MAX_TREE_ENTRIES: usize = 16_384;
    const MAX_INSTALLATION_DEPTH: usize = 128;
    const SETUP_DEADLINE: Duration = Duration::from_secs(90);
    const HELPER_WAIT_MS: u32 = 120_000;
    // 超时后仍保留进程句柄；再次点击不得叠加另一个提升操作。
    static IN_FLIGHT_SETUP: Mutex<Option<OwnedHandle>> = Mutex::new(None);

    #[derive(Debug)]
    enum SetupError {
        Request,
        UnsafePath,
        Limit,
        Windows(&'static str, u32),
    }

    impl SetupError {
        fn win(operation: &'static str, error: WinError) -> Self {
            Self::Windows(operation, error.code().0 as u32)
        }

        fn io(operation: &'static str, error: std::io::Error) -> Self {
            Self::Windows(operation, error.raw_os_error().unwrap_or(0) as u32)
        }

        fn exit_code(&self) -> i32 {
            match self {
                Self::Request => 3,
                Self::UnsafePath => 4,
                Self::Windows(_, 0) => 5,
                Self::Windows(_, code) => (0x1_0000 | (code & 0xFFFF)) as i32,
                Self::Limit => 6,
            }
        }

        fn message(&self) -> String {
            match self {
                Self::Request => "目录授权请求身份校验失败，未执行权限修改".into(),
                Self::UnsafePath => "插件目录含链接、硬链接或异常文件，未继续修改权限".into(),
                Self::Limit => "插件目录权限准备超时或超过深度、文件数量限制".into(),
                Self::Windows(operation, code) => format!("{operation}失败（系统错误码 0x{code:08X}）"),
            }
        }

        fn access_denied(&self) -> bool {
            matches!(self, Self::Windows(_, code)
                if *code == ERROR_ACCESS_DENIED.0 || *code == 0x8007_0005)
        }
    }

    struct LocalAllocation(*mut c_void);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { LocalFree(HLOCAL(self.0)) };
            }
        }
    }

    struct ComScope(bool);

    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn wide(value: &OsStr) -> Result<Vec<u16>, SetupError> {
        let mut result: Vec<u16> = value.encode_wide().collect();
        if result.contains(&0) {
            return Err(SetupError::UnsafePath);
        }
        result.push(0);
        Ok(result)
    }

    fn handle(value: &OwnedHandle) -> HANDLE {
        HANDLE(value.as_raw_handle())
    }

    fn own(value: HANDLE) -> OwnedHandle {
        // 只接收 Win32 成功返回的真实句柄，不能传入 GetCurrentProcess 伪句柄。
        unsafe { OwnedHandle::from_raw_handle(value.0) }
    }

    fn creation_time(process: HANDLE) -> Result<u64, SetupError> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        unsafe { GetProcessTimes(process, &mut created, &mut exited, &mut kernel, &mut user) }
            .map_err(|error| SetupError::win("读取请求进程创建时间", error))?;
        Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn process_token(process: HANDLE) -> Result<OwnedHandle, SetupError> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .map_err(|error| SetupError::win("读取请求用户令牌", error))?;
        Ok(own(token))
    }

    /// 仅在跨账户查询被拒绝后临时启用；不改变任何目标进程或其令牌的权限。
    struct DebugPrivilegeGuard {
        token: OwnedHandle,
        previous: TOKEN_PRIVILEGES,
        restore_needed: bool,
    }

    impl DebugPrivilegeGuard {
        fn enable() -> Result<Self, SetupError> {
            let mut token = HANDLE::default();
            unsafe {
                OpenProcessToken(
                    GetCurrentProcess(), TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES, &mut token,
                )
            }
            .map_err(|error| SetupError::win("打开临时查询权限", error))?;
            let token = own(token);
            let name = wide(OsStr::new("SeDebugPrivilege"))?;
            let mut luid = LUID::default();
            unsafe { LookupPrivilegeValueW(PCWSTR::null(), PCWSTR(name.as_ptr()), &mut luid) }
                .map_err(|error| SetupError::win("定位临时查询权限", error))?;
            let requested = TOKEN_PRIVILEGES {
                PrivilegeCount: 1,
                Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }],
            };
            let mut previous = TOKEN_PRIVILEGES::default();
            let mut returned = 0_u32;
            unsafe { SetLastError(ERROR_SUCCESS) };
            let result = unsafe {
                AdjustTokenPrivileges(
                    handle(&token), false, Some(&requested), size_of::<TOKEN_PRIVILEGES>() as u32,
                    Some(&mut previous), Some(&mut returned),
                )
            };
            let status = unsafe { GetLastError() };
            // 只请求一个 privilege，PreviousState 最多一项；零项表示原本已启用。
            let guard = Self { token, previous, restore_needed: previous.PrivilegeCount != 0 };
            result.map_err(|error| SetupError::win("启用临时查询权限", error))?;
            if status == ERROR_NOT_ALL_ASSIGNED {
                return Err(SetupError::Windows("系统未分配临时查询权限", status.0));
            }
            if status != ERROR_SUCCESS {
                return Err(SetupError::Windows("启用临时查询权限", status.0));
            }
            Ok(guard)
        }

        fn restore(&mut self) -> Result<(), SetupError> {
            if !self.restore_needed {
                return Ok(());
            }
            unsafe { SetLastError(ERROR_SUCCESS) };
            let result = unsafe {
                AdjustTokenPrivileges(handle(&self.token), false, Some(&self.previous), 0, None, None)
            };
            let status = unsafe { GetLastError() };
            result.map_err(|error| SetupError::win("恢复原进程查询权限", error))?;
            if status == ERROR_NOT_ALL_ASSIGNED {
                return Err(SetupError::Windows("无法恢复已移除的查询权限", status.0));
            }
            if status != ERROR_SUCCESS {
                return Err(SetupError::Windows("恢复原进程查询权限", status.0));
            }
            self.restore_needed = false;
            Ok(())
        }
    }

    impl Drop for DebugPrivilegeGuard {
        fn drop(&mut self) {
            // 正常成功路径显式恢复；任何查询错误退出时也精确恢复捕获的原状态。
            // 若恢复本身失败，requester 不会返回成功，helper 随后退出，不进入文件操作。
            let _ = self.restore();
        }
    }

    fn query_with_debug_retry<T>(
        privilege: &mut Option<DebugPrivilegeGuard>,
        mut query: impl FnMut() -> Result<T, SetupError>,
    ) -> Result<T, SetupError> {
        match query() {
            Err(error) if error.access_denied() && privilege.is_none() => {
                *privilege = Some(DebugPrivilegeGuard::enable()?);
                query()
            }
            result => result,
        }
    }

    fn elevated() -> Result<bool, SetupError> {
        let token = process_token(unsafe { GetCurrentProcess() })?;
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0;
        unsafe {
            GetTokenInformation(
                handle(&token),
                TokenElevation,
                Some((&mut elevation as *mut TOKEN_ELEVATION).cast()),
                size_of::<TOKEN_ELEVATION>() as u32,
                &mut returned,
            )
        }
        .map_err(|error| SetupError::win("核对管理员授权", error))?;
        Ok(returned as usize == size_of::<TOKEN_ELEVATION>() && elevation.TokenIsElevated != 0)
    }

    struct Requester {
        process: OwnedHandle,
        // usize 保证 TOKEN_USER 与其内嵌 SID 的对齐和整个 ACL 操作期间的存活。
        user_information: Vec<usize>,
    }

    impl Requester {
        fn sid(&self) -> PSID {
            unsafe { (*(self.user_information.as_ptr().cast::<TOKEN_USER>())).User.Sid }
        }

        fn ensure_alive(&self) -> Result<(), SetupError> {
            if unsafe { WaitForSingleObject(handle(&self.process), 0) } != WAIT_TIMEOUT {
                return Err(SetupError::Request);
            }
            Ok(())
        }
    }

    fn requester(pid: u32, created: u64, executable: &Path) -> Result<Requester, SetupError> {
        if pid == std::process::id() {
            return Err(SetupError::Request);
        }
        let mut debug_privilege = None;
        let process = own(query_with_debug_retry(&mut debug_privilege, || {
            unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, false, pid) }
                .map_err(|error| SetupError::win("打开原请求进程", error))
        })?);
        if creation_time(handle(&process))? != created {
            return Err(SetupError::Request);
        }
        let mut image = vec![0_u16; 32_768];
        let mut length = image.len() as u32;
        unsafe {
            QueryFullProcessImageNameW(
                handle(&process), PROCESS_NAME_WIN32, PWSTR(image.as_mut_ptr()), &mut length,
            )
        }
        .map_err(|error| SetupError::win("核对原请求应用", error))?;
        image.truncate(length as usize);
        let token = query_with_debug_retry(&mut debug_privilege, || process_token(handle(&process)))?;
        let mut bytes = 0_u32;
        let _ = unsafe { GetTokenInformation(handle(&token), TokenUser, None, 0, &mut bytes) };
        if bytes < size_of::<TOKEN_USER>() as u32 || bytes > 4096 {
            return Err(SetupError::Request);
        }
        let word_count = (bytes as usize).div_ceil(size_of::<usize>());
        let mut user_information = vec![0_usize; word_count];
        unsafe {
            GetTokenInformation(
                handle(&token), TokenUser, Some(user_information.as_mut_ptr().cast()),
                (user_information.len() * size_of::<usize>()) as u32, &mut bytes,
            )
        }
        .map_err(|error| SetupError::win("读取原请求用户身份", error))?;
        if let Some(mut privilege) = debug_privilege.take() {
            // 跨账户查询结束：先恢复原权限，再解析文件路径或进行任何文件/ACL操作。
            privilege.restore()?;
        }
        let parent_executable = fs::canonicalize(PathBuf::from(std::ffi::OsString::from_wide(&image)))
            .map_err(|error| SetupError::io("解析原请求应用", error))?;
        fn ascii_case_unit(unit: u16) -> u16 {
            if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) { unit + 32 } else { unit }
        }
        // 保留原始 UTF-16；不能让不同的非配对单元经 lossy 解码折叠为同一路径。
        if !parent_executable.as_os_str().encode_wide().map(ascii_case_unit)
            .eq(executable.as_os_str().encode_wide().map(ascii_case_unit))
        {
            return Err(SetupError::Request);
        }
        let requester = Requester { process, user_information };
        if !unsafe { IsValidSid(requester.sid()) }.as_bool() {
            return Err(SetupError::Request);
        }
        requester.ensure_alive()?;
        Ok(requester)
    }

    struct PinnedEntry {
        path: PathBuf,
        file: OwnedHandle,
        directory: bool,
    }

    fn pin(path: &Path, desired_access: u32) -> Result<PinnedEntry, SetupError> {
        let name = wide(path.as_os_str())?;
        let file = own(unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()), desired_access,
                // 不共享 DELETE：当前项和已固定祖先不能在按路径设置 ACL 时被替换。
                FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, HANDLE::default(),
            )
        }
        .map_err(|error| SetupError::win("固定插件目录项", error))?);
        let mut information = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(handle(&file), &mut information) }
            .map_err(|error| SetupError::win("核对插件目录项", error))?;
        let directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
        if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
            || unsafe { GetFileType(handle(&file)) } != FILE_TYPE_DISK
            || (!directory && information.nNumberOfLinks != 1)
        {
            // 硬链接也不能授权：改其 DACL 会同时改到 Plugin 之外的同一文件。
            return Err(SetupError::UnsafePath);
        }
        Ok(PinnedEntry { path: path.to_path_buf(), file, directory })
    }

    fn pin_installation(directory: &Path, deadline: Instant) -> Result<Vec<PinnedEntry>, SetupError> {
        let mut ancestors: Vec<_> = directory.ancestors().collect();
        if ancestors.len() > MAX_INSTALLATION_DEPTH {
            return Err(SetupError::Limit);
        }
        ancestors.reverse();
        let mut pinned = Vec::with_capacity(ancestors.len());
        for ancestor in ancestors {
            check_budget(deadline)?;
            let entry = pin(ancestor, FILE_READ_ATTRIBUTES.0)?;
            if !entry.directory {
                return Err(SetupError::UnsafePath);
            }
            pinned.push(entry);
        }
        Ok(pinned)
    }

    fn check_budget(deadline: Instant) -> Result<(), SetupError> {
        if Instant::now() >= deadline {
            Err(SetupError::Limit)
        } else {
            Ok(())
        }
    }

    fn collect_tree(
        path: &Path, depth: usize, deadline: Instant, entries: &mut Vec<PinnedEntry>,
    ) -> Result<(), SetupError> {
        check_budget(deadline)?;
        if depth > MAX_TREE_DEPTH || entries.len() >= MAX_TREE_ENTRIES {
            return Err(SetupError::Limit);
        }
        let entry = pin(path, FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0)?;
        let directory = entry.directory;
        entries.push(entry);
        if directory {
            for child in fs::read_dir(path).map_err(|error| SetupError::io("读取插件目录项", error))? {
                let child = child.map_err(|error| SetupError::io("读取插件目录项", error))?;
                collect_tree(&child.path(), depth + 1, deadline, entries)?;
            }
        }
        Ok(())
    }

    fn grant_modify(entry: &PinnedEntry, sid: PSID) -> Result<(), SetupError> {
        let mut old_acl: *mut ACL = ptr::null_mut();
        let mut old_descriptor = PSECURITY_DESCRIPTOR::default();
        let status = unsafe {
            GetSecurityInfo(
                handle(&entry.file), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, None, None,
                Some(&mut old_acl), None, Some(&mut old_descriptor),
            )
        };
        let _old_descriptor = LocalAllocation(old_descriptor.0);
        if status.0 != 0 {
            return Err(SetupError::Windows("读取插件目录权限", status.0));
        }
        if old_acl.is_null() {
            // 无 DACL 已允许请求用户访问；原样保留，不把隐式权限改成另一套 ACL。
            return Ok(());
        }
        let mut old_control = 0_u16;
        let mut old_revision = 0_u32;
        unsafe { GetSecurityDescriptorControl(old_descriptor, &mut old_control, &mut old_revision) }
            .map_err(|error| SetupError::win("读取插件目录继承设置", error))?;
        let access = EXPLICIT_ACCESS_W {
            grfAccessPermissions: FILE_GENERIC_READ.0 | FILE_GENERIC_WRITE.0
                | FILE_GENERIC_EXECUTE.0 | DELETE.0,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: if entry.directory { SUB_CONTAINERS_AND_OBJECTS_INHERIT } else { Default::default() },
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(), MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_USER,
                ptstrName: PWSTR(sid.0.cast()),
            },
        };
        let mut new_acl: *mut ACL = ptr::null_mut();
        let status = unsafe { SetEntriesInAclW(Some(&[access]), Some(old_acl), &mut new_acl) };
        let _new_acl = LocalAllocation(new_acl.cast());
        if status.0 != 0 {
            return Err(SetupError::Windows("合并插件目录权限", status.0));
        }
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        let descriptor_pointer = PSECURITY_DESCRIPTOR((&mut descriptor as *mut SECURITY_DESCRIPTOR).cast());
        unsafe {
            InitializeSecurityDescriptor(descriptor_pointer, 1)
                .map_err(|error| SetupError::win("准备插件目录权限", error))?;
            SetSecurityDescriptorDacl(descriptor_pointer, true, Some(new_acl), false)
                .map_err(|error| SetupError::win("准备插件目录权限", error))?;
            let preserved = SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ;
            SetSecurityDescriptorControl(
                descriptor_pointer, preserved,
                windows::Win32::Security::SECURITY_DESCRIPTOR_CONTROL(old_control & preserved.0),
            )
            .map_err(|error| SetupError::win("保留插件目录继承设置", error))?;
        }
        let name = wide(entry.path.as_os_str())?;
        // SetNamedSecurityInfo/SetSecurityInfo 会自动传播 ACE，可能越过新出现的子项。
        // SetFileSecurityW 明确不更新现有子项；逐项 no-follow 校验后只修改这一项。
        // 当前项与所有祖先的无 DELETE 共享句柄一直存活，路径不能被换成目录联接。
        // https://learn.microsoft.com/windows/win32/api/securitybaseapi/nf-securitybaseapi-setfilesecurityw
        unsafe { SetFileSecurityW(PCWSTR(name.as_ptr()), DACL_SECURITY_INFORMATION, descriptor_pointer) }
            .ok().map_err(|error| SetupError::win("写入插件目录权限", error))
    }

    fn publish_prepared_directory(stage: &PinnedEntry, target: &Path) -> Result<(), SetupError> {
        let name: Vec<u16> = target.as_os_str().encode_wide().collect();
        let name_bytes = name.len().checked_mul(size_of::<u16>()).ok_or(SetupError::UnsafePath)?;
        let total = offset_of!(FILE_RENAME_INFO, FileName).checked_add(name_bytes)
            .ok_or(SetupError::UnsafePath)?;
        let mut storage = vec![0_usize; total.max(size_of::<FILE_RENAME_INFO>()).div_ceil(size_of::<usize>())];
        let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            // ReplaceIfExists 保持 false；目标被其他安装创建时绝不覆盖。
            (*info).RootDirectory = HANDLE::default();
            (*info).FileNameLength = name_bytes.try_into().map_err(|_| SetupError::UnsafePath)?;
            ptr::copy_nonoverlapping(name.as_ptr(), ptr::addr_of_mut!((*info).FileName).cast(), name.len());
            SetFileInformationByHandle(handle(&stage.file), FileRenameInfo, info.cast(), total as u32)
        }
        .map_err(|error| SetupError::win("发布插件目录", error))
    }

    fn prepare_new(directory: &Path, requester: &Requester, deadline: Instant) -> Result<(), SetupError> {
        let staging_root = directory.join(STAGING_DIRECTORY_NAME);
        match fs::create_dir(&staging_root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(SetupError::io("创建插件目录准备区", error)),
        }
        let staging_guard = pin(&staging_root, FILE_READ_ATTRIBUTES.0)?;
        if !staging_guard.directory {
            return Err(SetupError::UnsafePath);
        }
        check_budget(deadline)?;
        requester.ensure_alive()?;
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| SetupError::Request)?.as_nanos();
        let stage_path = staging_root.join(format!("permissions-{}-{nonce}", std::process::id()));
        // 只创建一个独占新目录；已有同名对象不重用，失败残留也不递归删除。
        fs::create_dir(&stage_path).map_err(|error| SetupError::io("创建插件授权暂存目录", error))?;
        let stage = pin(
            &stage_path, FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0 | DELETE.0,
        )?;
        if !stage.directory {
            return Err(SetupError::UnsafePath);
        }
        let marker_path = stage_path.join(PREPARED_MARKER);
        let mut marker = OpenOptions::new().write(true).create_new(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
            .share_mode(FILE_SHARE_READ.0)
            .open(&marker_path).map_err(|error| SetupError::io("创建插件准备标记", error))?;
        marker.write_all(PREPARED_MARKER_CONTENT)
            .map_err(|error| SetupError::io("写入插件准备标记", error))?;
        marker.sync_all().map_err(|error| SetupError::io("保存插件准备标记", error))?;
        drop(marker);
        let marker_guard = pin(&marker_path, FILE_READ_ATTRIBUTES.0 | READ_CONTROL.0 | WRITE_DAC.0)?;
        grant_modify(&marker_guard, requester.sid())?;
        // 不保留已打开的子文件句柄，以免 Windows 拒绝原子重命名其父目录。
        // 原进程仍须检查发布后的固定标记内容，不能单凭 helper 退出码执行插件。
        drop(marker_guard);
        grant_modify(&stage, requester.sid())?;
        requester.ensure_alive()?;
        check_budget(deadline)?;
        // 标记与新根一起出现，普通进程必须完成旧数据迁移后才可移除标记。
        publish_prepared_directory(&stage, &directory.join(DIRECTORY_NAME))?;
        // 不按旧路径做权限写入或递归清理；持有的句柄会随返回关闭。
        Ok(())
    }

    fn setup(pid: u32, created: u64) -> Result<(), SetupError> {
        let deadline = Instant::now() + SETUP_DEADLINE;
        if !elevated()? {
            return Err(SetupError::Request);
        }
        let original_executable = std::env::current_exe()
            .map_err(|error| SetupError::io("定位当前应用", error))?;
        let _executable_guard = pin(&original_executable, FILE_READ_ATTRIBUTES.0)?;
        let executable = fs::canonicalize(original_executable)
            .map_err(|error| SetupError::io("核对当前应用", error))?;
        let directory = executable.parent().ok_or(SetupError::UnsafePath)?;
        let requester = requester(pid, created, &executable)?;
        let _installation_guards = pin_installation(directory, deadline)?;
        let target = directory.join(DIRECTORY_NAME);
        match fs::symlink_metadata(&target) {
            Ok(_) => {
                let mut entries = Vec::new();
                // 先固定并校验整棵树，发现链接或超限时尚未修改任何 ACL。
                collect_tree(&target, 0, deadline, &mut entries)?;
                if !entries.first().is_some_and(|entry| entry.directory) {
                    return Err(SetupError::UnsafePath);
                }
                for entry in &entries {
                    requester.ensure_alive()?;
                    check_budget(deadline)?;
                    grant_modify(entry, requester.sid())?;
                }
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                prepare_new(directory, &requester, deadline)
            }
            Err(error) => Err(SetupError::io("检查插件目录", error)),
        }
    }

    pub(super) fn dispatch(pid: u32, created: u64) -> i32 {
        match setup(pid, created) {
            Ok(()) => 0,
            Err(error) => {
                // 只包含固定阶段与错误码，不输出本机目录、用户 SID 或文件正文。
                eprintln!("[plugin-permissions] {}", error.message());
                error.exit_code()
            }
        }
    }

    fn exit_result(code: u32) -> Result<(), String> {
        if code & 0xFFFF_0000 == 0x1_0000 {
            return Err(format!(
                "无法准备插件目录权限（Windows 错误码 {}），请检查安全策略或目录权限后重试",
                code & 0xFFFF,
            ));
        }
        match code {
            0 => Ok(()),
            2 | 3 => Err("插件目录授权身份校验失败，请关闭并重新打开应用后重试".into()),
            4 => Err("插件目录包含链接、硬链接或异常文件，未继续授权；请检查该目录".into()),
            6 => Err("插件目录权限准备超时或超过深度、文件数量限制，未继续安装".into()),
            _ => Err("无法准备插件目录权限，请检查 Windows 安全策略或目录权限后重试".into()),
        }
    }

    pub(super) fn request() -> Result<(), String> {
        let mut in_flight = IN_FLIGHT_SETUP.try_lock()
            .map_err(|_| "另一个插件目录授权操作仍在进行，请稍后重试".to_string())?;
        if let Some(process) = in_flight.as_ref() {
            match unsafe { WaitForSingleObject(handle(process), 0) } {
                WAIT_TIMEOUT => return Err("插件目录授权尚未结束，请稍后重试".into()),
                WAIT_OBJECT_0 => {
                    // 旧调用已经超时返回；本次用户重新预检并确认，不能复用旧退出码。
                    *in_flight = None;
                }
                _ => {
                    return Err("无法确认插件目录授权进程状态，未启动新的授权；请重新打开应用后重试".into());
                }
            }
        }
        let original_executable = std::env::current_exe()
            .map_err(|_| "无法定位当前应用".to_string())?;
        let _executable_guard = pin(&original_executable, FILE_READ_ATTRIBUTES.0)
            .map_err(|error| error.message())?;
        let executable = fs::canonicalize(original_executable)
            .map_err(|_| "无法解析当前应用".to_string())?;
        let created = creation_time(unsafe { GetCurrentProcess() }).map_err(|error| error.message())?;
        let parameters = format!("{HELPER_FLAG} {} {created}", std::process::id());
        let verb = wide(OsStr::new("runas")).map_err(|error| error.message())?;
        let file = wide(executable.as_os_str()).map_err(|error| error.message())?;
        let parameters = wide(OsStr::new(&parameters)).map_err(|error| error.message())?;
        let directory = wide(executable.parent().ok_or("无法定位应用安装目录")?.as_os_str())
            .map_err(|error| error.message())?;

        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        if initialized.is_err() && initialized != RPC_E_CHANGED_MODE {
            return Err("无法初始化 Windows 目录授权，请重新打开应用后重试".into());
        }
        let _com = ComScope(initialized.is_ok());
        let mut execute = SHELLEXECUTEINFOW {
            cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
            fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
            lpVerb: PCWSTR(verb.as_ptr()), lpFile: PCWSTR(file.as_ptr()),
            lpParameters: PCWSTR(parameters.as_ptr()), lpDirectory: PCWSTR(directory.as_ptr()),
            nShow: 0, // SW_HIDE；helper 没有控制台或应用窗口。
            ..Default::default()
        };
        if let Err(error) = unsafe { ShellExecuteExW(&mut execute) } {
            if error.code().0 as u32 == 0x8007_04C7 {
                return Err("已取消 Windows 插件目录授权，未继续安装".into());
            }
            return Err(format!("无法启动 Windows 插件目录授权（系统错误码 0x{:08X}）", error.code().0 as u32));
        }
        if execute.hProcess.is_invalid() {
            return Err("Windows 未返回目录授权进程，未继续安装".into());
        }
        let process = own(execute.hProcess);
        match unsafe { WaitForSingleObject(handle(&process), HELPER_WAIT_MS) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                unsafe { GetExitCodeProcess(handle(&process), &mut code) }
                    .map_err(|_| "无法读取插件目录授权结果，未继续安装".to_string())?;
                exit_result(code)
            }
            WAIT_TIMEOUT => {
                *in_flight = Some(process);
                Err("插件目录授权尚未结束，未继续安装；请稍后重试".into())
            }
            _ => {
                *in_flight = Some(process);
                Err("无法确认插件目录授权状态，未继续安装；请稍后重试".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{dispatch_helper, helper_request, HELPER_FLAG};
    use std::ffi::OsString;

    #[test]
    fn helper_arguments_accept_only_nonzero_pid_and_creation_time() {
        let args = ["app", HELPER_FLAG, "123", "987"]
            .into_iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(helper_request(&args), Ok((123, 987)));
        for values in [
            vec!["app", HELPER_FLAG, "0", "987"],
            vec!["app", HELPER_FLAG, "123", "0"],
            vec!["app", HELPER_FLAG, "S-1-5-21-1", "987"],
            vec!["app", HELPER_FLAG, "123", "987", "other-directory"],
        ] {
            let args = values.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert!(helper_request(&args).is_err());
        }
    }

    #[test]
    fn ordinary_app_and_worker_arguments_do_not_enter_permission_helper() {
        for values in [vec!["app"], vec!["app", "--onnx-worker"]] {
            let args = values.into_iter().map(OsString::from).collect::<Vec<_>>();
            assert_eq!(dispatch_helper(&args), None);
        }
    }
}
