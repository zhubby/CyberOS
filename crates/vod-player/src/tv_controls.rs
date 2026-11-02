use std::fs::{OpenOptions, create_dir_all, remove_file};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::VodError;

pub(crate) struct TvControlsScript {
    path: PathBuf,
}

impl TvControlsScript {
    pub(crate) fn create(state_path: &Path) -> Result<Self, VodError> {
        let directory = state_path
            .parent()
            .ok_or_else(|| VodError::internal("VOD player state directory is missing"))?;
        create_dir_all(directory)?;
        let path = directory.join(format!("tv-controls-{}.lua", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)?;
        let script = Self { path };
        file.write_all(include_bytes!("tv-controls.lua"))?;
        Ok(script)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TvControlsScript {
    fn drop(&mut self) {
        let _ = remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::TvControlsScript;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::process::Command;

    #[test]
    fn embedded_script_is_private_and_removed_with_the_player() {
        let directory = tempfile::tempdir().unwrap();
        let script = TvControlsScript::create(&directory.path().join("session.json")).unwrap();
        let path = script.path().to_owned();
        assert_eq!(path.extension().unwrap(), "lua");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(!std::fs::read(&path).unwrap().is_empty());
        drop(script);
        assert!(!path.exists());
    }

    #[test]
    fn native_controls_handle_remote_navigation_and_track_selection() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let result = match Command::new("lua")
            .arg(root.join("tests/tv_controls.lua"))
            .arg(root.join("src/tv-controls.lua"))
            .output()
        {
            Ok(result) => result,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                eprintln!("Lua is unavailable; run the native TV controls contract on CM5");
                return;
            }
            Err(error) => panic!("Could not run Lua: {error}"),
        };
        assert!(
            result.status.success(),
            "{}{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
