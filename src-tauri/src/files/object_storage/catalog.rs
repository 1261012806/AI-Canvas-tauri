//! A fixed, non-secret catalog. Mutations and their revision guards share one OS lock.

use super::{normalize_connection, validate_id, ProjectBinding, StorageError};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StoredConnection {
    pub(super) connection: super::ConnectionInput,
    pub(super) revision: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Catalog {
    pub(super) revision: u64,
    pub(super) connections: Vec<StoredConnection>,
    pub(super) bindings: Vec<ProjectBinding>,
    #[serde(default)]
    owner_revisions: BTreeMap<String, u64>,
}

impl Catalog {
    pub(super) fn next_revision(&self) -> Result<u64, StorageError> {
        self.revision.checked_add(1).filter(|value| *value <= MAX_REVISION).ok_or_else(|| StorageError::new("unavailable"))
    }

    pub(super) fn connection(&self, id: &str) -> Result<&StoredConnection, StorageError> {
        self.connections.iter().find(|value| value.connection.id == id).ok_or_else(|| StorageError::new("connection_not_found"))
    }

    pub(super) fn owner_revision(&self, id: &str) -> u64 { self.owner_revisions.get(id).copied().unwrap_or(0) }

    pub(super) fn bump_owner(&mut self, id: &str) -> Result<(), StorageError> {
        let next = self.owner_revision(id).checked_add(1).filter(|value| *value <= MAX_REVISION).ok_or_else(|| StorageError::new("unavailable"))?;
        self.owner_revisions.insert(id.to_string(), next);
        Ok(())
    }

    fn validate(&self) -> Result<(), StorageError> {
        if self.revision > MAX_REVISION || self.connections.len() > 64 || self.bindings.len() > 1000 || self.owner_revisions.len() > 5000 {
            return Err(StorageError::new("unavailable"));
        }
        let mut ids = HashSet::new();
        for connection in &self.connections {
            if normalize_connection(connection.connection.clone())? != connection.connection || connection.revision.is_empty() || !ids.insert(&connection.connection.id) {
                return Err(StorageError::new("unavailable"));
            }
        }
        let mut owners = HashSet::new();
        for binding in &self.bindings {
            validate_id(&binding.owner_id)?;
            if super::normalize_owner_name(&binding.owner_name)? != binding.owner_name { return Err(StorageError::new("unavailable")); }
            let connection = self.connection(&binding.connection_id)?;
            if !owners.insert(&binding.owner_id) || self.owner_revision(&binding.owner_id) == 0 || binding.connection_revision.is_empty()
                || super::scope_for(&connection.connection, &binding.library_id, &binding.shared_project_id)?.project_prefix != binding.project_prefix
                && connection.revision == binding.connection_revision {
                return Err(StorageError::new("unavailable"));
            }
        }
        for (id, revision) in &self.owner_revisions {
            validate_id(id)?;
            if *revision == 0 || *revision > MAX_REVISION { return Err(StorageError::new("unavailable")); }
        }
        Ok(())
    }
}

fn plain(path: &Path) -> Result<(), StorageError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 { return Err(StorageError::new("unavailable")); }
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() { return Err(StorageError::new("unavailable")); }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(StorageError::new("unavailable")),
    }
}

fn location(app: &AppHandle) -> Result<PathBuf, StorageError> {
    let directory = app.path().app_data_dir().map_err(|_| StorageError::new("unavailable"))?;
    std::fs::create_dir_all(&directory).map_err(|_| StorageError::new("unavailable"))?;
    Ok(directory.join("project-asset-storage.json"))
}

fn read(path: &Path) -> Result<Catalog, StorageError> {
    plain(path)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Catalog::default()),
        Err(_) => return Err(StorageError::new("unavailable")),
    };
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| StorageError::new("unavailable"))?;
    if bytes.len() as u64 > MAX_BYTES { return Err(StorageError::new("response_too_large")); }
    let catalog: Catalog = serde_json::from_slice(&bytes).map_err(|_| StorageError::new("unavailable"))?;
    catalog.validate()?;
    Ok(catalog)
}

fn write(path: &Path, catalog: &Catalog) -> Result<(), StorageError> {
    catalog.validate()?;
    let bytes = serde_json::to_vec(catalog).map_err(|_| StorageError::new("unavailable"))?;
    if bytes.len() as u64 > MAX_BYTES { return Err(StorageError::new("response_too_large")); }
    let temporary = path.with_extension("json.tmp");
    plain(path)?;
    plain(&temporary)?;
    let mut options = OpenOptions::new(); options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let mut file = options.open(&temporary).map_err(|_| StorageError::new("unavailable"))?;
    file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| StorageError::new("unavailable"))?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|_| StorageError::new("unavailable"))?;
    OpenOptions::new().write(true).open(path).and_then(|file| file.sync_all()).map_err(|_| StorageError::new("unavailable"))?;
    #[cfg(unix)]
    if let Some(parent) = path.parent() { File::open(parent).and_then(|file| file.sync_all()).map_err(|_| StorageError::new("unavailable"))?; }
    Ok(())
}

pub(super) fn access<T>(app: &AppHandle, operation: impl FnOnce(&mut Catalog) -> Result<(T, bool), StorageError>) -> Result<T, StorageError> {
    let path = location(app)?;
    let lock_path = path.with_extension("lock");
    plain(&lock_path)?;
    let mut options = OpenOptions::new(); options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    let lock = options.open(&lock_path).map_err(|_| StorageError::new("unavailable"))?;
    let start = Instant::now();
    loop {
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => break,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => {
                if start.elapsed() >= Duration::from_secs(1) { return Err(StorageError::new("busy")); }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return Err(StorageError::new("unavailable")),
        }
    }
    let mut catalog = read(&path)?;
    let (result, changed) = operation(&mut catalog)?;
    if changed { write(&path, &catalog)?; }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_revision_detects_unbind_rebind_even_with_the_same_identity() {
        let mut catalog = Catalog::default();
        let captured = catalog.owner_revision("owner");
        catalog.bump_owner("owner").unwrap();
        catalog.bump_owner("owner").unwrap();
        assert_ne!(captured, catalog.owner_revision("owner"));
        catalog.revision = MAX_REVISION;
        assert!(catalog.next_revision().is_err());
    }
}
